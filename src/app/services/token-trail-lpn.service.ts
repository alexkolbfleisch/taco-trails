import { inject, Injectable } from '@angular/core';
import { PlayService } from './play.service';
import { PlayValidationService } from './play-validation.service';
import { PetriNetRegionSynthesisService } from '../../../ilpn-components/src/lib/algorithms/pn/regions/petri-net-region-synthesis.service';
import { LpnGenerationDifficulty, LpnDisplayMode, TokenTrailStateService } from './token-trail-state.service';
import { SugiyamaService } from './sugiyama.service';
import { FiringEntry } from '../classes/firing-entry';
import { SerializationService } from './serialization.service';
import { PetriNet as IlpnPetriNet } from '../../../ilpn-components/src/lib/models/pn/model/petri-net';
import { JsonPetriNetParserService } from '../../../ilpn-components/src/lib/models/pn/io/parser/json-petri-net-parser.service';
import { Diagram } from '../classes/diagram/diagram';
import { Condition, Event as LabeledEvent, LabeledNetEdge, LabeledNetNode } from '../classes/labeled-net.model';
import { PanningService } from './panning.service';
import { Tab } from '../classes/tabs';
import { DIFFICULTY_CONFIGURATIONS, LpnGenerationConfiguration } from './token-trail-lpn.config';
import { LoadingService } from './loading.service';
import { ToasterNotificationService } from './toaster-notification.service';
import { TokenTrailValidatorService } from '../../../ilpn-components/src/lib/algorithms/pn/validation/token-trails/token-trail-validator.service';
import { TokenTrailValidationResult } from '../../../ilpn-components/src/lib/algorithms/pn/validation/classes/validation-result';
import { TabStateService } from './tab-state.service';
import {
    convertSourceNetToIlpn,
    convertLpnToIlpn,
    mapValidatorResultsToSolvedTrails,
    parseAndEnsureLabels,
} from '../utils/lpn-convert.util';
import { ImplicitPlaceRemoverService } from '../../../ilpn-components/src/lib/algorithms/pn/transformation/implicit-place-remover.service';
import { DuplicatePlaceRemoverService } from '../../../ilpn-components/src/lib/algorithms/pn/transformation/duplicate-place-remover.service';
import { DanglingPlaceRemoverService } from '../../../ilpn-components/src/lib/algorithms/pn/transformation/dangling-place-remover.service';
import { catchError, Observable, of, take } from 'rxjs';
import { TokenTrailGoalsService } from './token-trail-goals.service';
import { PetriNet, TokenTrailElement, TokenTrailConnection } from '../classes/token-trail.model';

@Injectable({
    providedIn: 'root',
})
export class TokenTrailLpnService {
    private playService = inject(PlayService);
    private playValidationService = inject(PlayValidationService);
    private regionSynthesisService = inject(PetriNetRegionSynthesisService);
    private implicitPlaceRemover = inject(ImplicitPlaceRemoverService);
    private duplicatePlaceRemover = inject(DuplicatePlaceRemoverService);
    private danglingPlaceRemover = inject(DanglingPlaceRemoverService);
    private stateService = inject(TokenTrailStateService);
    private sugiyamaService = inject(SugiyamaService);
    private panningService = inject(PanningService);
    private loadingService = inject(LoadingService);
    private toaster = inject(ToasterNotificationService);
    private validatorService = inject(TokenTrailValidatorService);
    private tabStateService = inject(TabStateService);
    private goalsService = inject(TokenTrailGoalsService);
    private jsonParser = inject(JsonPetriNetParserService);
    private serializationService = inject(SerializationService);
    private _lastSelectedEntriesHash = '';
    private _synthesisTimeoutId: ReturnType<typeof setTimeout> | null = null;
    private _synthesisActiveRunId = 0;

    /**
     * Synthesizes a new Labeled Petri Net (LPN) based on traces derived from the source Petri net
     * using region synthesis algorithms. Automatically adjusts parameters based on the generation difficulty.
     *
     * @param sourceNet The original Petri net diagram to synthesize the LPN from.
     * @param overrideDifficulty Optional difficulty level to override the default setting.
     * @param onFailure Optional callback when synthesis fails completely after all attempts.
     * @param force
     */
    public createLPNWithSynthesis(
        sourceNet: Diagram,
        overrideDifficulty?: LpnGenerationDifficulty,
        onFailure?: () => void,
        force = false,
    ) {
        const finalDifficulty = this.goalsService.generateGoals(
            sourceNet,
            this.getEffectiveDifficulty(overrideDifficulty),
            force,
        );

        this.stateService.setLpnGenerationDifficulty(finalDifficulty);
        this.goalsService.currentDifficulty.set(finalDifficulty);

        const config = DIFFICULTY_CONFIGURATIONS[finalDifficulty];
        const nodeCount = sourceNet.allNodes.length;
        const maxTraceLength = Math.max(3, Math.floor(nodeCount * config.traceLengthMultiplier));
        const maxTraces = Math.max(1, Math.floor(nodeCount * config.maxTracesMultiplier));
        const maxEdges = Math.max(5, Math.floor(nodeCount * config.maxEdgesMultiplier));

        this.playService.firingEntries.set([]);
        this.playValidationService.findSequences(sourceNet, 1, 300);

        const entries = this.playService.firingEntries();
        const validEntries = entries.filter(
            (entry) => entry.isValid && entry.labels.length > 0 && entry.labels.length <= maxTraceLength,
        );

        if (validEntries.length === 0) {
            if (onFailure) onFailure();
            return;
        }

        this.loadingService.show();

        // Clear existing solution cache
        this.stateService.solutionCache = null;

        const ilpnSource = convertSourceNetToIlpn(sourceNet, this.serializationService, this.jsonParser);

        const runId = ++this._synthesisActiveRunId;
        if (this._synthesisTimeoutId) {
            clearTimeout(this._synthesisTimeoutId);
        }

        this._synthesisTimeoutId = setTimeout(() => {
            if (runId !== this._synthesisActiveRunId) return;
            console.warn('LPN synthesis timed out after 15 seconds.');
            this.cleanupAndFail(onFailure, false);
        }, 15000);

        this.attemptSynthesis(sourceNet, ilpnSource, validEntries, maxTraces, maxEdges, config, 1, runId, onFailure);
    }

    private attemptSynthesis(
        sourceNet: Diagram,
        ilpnSource: IlpnPetriNet,
        validEntries: FiringEntry[],
        maxTraces: number,
        maxEdges: number,
        config: LpnGenerationConfiguration,
        attempt: number,
        runId: number,
        onFailure?: () => void,
    ) {
        this.stateService.resetCounters();
        const selectedEntries = this._selectEntriesWithVariation(validEntries, maxTraces, attempt);
        const inputNets = this.buildInputNets(selectedEntries);

        const difficulty = this.getEffectiveDifficulty();

        if (difficulty === LpnGenerationDifficulty.Easy) {
            this.synthesiseEasyMode(
                sourceNet,
                ilpnSource,
                selectedEntries,
                validEntries,
                maxTraces,
                maxEdges,
                config,
                attempt,
                runId,
                onFailure,
            );
            return;
        }

        if (difficulty === LpnGenerationDifficulty.Expert) {
            this.synthesiseExpertMode(
                sourceNet,
                ilpnSource,
                selectedEntries,
                validEntries,
                maxTraces,
                maxEdges,
                config,
                attempt,
                runId,
                onFailure,
            );
            return;
        }

        this.regionSynthesisService
            .synthesise(inputNets, config.synthesisConfig)
            .pipe(take(1))
            .subscribe({
                next: (result) => {
                    if (runId !== this._synthesisActiveRunId) return;
                    this.processSynthesisResult(
                        result.result,
                        maxEdges,
                        ilpnSource,
                        sourceNet,
                        validEntries,
                        maxTraces,
                        config,
                        attempt,
                        runId,
                        onFailure,
                    );
                },
                error: (err) => {
                    if (runId !== this._synthesisActiveRunId) return;
                    this.handleSynthesisError(err, onFailure);
                },
            });
    }

    private synthesiseEasyMode(
        sourceNet: Diagram,
        ilpnSource: IlpnPetriNet,
        selectedEntries: FiringEntry[],
        validEntries: FiringEntry[],
        maxTraces: number,
        maxEdges: number,
        config: LpnGenerationConfiguration,
        attempt: number,
        runId: number,
        onFailure?: () => void,
    ) {
        const entry =
            selectedEntries[Math.floor(Math.random() * selectedEntries.length)] ||
            validEntries[Math.floor(Math.random() * validEntries.length)];

        if (!entry) {
            this.handleSynthesisError(new Error('No valid entry found'), onFailure);
            return;
        }
        const inputNet = this.buildInputNetFromEntry(entry);
        this.processSynthesisResult(
            inputNet,
            maxEdges,
            ilpnSource,
            sourceNet,
            validEntries,
            maxTraces,
            config,
            attempt,
            runId,
            onFailure,
        );
    }

    private synthesiseExpertMode(
        sourceNet: Diagram,
        ilpnSource: IlpnPetriNet,
        selectedEntries: FiringEntry[],
        validEntries: FiringEntry[],
        maxTraces: number,
        maxEdges: number,
        config: LpnGenerationConfiguration,
        attempt: number,
        runId: number,
        onFailure?: () => void,
    ) {
        const loopLabel = this.goalsService.selectedLoopLabel;
        const repeatLabel = this.goalsService.selectedRepeatLabel;

        const expertTraces = new Set<FiringEntry>(selectedEntries);

        if (loopLabel) {
            for (let i = 0; i <= 3; i++) {
                const trace = this.findTraceWithLoopOccurrences(sourceNet, loopLabel, i);
                if (trace) {
                    expertTraces.add(trace);
                }
            }
        } else if (repeatLabel) {
            const trace = this.findTraceWithLoopOccurrences(sourceNet, repeatLabel, 2);
            if (trace) {
                expertTraces.add(trace);
            }
        }

        const combinedInputNets = this.buildInputNets(Array.from(expertTraces));

        this.regionSynthesisService
            .synthesise(combinedInputNets, config.synthesisConfig)
            .pipe(take(1))
            .subscribe({
                next: (result) => {
                    if (runId !== this._synthesisActiveRunId) return;
                    this.processSynthesisResult(
                        result.result,
                        maxEdges,
                        ilpnSource,
                        sourceNet,
                        validEntries,
                        maxTraces,
                        config,
                        attempt,
                        runId,
                        onFailure,
                    );
                },
                error: (err) => {
                    if (runId !== this._synthesisActiveRunId) return;
                    console.error('[LPN SYNTHESIS] Region synthesis service error:', err);
                    this.handleSynthesisError(err, onFailure);
                },
            });
    }

    private findTraceWithLoopOccurrences(
        sourceNet: Diagram,
        loopLabel: string,
        occurrences: number,
    ): FiringEntry | null {
        const placeIds = sourceNet.places.map((p) => p.id).sort();
        const originalMarking = { ...sourceNet.marking };

        sourceNet.resetMarking();
        const initialMarking = { ...sourceNet.marking };

        const queue: { marking: Record<string, number>; sequence: string[]; depth: number }[] = [];
        queue.push({ marking: initialMarking, sequence: [], depth: 0 });

        const visited = new Set<string>();
        const maxDepth = 50; // counts all fired transitions, including silent ones
        let resultEntry: FiringEntry | null = null;
        let fallbackEntry: FiringEntry | null = null;

        const isSink = (m: Record<string, number>) =>
            sourceNet.transitions.every((t) => {
                const flow = t.getInputFlow();
                return flow.length > 0 && flow.some(({ place, weight }) => (m[place.id] ?? 0) < weight);
            });

        while (queue.length > 0) {
            const { marking, sequence, depth } = queue.shift()!;
            const count = sequence.filter((l) => l === loopLabel).length;

            if (count === occurrences) {
                if (isSink(marking)) {
                    resultEntry = new FiringEntry(-1, sequence.join(' '), sequence.length, marking, true, true);
                    break;
                } else if (!fallbackEntry) {
                    fallbackEntry = new FiringEntry(-1, sequence.join(' '), sequence.length, marking, true, true);
                }
            }

            if (depth >= maxDepth) continue;

            for (const transition of sourceNet.transitions) {
                sourceNet.marking = { ...marking };
                if (transition.isActivated()) {
                    transition.fire(false);
                    sourceNet.updateMarking();

                    const nextMarking = { ...sourceNet.marking };
                    const nextSequence = [...sequence, transition.label || transition.id];
                    const nextCount = nextSequence.filter((l) => l === loopLabel).length;

                    if (nextCount <= occurrences) {
                        const stateKey = `${nextCount}::${placeIds.map((p) => nextMarking[p] ?? 0).join(',')}`;
                        if (!visited.has(stateKey)) {
                            visited.add(stateKey);
                            queue.push({ marking: nextMarking, sequence: nextSequence, depth: depth + 1 });
                        }
                    }
                }
            }
        }

        if (!resultEntry && fallbackEntry) {
            resultEntry = fallbackEntry;
        }

        sourceNet.marking = originalMarking;
        return resultEntry;
    }

    private validateAndApplyCandidate(
        candidate: { elements: LabeledNetNode[]; connections: LabeledNetEdge[] },
        ilpnSource: IlpnPetriNet,
        ilpnSpec: IlpnPetriNet,
        sourceNet: Diagram,
        validEntries: FiringEntry[],
        maxTraces: number,
        maxEdges: number,
        config: LpnGenerationConfiguration,
        attempt: number,
        runId: number,
        onFailure?: () => void,
    ) {
        this.validateSafe(ilpnSource, ilpnSpec)
            .pipe(take(1))
            .subscribe({
                next: (results) => {
                    if (runId !== this._synthesisActiveRunId) return;

                    const allValid =
                        results.length === ilpnSource.getPlaces().length && results.every((res) => res.valid);

                    if (!allValid) {
                        console.warn(
                            `[LPN SYNTHESIS] LPN validation failed (allValid is false). Expected: ${ilpnSource.getPlaces().length}, Got: ${results.length}. Details:`,
                            results.map((res) => ({
                                placeId: res.placeId,
                                valid: res.valid,
                            })),
                        );
                        this.handleSynthesisFailure(
                            sourceNet,
                            ilpnSource,
                            validEntries,
                            maxTraces,
                            maxEdges,
                            config,
                            attempt,
                            runId,
                            onFailure,
                        );
                        return;
                    }

                    const solvedTrailsMap = mapValidatorResultsToSolvedTrails(results);
                    this.populateCandidateTrailMarkings(candidate, solvedTrailsMap);

                    // ponytail: Prune "silent conditions" that do not correspond to any source place (empty trailMarkings)
                    const keptNodeIds = new Set<string>();
                    candidate.elements.forEach((el) => {
                        if (el instanceof Condition) {
                            if (Object.keys(el.trailMarkings).length > 0) {
                                keptNodeIds.add(el.id);
                            }
                        } else {
                            keptNodeIds.add(el.id); // always keep events
                        }
                    });

                    candidate.elements = candidate.elements.filter((el) => keptNodeIds.has(el.id));
                    candidate.connections = candidate.connections.filter(
                        (conn) => keptNodeIds.has(conn.source) && keptNodeIds.has(conn.target),
                    );

                    const input = this.buildValidationInputForCandidate(
                        sourceNet,
                        candidate.elements,
                        candidate.connections,
                    );
                    const allGoalsMet =
                        !input ||
                        this.goalsService.internalGoals.every((goal) =>
                            goal.check(input.elements, input.connections, input.petri),
                        );

                    if (!allGoalsMet) {
                        const unmet = this.goalsService.internalGoals.filter(
                            (goal) => !goal.check(input!.elements, input!.connections, input!.petri),
                        );
                        console.warn(
                            '[LPN SYNTHESIS] Goals validation failed. Unmet goals:',
                            unmet.map((g) => g.id),
                        );
                        this.handleSynthesisFailure(
                            sourceNet,
                            ilpnSource,
                            validEntries,
                            maxTraces,
                            maxEdges,
                            config,
                            attempt,
                            runId,
                            onFailure,
                        );
                        return;
                    }

                    this.applySuccessfulLpn(candidate, solvedTrailsMap, sourceNet);
                },
                error: (err) => {
                    if (runId !== this._synthesisActiveRunId) return;
                    console.error('[LPN SYNTHESIS] validateSafe returned error:', err);
                    this.handleSynthesisError(err, onFailure);
                },
            });
    }

    private validateSafe(ilpnSource: IlpnPetriNet, ilpnSpec: IlpnPetriNet): Observable<TokenTrailValidationResult[]> {
        try {
            return this.validatorService.validate(ilpnSource, ilpnSpec).pipe(
                catchError((err) => {
                    console.error('Validation error caught in validateSafe:', err);
                    return of([]);
                }),
            );
        } catch (err) {
            console.error('Validation synchronous exception caught in validateSafe:', err);
            return of([]);
        }
    }

    private buildInputNets(selectedEntries: FiringEntry[]): IlpnPetriNet[] {
        const inputNets: IlpnPetriNet[] = [];
        for (const entry of selectedEntries) {
            inputNets.push(this.buildInputNetFromEntry(entry));
        }
        return inputNets;
    }

    private buildInputNetFromEntry(entry: FiringEntry): IlpnPetriNet {
        const labelCounts = new Map<string, number>();
        for (const label of entry.labels) {
            const count = (labelCounts.get(label) || 0) + 1;
            labelCounts.set(label, count);
        }

        const currentOccurrence = new Map<string, number>();

        const places = Array.from({ length: entry.labels.length + 1 }, (_, i) => `p${i}`);
        const transitions = Array.from({ length: entry.labels.length }, (_, i) => `t${i}`);
        const arcs = Object.fromEntries(
            transitions.flatMap((t, i) => [
                [`p${i},${t}`, 1],
                [`${t},p${i + 1}`, 1],
            ]),
        );
        const labels = Object.fromEntries(
            entry.labels.map((label, i) => {
                let finalLabel = label;
                const occ = (currentOccurrence.get(label) || 0) + 1;
                currentOccurrence.set(label, occ);
                const conflict = this.goalsService.selectedConflict;
                const isConflictTrans = conflict && (label === conflict[0] || label === conflict[1]);
                const loopLabel = this.goalsService.selectedLoopLabel;
                const isLoopTrans = loopLabel && label === loopLabel && this.goalsService.isTrueLoopActive;
                const repeatLabel = this.goalsService.selectedRepeatLabel;
                const isRepeatTarget = repeatLabel && label === repeatLabel;

                if ((!isConflictTrans || isRepeatTarget) && !isLoopTrans) {
                    finalLabel = `${label}_instance${occ}`;
                }
                return [`t${i}`, finalLabel];
            }),
        );

        return parseAndEnsureLabels(
            JSON.stringify({
                places,
                transitions,
                arcs,
                marking: { p0: 1 },
                labels,
            }),
            this.jsonParser,
        );
    }

    private buildAndPrepareCandidate(
        result: IlpnPetriNet,
        maxEdges: number,
    ): { elements: LabeledNetNode[]; connections: LabeledNetEdge[] } {
        return this.buildCandidateLpn(result, maxEdges);
    }

    private populateCandidateTrailMarkings(
        candidate: { elements: LabeledNetNode[]; connections: LabeledNetEdge[] },
        solvedTrailsMap: Map<string, Record<string, number>>,
    ) {
        // Always populate candidate trail markings for the validation check and display
        for (const el of candidate.elements) {
            if (el instanceof Condition) {
                el.trailMarkings = {};
                for (const [petriPlaceId, markings] of solvedTrailsMap.entries()) {
                    const tokens = markings[el.id] ?? 0;
                    if (tokens > 0) {
                        el.trailMarkings[petriPlaceId] = tokens;
                    }
                }
                el.updateDynamicLabel();
            }
        }
    }

    private applySuccessfulLpn(
        candidate: { elements: LabeledNetNode[]; connections: LabeledNetEdge[] },
        solvedTrailsMap: Map<string, Record<string, number>>,
        sourceNet: Diagram,
    ) {
        // Clear timeout
        this.clearSynthesisTimeout();

        // Valid and goals satisfied! Render it visually by updating the state service
        this.stateService.clear(false);
        for (const el of candidate.elements) {
            this.stateService.addDrawnElement(el);
        }
        for (const conn of candidate.connections) {
            this.stateService.addConnection(conn);
        }

        this.sugiyamaService.calculateLayout(this.stateService.drawnElements(), this.stateService.connections());
        this.stateService.updateDrawnElements((e) => [...e]);
        this.stateService.updateConnections((c) => [...c]);
        this.stateService.requestFitView();

        // Cache the solution
        this.stateService.solutionCache = solvedTrailsMap;
        this.stateService.lastSynthesizedNetSignature = Diagram.getSignature(sourceNet);
        if (this.stateService.displayMode() === LpnDisplayMode.Construction) {
            this.stateService.cachedConstructionSolutionElements = this.stateService.cloneDrawnElements(
                this.stateService.drawnElements(),
            );
            this.stateService.cachedConstructionSolutionConnections = this.stateService.cloneConnections(
                this.stateService.connections(),
            );
            this.stateService.setSolvedTokenTrails(solvedTrailsMap);
            this.stateService.setShowingSolution(true);
            this.toaster.showSuccess('TOKEN_TRAIL.SOLUTION_FOUND_TITLE', 'TOKEN_TRAIL.SOLUTION_FOUND_BODY');
        } else if (this.stateService.displayMode() === LpnDisplayMode.Puzzle) {
            // In puzzle mode the user fills in trail markings themselves.
            // Clear all trailMarkings so conditions show their base name (e.g. 'c1')
            // and appear blank on the canvas — solution is stored in the cache only.
            for (const el of this.stateService.drawnElements()) {
                if (el instanceof Condition) {
                    el.trailMarkings = {};
                    el.updateDynamicLabel();
                }
            }
            this.stateService.updateDrawnElements((e) => [...e]);
        }
        this.loadingService.hide();
    }

    private handleSynthesisFailure(
        sourceNet: Diagram,
        ilpnSource: IlpnPetriNet,
        validEntries: FiringEntry[],
        maxTraces: number,
        maxEdges: number,
        config: LpnGenerationConfiguration,
        attempt: number,
        runId: number,
        onFailure?: () => void,
    ) {
        // Invalid LPN check failed or goals not met, retry if under max retries limit
        const maxRetries = this.stateService.displayMode() === LpnDisplayMode.Construction ? 50 : 15;
        if (attempt < maxRetries) {
            console.warn(
                `Generated LPN not valid for all source places or goals not met. Retrying synthesis attempt ${attempt + 1}...`,
            );
            this.attemptSynthesis(
                sourceNet,
                ilpnSource,
                validEntries,
                maxTraces,
                maxEdges,
                config,
                attempt + 1,
                runId,
                onFailure,
            );
        } else {
            this.cleanupAndFail(onFailure, false);
        }
    }

    private handleSynthesisError(err: unknown, onFailure?: () => void) {
        if (err) {
            console.error('LPN check validator solver error:', err);
        }
        this.cleanupAndFail(onFailure, true);
    }

    /**
     * Selects a subset of unique firing entries, shuffling and using a hash check to ensure variation
     * in the synthesized traces compared to the last selection. Ensures goal-relevant traces are included.
     *
     * @param validEntries The list of valid firing sequences.
     * @param maxTraces The maximum number of traces to select.
     * @returns A subset of firing entries.
     */
    private _selectEntriesWithVariation(validEntries: FiringEntry[], maxTraces: number, attempt = 1): FiringEntry[] {
        const difficulty = this.getEffectiveDifficulty();

        if (difficulty === LpnGenerationDifficulty.Easy) {
            const seq = this.goalsService.selectedSequence;
            let candidates = seq ? this._findCausalSequenceTraces(validEntries, seq[0], seq[1]) : validEntries;
            if (candidates.length === 0) candidates = validEntries;

            let selected: FiringEntry;
            let hash = '';
            let retries = 0;
            do {
                selected = candidates[Math.floor(Math.random() * candidates.length)];
                hash = selected.labels.join('-');
                retries++;
            } while (hash === this._lastSelectedEntriesHash && retries < 15 && candidates.length > 1);

            this._lastSelectedEntriesHash = hash;
            return [selected];
        }

        const mustHave = new Set<FiringEntry>();

        // 1. Causal Sequence
        const seq = this.goalsService.selectedSequence;
        if (seq) {
            const candidates = this._findCausalSequenceTraces(validEntries, seq[0], seq[1]);
            if (candidates.length > 0) {
                mustHave.add(candidates[0]);
            }
        }

        // 2. Concurrency
        const concurrent = this.goalsService.selectedConcurrency;
        if (concurrent) {
            const [A, B] = concurrent;
            const { traceAB, traceBA } = this._findConcurrencyTraces(validEntries, A, B);
            if (traceAB) mustHave.add(traceAB);
            if (traceBA) mustHave.add(traceBA);
        }

        // 3. Loop / Repeat
        const loopA = this.goalsService.selectedLoopLabel;
        const repeatA = this.goalsService.selectedRepeatLabel;
        const activeLoop = loopA || repeatA;
        if (activeLoop) {
            const traceWithLoop =
                validEntries.find((e) => e.labels.filter((l) => l === activeLoop).length > 1) ??
                validEntries.find((e) => e.labels.includes(activeLoop));
            if (traceWithLoop) mustHave.add(traceWithLoop);
        }

        // 4. Conflict
        const conflict = this.goalsService.selectedConflict;
        if (conflict) {
            const [Y, Z] = conflict;
            const { traceY, traceZ } = this._findAlignedConflictTraces(validEntries, Y, Z);
            if (traceY) mustHave.add(traceY);
            if (traceZ) mustHave.add(traceZ);
        }

        // If a repeat goal is active in Expert Mode, return only the must-have traces on first attempt.
        if (attempt === 1 && difficulty === LpnGenerationDifficulty.Expert && this.goalsService.selectedRepeatLabel) {
            return Array.from(mustHave);
        }

        // Fill up to maxTraces with variation
        const baseSelection = Array.from(mustHave);
        const remainingEntries = validEntries.filter((entry) => !mustHave.has(entry));
        let selectedEntries: FiringEntry[];
        let hash: string;
        let retries = 0;

        // Cap trace selections to avoid overly complex spaghetti LPNs
        let cap = 4;
        if (difficulty === LpnGenerationDifficulty.Medium) cap = 3;
        else if (difficulty === LpnGenerationDifficulty.Hard) cap = 3;
        else if (difficulty === LpnGenerationDifficulty.Expert) cap = 4;

        do {
            const shuffledRemaining = [...remainingEntries].sort(() => 0.5 - Math.random());
            const minSize = Math.max(baseSelection.length, 1);
            const rawMaxSize = Math.max(minSize, maxTraces);
            const maxSize = Math.max(minSize, Math.min(rawMaxSize, cap));
            const targetSize = minSize + Math.floor(Math.random() * (maxSize - minSize + 1));
            const additional = shuffledRemaining.slice(0, targetSize - baseSelection.length);

            selectedEntries = [...baseSelection, ...additional];
            hash = selectedEntries
                .map((e) => e.labels.join('-'))
                .sort()
                .join('|');
            retries++;
        } while (hash === this._lastSelectedEntriesHash && retries < 15 && validEntries.length > 1);

        this._lastSelectedEntriesHash = hash;
        return selectedEntries;
    }

    private _findAlignedConflictTraces(
        validEntries: FiringEntry[],
        Y: string,
        Z: string,
    ): { traceY: FiringEntry | undefined; traceZ: FiringEntry | undefined } {
        let bestY: FiringEntry | undefined;
        let bestZ: FiringEntry | undefined;
        let maxCommonPrefixLen = -1;

        for (const entryY of validEntries) {
            if (!entryY.labels.includes(Y)) continue;
            const idxY = entryY.labels.indexOf(Y);
            const prefixY = entryY.labels.slice(0, idxY);

            for (const entryZ of validEntries) {
                if (!entryZ.labels.includes(Z)) continue;
                const idxZ = entryZ.labels.indexOf(Z);
                const prefixZ = entryZ.labels.slice(0, idxZ);

                if (prefixY.length === prefixZ.length && prefixY.every((val, i) => val === prefixZ[i])) {
                    return { traceY: entryY, traceZ: entryZ };
                }

                let commonLen = 0;
                const minLen = Math.min(prefixY.length, prefixZ.length);
                while (commonLen < minLen && prefixY[commonLen] === prefixZ[commonLen]) {
                    commonLen++;
                }

                if (commonLen > maxCommonPrefixLen) {
                    maxCommonPrefixLen = commonLen;
                    bestY = entryY;
                    bestZ = entryZ;
                }
            }
        }

        if (!bestY || !bestZ) {
            const traceY = validEntries.find((entry) => entry.labels.includes(Y));
            const traceZ = validEntries.find((entry) => entry.labels.includes(Z));
            return { traceY, traceZ };
        }

        return { traceY: bestY, traceZ: bestZ };
    }

    private _findConcurrencyTraces(
        validEntries: FiringEntry[],
        A: string,
        B: string,
    ): { traceAB?: FiringEntry; traceBA?: FiringEntry } {
        const findTrace = (first: string, second: string) =>
            validEntries.find((e) => {
                const idxF = e.labels.indexOf(first);
                const idxS = e.labels.indexOf(second);
                return idxF !== -1 && idxS !== -1 && idxF < idxS;
            });
        return {
            traceAB: findTrace(A, B),
            traceBA: findTrace(B, A),
        };
    }

    private _findCausalSequenceTraces(validEntries: FiringEntry[], A: string, B: string): FiringEntry[] {
        const adjacent = validEntries.filter((e) => e.labels.some((l, i) => l === A && e.labels[i + 1] === B));
        if (adjacent.length > 0) return adjacent;
        return validEntries.filter((e) => {
            const idxA = e.labels.indexOf(A);
            const idxB = e.labels.indexOf(B);
            return idxA !== -1 && idxB !== -1 && idxA < idxB;
        });
    }

    private getEffectiveDifficulty(overrideDifficulty?: LpnGenerationDifficulty): LpnGenerationDifficulty {
        if (overrideDifficulty) {
            return overrideDifficulty;
        }
        return this.stateService.displayMode() === LpnDisplayMode.Puzzle
            ? this.stateService.lpnGenerationDifficulty()
            : this.goalsService.currentDifficulty();
    }

    private processSynthesisResult(
        resultNet: IlpnPetriNet,
        maxEdges: number,
        ilpnSource: IlpnPetriNet,
        sourceNet: Diagram,
        validEntries: FiringEntry[],
        maxTraces: number,
        config: LpnGenerationConfiguration,
        attempt: number,
        runId: number,
        onFailure?: () => void,
    ) {
        // ponytail: remove implicit, duplicate, and dangling places to simplify the synthesized net structurally
        let simplifiedNet = resultNet;
        simplifiedNet = this.implicitPlaceRemover.removeImplicitPlaces(simplifiedNet);
        simplifiedNet = this.duplicatePlaceRemover.removeDuplicatePlaces(simplifiedNet);
        simplifiedNet = this.danglingPlaceRemover.removeDanglingPlaces(simplifiedNet);

        const candidate = this.buildAndPrepareCandidate(simplifiedNet, maxEdges);
        const ilpnSpec = convertLpnToIlpn(
            candidate.elements,
            candidate.connections,
            this.serializationService,
            this.jsonParser,
        );

        this.validateAndApplyCandidate(
            candidate,
            ilpnSource,
            ilpnSpec,
            sourceNet,
            validEntries,
            maxTraces,
            maxEdges,
            config,
            attempt,
            runId,
            onFailure,
        );
    }

    private clearSynthesisTimeout() {
        if (this._synthesisTimeoutId) {
            clearTimeout(this._synthesisTimeoutId);
            this._synthesisTimeoutId = null;
        }
        this._synthesisActiveRunId = 0;
    }

    private cleanupAndFail(onFailure?: () => void, isError = false) {
        this.clearSynthesisTimeout();
        this.loadingService.hide();
        if (onFailure) {
            onFailure();
        }
        const currentTab = this.tabStateService.currentTab();
        if (currentTab === Tab.TOKEN_TRAIL || currentTab === Tab.PRACTICE) {
            if (isError) {
                this.toaster.showError('TOKEN_TRAIL.LPN_SYNTHESIS_ERROR_TITLE', 'TOKEN_TRAIL.LPN_SYNTHESIS_ERROR_BODY');
            } else {
                this.toaster.showWarning(
                    'TOKEN_TRAIL.LPN_SYNTHESIS_ERROR_TITLE',
                    'TOKEN_TRAIL.LPN_SYNTHESIS_ERROR_BODY',
                );
            }
        }
    }

    /**
     * Maps the synthesized Petri net places and transitions to local lists of condition
     * and event nodes, along with their connections, without mutating the state service.
     *
     * @param minedNet The synthesized Petri net from the region synthesis step.
     * @param maxEdges The maximum allowed edge count before pruning complex places.
     * @returns An object containing the elements and connections.
     */
    private buildCandidateLpn(
        minedNet: IlpnPetriNet,
        maxEdges: number,
    ): { elements: LabeledNetNode[]; connections: LabeledNetEdge[] } {
        const placeMap = new Map<string, string>();
        const transitionMap = new Map<string, string>();

        let places = minedNet.getPlaces();

        const currentEdgeCount = places.reduce((acc, p) => acc + p.ingoingArcs.length + p.outgoingArcs.length, 0);

        if (currentEdgeCount > maxEdges && places.length > 1) {
            const shuffledPlaces = [...places].sort(() => 0.5 - Math.random());
            const filteredPlaces: typeof places = [];
            let newEdgeCount = 0;

            for (const p of shuffledPlaces) {
                const pEdges = p.ingoingArcs.length + p.outgoingArcs.length;
                if (filteredPlaces.length === 0 || newEdgeCount + pEdges <= maxEdges) {
                    filteredPlaces.push(p);
                    newEdgeCount += pEdges;
                }
            }

            if (filteredPlaces.length === 0 && shuffledPlaces.length > 0) {
                filteredPlaces.push(shuffledPlaces[0]);
            }
            places = filteredPlaces;
        }

        const connectedTransitionIds = new Set<string>();
        places.forEach((p) => {
            p.ingoingArcs.forEach((a) => {
                const sourceId = a.sourceId || (a.source as { id: string }).id;
                if (sourceId) connectedTransitionIds.add(sourceId);
            });
            p.outgoingArcs.forEach((a) => {
                const destinationId = a.destinationId || (a.destination as { id: string }).id;
                if (destinationId) connectedTransitionIds.add(destinationId);
            });
        });

        const transitions = minedNet.getTransitions().filter((t) => {
            const tId = t.id;
            return tId && connectedTransitionIds.has(tId);
        });

        const elements: LabeledNetNode[] = [];
        const connections: LabeledNetEdge[] = [];

        const getRandomPos = () => {
            const viewBox = this.panningService.viewBox();
            const width = Math.max(viewBox.width, 800);
            const height = Math.max(viewBox.height, 600);
            return {
                x: viewBox.minX + Math.random() * width,
                y: viewBox.minY + Math.random() * height,
            };
        };

        places.forEach((p) => {
            const pId = p.id || this.stateService.generateElementId('p');
            p.id = pId;

            const uniqueId = this.stateService.generateConditionName();
            placeMap.set(pId, uniqueId);

            const condition = this.stateService.buildCondition(uniqueId, uniqueId, p.marking, {
                isStartPlace: p.marking > 0,
                hideTokens: !(p.marking > 0),
                baseName: uniqueId,
            });
            const pos = getRandomPos();
            condition.x = pos.x;
            condition.y = pos.y;
            elements.push(condition);
        });

        transitions.forEach((t) => {
            const tId = t.id || this.stateService.generateElementId('t');
            t.id = tId;

            const uniqueId = this.stateService.generateElementId(`drawn-trans`);
            transitionMap.set(tId, uniqueId);

            const rawLabel = t.label ?? tId;
            const cleanLabel = rawLabel.split('__split')[0].split('_instance')[0];

            const eventNode = this.stateService.buildEvent(uniqueId, cleanLabel, cleanLabel);
            const pos = getRandomPos();
            eventNode.x = pos.x;
            eventNode.y = pos.y;
            elements.push(eventNode);
        });

        places.forEach((p) => {
            const pId = placeMap.get(p.id!)!;
            p.outgoingArcs.forEach((a) => {
                const destinationId = a.destinationId || (a.destination as { id: string }).id;
                const tId = transitionMap.get(destinationId)!;
                if (!tId) return;
                connections.push(
                    new LabeledNetEdge(this.stateService.generateConnectionId('conn'), pId, tId, a.weight),
                );
            });
            p.ingoingArcs.forEach((a) => {
                const sourceId = a.sourceId || (a.source as { id: string }).id;
                const tId = transitionMap.get(sourceId)!;
                if (!tId) return;
                connections.push(
                    new LabeledNetEdge(this.stateService.generateConnectionId('conn'), tId, pId, a.weight),
                );
            });
        });

        return { elements, connections };
    }

    private buildValidationInputForCandidate(
        sourceNet: Diagram,
        candidateElements: LabeledNetNode[],
        candidateConnections: LabeledNetEdge[],
    ): {
        petri: PetriNet;
        elements: TokenTrailElement[];
        connections: TokenTrailConnection[];
    } {
        const nodes = sourceNet.getNodes();
        const edges = sourceNet.getEdges();
        const startMarkingEntries = Object.entries(sourceNet.startMarking || {}).filter(
            ([, tokens]) => (tokens ?? 0) > 0,
        );

        const petri = {
            places: nodes.filter((n) => n.shape === 'circle').map((n) => n.id),
            placeLabels: Object.fromEntries(
                nodes.filter((n) => n.shape === 'circle').map((n) => [n.id, n.displayLabel]),
            ),
            transitions: nodes.filter((n) => n.shape === 'rect').map((n) => n.id),
            arcs: Object.fromEntries(
                edges.map((e) => [
                    `${e.source},${e.target}`,
                    ((e as unknown as { weight?: number }).weight ?? 1) as number,
                ]),
            ),
            labels: Object.fromEntries(nodes.filter((n) => n.shape === 'rect').map((n) => [n.id, n.displayLabel])),
            marking: Object.fromEntries(startMarkingEntries),
        };

        const elements = candidateElements.map((el) => {
            const isCondition = el instanceof Condition;
            const isEvent = el instanceof LabeledEvent;
            return {
                id: el.id,
                type: isCondition ? 'Condition' : isEvent ? 'Event' : 'Condition',
                label: isCondition ? (el.innerLabel ?? el.displayLabel) : el.displayLabel,
                isStartCondition: isCondition ? el.isStartPlace : undefined,
                marking: isCondition ? el.tokenCount() : undefined,
                trailMarkings: isCondition ? { ...el.trailMarkings } : undefined,
            } as TokenTrailElement;
        });

        const connections = candidateConnections.map(
            (c) =>
                ({
                    id: c.id,
                    from: c.source,
                    to: c.target,
                    weight: c.weight,
                }) as TokenTrailConnection,
        );

        const startConditions = candidateElements
            .filter((el): el is Condition => el instanceof Condition && el.isStartPlace)
            .map((el) => el.label ?? el.displayLabel);

        return {
            petri: {
                ...petri,
                startPlaces: startConditions,
                focusPlaceId: this.stateService.selectedPetriPlaceId() ?? undefined,
            },
            elements,
            connections,
        };
    }

    /**
     * Loads a parsed Petri Net / LPN structure from a Diagram object into the state service.
     * Restores LPN Condition trail markings, baseNames, event coordinates, and edge bendPoints.
     */
    public loadLpnFromDiagram(diagram: Diagram) {
        // Force construction mode: this method targets the construction canvas.
        // If the practice tab was visited last, displayMode may still be 'puzzle',
        // which would prevent correct rendering and fitView.
        this.stateService.setDisplayMode(LpnDisplayMode.Construction);
        this.stateService.clear();
        const hasStartPlaces = diagram.places.some((place) => place.isStartPlace);

        // 1. Map places to LPN Conditions
        diagram.places.forEach((p) => {
            const rawLabel = p.label ?? p.displayLabel ?? p.id;
            const baseName = /^c\d+$/.test(rawLabel)
                ? rawLabel
                : /^c\d+$/.test(p.id)
                  ? p.id
                  : this.stateService.generateConditionName();

            const isStart = hasStartPlaces ? p.isStartPlace : p.isStartPlace || p.tokenCount() > 0;
            const condition = this.stateService.buildCondition(p.id, rawLabel, p.tokenCount(), {
                isStartPlace: isStart,
                hideTokens: !isStart,
                baseName,
            });
            condition.x = p.x;
            condition.y = p.y;

            const trailMarkings: Record<string, number> = {};
            rawLabel.split(' + ').forEach((part) => {
                const match = part.trim().match(/^(\d+)\*(.+)$|^(.+)$/);
                if (match) {
                    const singleLabel = match[2] || match[3];
                    if (singleLabel !== baseName) {
                        const multiplier = match[1] ? parseInt(match[1], 10) : 1;
                        trailMarkings[singleLabel] = (trailMarkings[singleLabel] ?? 0) + multiplier;
                    }
                }
            });
            condition.trailMarkings = trailMarkings;
            condition.updateDynamicLabel();
            this.stateService.addDrawnElement(condition);
        });

        // 2. Map transitions to LPN Events
        diagram.transitions.forEach((t) => {
            const label = t.label ?? t.displayLabel ?? t.id;
            const eventNode = this.stateService.buildEvent(t.id, label, label);
            eventNode.x = t.x;
            eventNode.y = t.y;
            this.stateService.addDrawnElement(eventNode);
        });

        // 3. Map arcs to LPN Connections
        diagram.arcs.forEach((arc) => {
            const edge = new LabeledNetEdge(arc.id, arc.source, arc.target, arc.weight);
            edge.bendPoints = arc.bendPoints?.map(({ x, y }) => ({ x, y })) ?? [];
            this.stateService.addConnection(edge);
        });

        this.stateService.updateDrawnElements((e) => [...e]);
        this.stateService.updateConnections((c) => [...c]);
        this.stateService.synchronizeCounters();
        this.stateService.requestFitView();
    }
}
