import { inject, Injectable } from '@angular/core';
import { PlayService } from './play.service';
import { PlayValidationService } from './play-validation.service';
import { PetriNetRegionSynthesisService } from '../../../ilpn-components/src/lib/algorithms/pn/regions/petri-net-region-synthesis.service';
import { LpnGenerationDifficulty, LpnDisplayMode, TokenTrailStateService } from './token-trail-state.service';
import { SugiyamaService } from './sugiyama.service';
import { FiringEntry } from '../classes/firing-entry';
import { PetriNet as IlpnPetriNet } from '../../../ilpn-components/src/lib/models/pn/model/petri-net';
import { Place as IlpnPlace } from '../../../ilpn-components/src/lib/models/pn/model/place';
import { Transition as IlpnTransition } from '../../../ilpn-components/src/lib/models/pn/model/transition';
import { Diagram } from '../classes/diagram/diagram';
import { Condition, Event as LabeledEvent, LabeledNetEdge, LabeledNetNode } from '../classes/labeled-net.model';
import { PanningService } from './panning.service';
import { ModeService } from './mode.service';
import { Tab } from '../classes/tabs';
import { DIFFICULTY_CONFIGURATIONS, LpnGenerationConfiguration } from './token-trail-lpn.config';
import { LoadingService } from './loading.service';
import { ToasterNotificationService } from './toaster-notification.service';
import { TokenTrailValidatorService } from '../../../ilpn-components/src/lib/algorithms/pn/validation/token-trails/token-trail-validator.service';
import { TokenTrailValidationResult } from '../../../ilpn-components/src/lib/algorithms/pn/validation/classes/validation-result';
import { TabStateService } from './tab-state.service';
import { catchError, Observable, of, take, map, switchMap } from 'rxjs';
import { TokenTrailGoalsService } from './token-trail-goals.service';
import { TokenTrailValidationService } from './token-trail-validation.service';
import { PetriNet, TokenTrailElement, TokenTrailConnection } from '../classes/token-trail.model';

@Injectable({
    providedIn: 'root',
})
export class TokenTrailLpnService {
    private playService = inject(PlayService);
    private playValidationService = inject(PlayValidationService);
    private regionSynthesisService = inject(PetriNetRegionSynthesisService);
    private stateService = inject(TokenTrailStateService);
    private sugiyamaService = inject(SugiyamaService);
    private panningService = inject(PanningService);
    private modeService = inject(ModeService);
    private loadingService = inject(LoadingService);
    private toaster = inject(ToasterNotificationService);
    private validatorService = inject(TokenTrailValidatorService);
    private tabStateService = inject(TabStateService);
    private goalsService = inject(TokenTrailGoalsService);
    private validationService = inject(TokenTrailValidationService);
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
     */
    public createLPNWithSynthesis(
        sourceNet: Diagram,
        overrideDifficulty?: LpnGenerationDifficulty,
        onFailure?: () => void,
    ) {
        let difficulty = overrideDifficulty;
        if (!difficulty) {
            difficulty =
                this.stateService.displayMode() === LpnDisplayMode.Puzzle
                    ? this.stateService.lpnGenerationDifficulty()
                    : this.goalsService.currentDifficulty();
        }

        const finalDifficulty = this.goalsService.generateGoals(sourceNet, difficulty);

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

        const ilpnSource = this.convertSourceNetToIlpn(sourceNet);

        const runId = ++this._synthesisActiveRunId;
        if (this._synthesisTimeoutId) {
            clearTimeout(this._synthesisTimeoutId);
        }

        this._synthesisTimeoutId = setTimeout(() => {
            if (runId !== this._synthesisActiveRunId) return;
            console.warn('LPN synthesis timed out after 15 seconds.');
            this.loadingService.hide();
            this._synthesisActiveRunId = 0;
            this._synthesisTimeoutId = null;

            if (onFailure) onFailure();
            if (this.tabStateService.currentTab() === Tab.TOKEN_TRAIL) {
                this.toaster.showWarning(
                    'TOKEN_TRAIL.LPN_SYNTHESIS_ERROR_TITLE',
                    'TOKEN_TRAIL.LPN_SYNTHESIS_ERROR_BODY',
                );
            }
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
        const selectedEntries = this._selectEntriesWithVariation(sourceNet, validEntries, maxTraces);
        const inputNets = this.buildInputNets(selectedEntries, config.splittingProbability);

        this.regionSynthesisService
            .synthesise(inputNets, config.synthesisConfig)
            .pipe(take(1))
            .subscribe({
                next: (result) => {
                    if (runId !== this._synthesisActiveRunId) return;

                    const candidate = this.buildAndPrepareCandidate(result.result, maxEdges);
                    const ilpnSpec = this.convertLpnToIlpn(candidate.elements, candidate.connections);

                    this.validateSafe(ilpnSource, ilpnSpec)
                        .pipe(take(1))
                        .subscribe({
                            next: (results) => {
                                if (runId !== this._synthesisActiveRunId) return;

                                const allValid =
                                    results.length === ilpnSource.getPlaces().length &&
                                    results.every((res) => res.valid);

                                if (!allValid) {
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

                                const solvedTrailsMap = this.mapValidatorResultsToSolvedTrails(results);
                                this.populateCandidateTrailMarkings(candidate, solvedTrailsMap);

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

                                // Minimization step for Expert mode
                                const isExpert =
                                    this.stateService.lpnGenerationDifficulty() === LpnGenerationDifficulty.Expert;
                                const minimizeObs = isExpert
                                    ? this._minimizeCandidateRx(ilpnSource, candidate, sourceNet)
                                    : of(candidate);

                                minimizeObs
                                    .pipe(
                                        take(1),
                                        switchMap((minimizedCandidate) => {
                                            const minimizedIlpnSpec = this.convertLpnToIlpn(
                                                minimizedCandidate.elements,
                                                minimizedCandidate.connections,
                                            );
                                            return this.validateSafe(ilpnSource, minimizedIlpnSpec).pipe(
                                                map((finalResults) => ({ minimizedCandidate, finalResults })),
                                            );
                                        }),
                                    )
                                    .subscribe({
                                        next: ({ minimizedCandidate, finalResults }) => {
                                            if (runId !== this._synthesisActiveRunId) return;

                                            const solvedTrailsMap =
                                                this.mapValidatorResultsToSolvedTrails(finalResults);
                                            this.populateCandidateTrailMarkings(minimizedCandidate, solvedTrailsMap);

                                            this.loadingService.hide();
                                            this.applySuccessfulLpn(minimizedCandidate, solvedTrailsMap, sourceNet);
                                        },
                                        error: (err) => {
                                            if (runId !== this._synthesisActiveRunId) return;
                                            console.error('Error during LPN minimization:', err);
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
                                        },
                                    });
                            },
                            error: (err) => {
                                if (runId !== this._synthesisActiveRunId) return;
                                this.handleSynthesisError(err, onFailure);
                            },
                        });
                },
                error: (err) => {
                    if (runId !== this._synthesisActiveRunId) return;
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

    private buildInputNets(selectedEntries: FiringEntry[], splittingProbability: number): IlpnPetriNet[] {
        const inputNets: IlpnPetriNet[] = [];
        for (const entry of selectedEntries) {
            inputNets.push(this.buildInputNetFromEntry(entry, splittingProbability));
        }
        return inputNets;
    }

    private buildInputNetFromEntry(entry: FiringEntry, splittingProbability: number): IlpnPetriNet {
        const net = new IlpnPetriNet();
        let lastPlace = new IlpnPlace();
        lastPlace.marking = 1;
        net.addPlace(lastPlace);

        const labelCounts = new Map<string, number>();
        let hasDuplicates = false;
        for (const label of entry.labels) {
            const count = (labelCounts.get(label) || 0) + 1;
            labelCounts.set(label, count);
            if (count > 1) {
                hasDuplicates = true;
            }
        }

        const applySplitting = hasDuplicates && Math.random() < splittingProbability;
        const currentOccurrence = new Map<string, number>();

        for (const label of entry.labels) {
            let finalLabel = label;
            if (applySplitting) {
                const occ = (currentOccurrence.get(label) || 0) + 1;
                currentOccurrence.set(label, occ);
                if (labelCounts.get(label)! > 1) {
                    const conflict = this.goalsService.selectedConflict;
                    const isConflictTrans = conflict && (label === conflict[0] || label === conflict[1]);
                    if (!isConflictTrans) {
                        finalLabel = `${label}_instance${occ}`;
                    }
                }
            }

            const t = new IlpnTransition(finalLabel);
            net.addTransition(t);
            net.addArc(lastPlace, t);

            const nextPlace = new IlpnPlace();
            net.addPlace(nextPlace);
            net.addArc(t, nextPlace);

            lastPlace = nextPlace;
        }

        return net;
    }

    private buildAndPrepareCandidate(
        result: IlpnPetriNet,
        maxEdges: number,
    ): { elements: LabeledNetNode[]; connections: LabeledNetEdge[] } {
        const candidate = this.buildCandidateLpn(result, maxEdges);
        if (this.stateService.displayMode() === LpnDisplayMode.Construction) {
            const adjusted = this.adjustLpnToSatisfyGoals(candidate.elements, candidate.connections);
            candidate.elements = adjusted.elements;
            candidate.connections = adjusted.connections;
        }
        return candidate;
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
        if (this._synthesisTimeoutId) {
            clearTimeout(this._synthesisTimeoutId);
            this._synthesisTimeoutId = null;
        }
        this._synthesisActiveRunId = 0;

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
        this.stateService.lastSynthesizedNetSignature = this.getNetSignature(sourceNet);
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
            if (this._synthesisTimeoutId) {
                clearTimeout(this._synthesisTimeoutId);
                this._synthesisTimeoutId = null;
            }
            this._synthesisActiveRunId = 0;
            this.loadingService.hide();

            if (onFailure) {
                onFailure();
            }
            if (this.tabStateService.currentTab() === Tab.TOKEN_TRAIL) {
                this.toaster.showWarning(
                    'TOKEN_TRAIL.LPN_SYNTHESIS_ERROR_TITLE',
                    'TOKEN_TRAIL.LPN_SYNTHESIS_ERROR_BODY',
                );
            }
        }
    }

    private handleSynthesisError(err: unknown, onFailure?: () => void) {
        if (this._synthesisTimeoutId) {
            clearTimeout(this._synthesisTimeoutId);
            this._synthesisTimeoutId = null;
        }
        this._synthesisActiveRunId = 0;
        if (err) {
            console.error('LPN check validator solver error:', err);
        }
        this.loadingService.hide();
        if (onFailure) {
            onFailure();
        }
        if (this.tabStateService.currentTab() === Tab.TOKEN_TRAIL) {
            this.toaster.showError('TOKEN_TRAIL.LPN_SYNTHESIS_ERROR_TITLE', 'TOKEN_TRAIL.LPN_SYNTHESIS_ERROR_BODY');
        }
    }

    public convertSourceNetToIlpn(sourceNet: Diagram): IlpnPetriNet {
        const ilpn = new IlpnPetriNet();
        for (const p of sourceNet.places) {
            ilpn.addPlace(new IlpnPlace(p.tokenCount(), p.id));
        }
        for (const t of sourceNet.transitions) {
            ilpn.addTransition(new IlpnTransition(t.label, t.id));
        }
        for (const edge of sourceNet.arcs) {
            const sourceNode = ilpn.getPlace(edge.source) || ilpn.getTransition(edge.source);
            const destNode = ilpn.getPlace(edge.target) || ilpn.getTransition(edge.target);
            if (sourceNode && destNode) {
                if (sourceNode instanceof IlpnPlace) {
                    ilpn.addArc(sourceNode, destNode as IlpnTransition, edge.weight || 1);
                } else {
                    ilpn.addArc(sourceNode, destNode as IlpnPlace, edge.weight || 1);
                }
            }
        }
        return ilpn;
    }

    public convertLpnToIlpn(drawnElements: LabeledNetNode[], connections: LabeledNetEdge[]): IlpnPetriNet {
        const ilpn = new IlpnPetriNet();
        for (const el of drawnElements) {
            if (el instanceof Condition) {
                ilpn.addPlace(new IlpnPlace(el.isStartPlace ? 1 : 0, el.id));
            }
        }
        for (const el of drawnElements) {
            if (el instanceof LabeledEvent) {
                ilpn.addTransition(new IlpnTransition(el.label, el.id));
            }
        }
        for (const conn of connections) {
            const sourceNode = ilpn.getPlace(conn.source) || ilpn.getTransition(conn.source);
            const destNode = ilpn.getPlace(conn.target) || ilpn.getTransition(conn.target);
            if (sourceNode && destNode) {
                if (sourceNode instanceof IlpnPlace) {
                    ilpn.addArc(sourceNode, destNode as IlpnTransition, conn.weight || 1);
                } else {
                    ilpn.addArc(sourceNode, destNode as IlpnPlace, conn.weight || 1);
                }
            }
        }
        return ilpn;
    }

    public mapValidatorResultsToSolvedTrails(
        results: TokenTrailValidationResult[],
    ): Map<string, Record<string, number>> {
        const solvedTrailsMap = new Map<string, Record<string, number>>();
        for (const res of results) {
            const markingRecord: Record<string, number> = {};
            for (const key of res.tokenTrail.getKeys()) {
                const prefix = 'n0_';
                if (key.startsWith(prefix)) {
                    const elId = key.substring(prefix.length);
                    markingRecord[elId] = res.tokenTrail.get(key) ?? 0;
                }
            }
            solvedTrailsMap.set(res.placeId, markingRecord);
        }
        return solvedTrailsMap;
    }

    public getNetSignature(net: Diagram): string {
        const nodes = net.allNodes
            .map((n) => `${n.id}:${n.label ?? ''}`)
            .sort()
            .join('|');
        const markings = Object.entries(net.startMarking || {})
            .map(([placeId, tokenCount]) => `${placeId}:${tokenCount}`)
            .sort()
            .join('|');
        const edges = net.arcs
            .map((a) => `${a.source}->${a.target}:${a.weight || 1}`)
            .sort()
            .join('|');
        return `${nodes}::${markings}::${edges}`;
    }

    /**
     * Selects a subset of unique firing entries, shuffling and using a hash check to ensure variation
     * in the synthesized traces compared to the last selection. Ensures goal-relevant traces are included.
     *
     * @param validEntries The list of valid firing sequences.
     * @param maxTraces The maximum number of traces to select.
     * @returns A subset of firing entries.
     */
    private _selectEntriesWithVariation(
        sourceNet: Diagram,
        validEntries: FiringEntry[],
        maxTraces: number,
    ): FiringEntry[] {
        const difficulty = this.stateService.lpnGenerationDifficulty();

        const containsDirectSequence = (labels: string[], a: string, b: string) => {
            for (let i = 0; i < labels.length - 1; i++) {
                if (labels[i] === a && labels[i + 1] === b) return true;
            }
            return false;
        };

        if (difficulty === LpnGenerationDifficulty.Easy) {
            let candidates: FiringEntry[] = [];
            const seq = this.goalsService.selectedSequence;
            if (seq) {
                const [A, B] = seq;
                candidates = validEntries.filter((entry) => containsDirectSequence(entry.labels, A, B));
                if (candidates.length === 0) {
                    candidates = validEntries.filter((entry) => {
                        const idxA = entry.labels.indexOf(A);
                        const idxB = entry.labels.indexOf(B);
                        return idxA !== -1 && idxB !== -1 && idxA < idxB;
                    });
                }
            }
            if (candidates.length === 0) {
                candidates = validEntries;
            }

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

        if (difficulty === LpnGenerationDifficulty.Medium) {
            const concurrent = this.goalsService.selectedConcurrency;
            if (concurrent) {
                const [A, B] = concurrent;
                const traceAB = validEntries.find((entry) => {
                    const idxA = entry.labels.indexOf(A);
                    const idxB = entry.labels.indexOf(B);
                    return idxA !== -1 && idxB !== -1 && idxA < idxB;
                });
                const traceBA = validEntries.find((entry) => {
                    const idxA = entry.labels.indexOf(A);
                    const idxB = entry.labels.indexOf(B);
                    return idxA !== -1 && idxB !== -1 && idxB < idxA;
                });
                if (traceAB) mustHave.add(traceAB);
                if (traceBA) mustHave.add(traceBA);
            }
            const loopA = this.goalsService.selectedLoopLabel;
            if (loopA) {
                let traceWithLoop = validEntries.find((entry) => entry.labels.filter((l) => l === loopA).length > 1);
                if (!traceWithLoop) {
                    traceWithLoop = validEntries.find((entry) => entry.labels.includes(loopA));
                }
                if (traceWithLoop) mustHave.add(traceWithLoop);
            }
        } else if (difficulty === LpnGenerationDifficulty.Hard) {
            const conflict = this.goalsService.selectedConflict;
            if (conflict) {
                const [Y, Z] = conflict;
                const { traceY, traceZ } = this._findAlignedConflictTraces(validEntries, Y, Z);
                if (traceY) mustHave.add(traceY);
                if (traceZ) mustHave.add(traceZ);
            }
            const splitX = this.goalsService.selectedSplitLabel;
            if (splitX) {
                const traceWithX = validEntries.find((entry) => entry.labels.includes(splitX));
                if (traceWithX) mustHave.add(traceWithX);
            }
        } else if (difficulty === LpnGenerationDifficulty.Expert) {
            // Concurrency
            const concurrent = this.goalsService.selectedConcurrency;
            if (concurrent) {
                const [A, B] = concurrent;
                const traceAB = validEntries.find((entry) => {
                    const idxA = entry.labels.indexOf(A);
                    const idxB = entry.labels.indexOf(B);
                    return idxA !== -1 && idxB !== -1 && idxA < idxB;
                });
                const traceBA = validEntries.find((entry) => {
                    const idxA = entry.labels.indexOf(A);
                    const idxB = entry.labels.indexOf(B);
                    return idxA !== -1 && idxB !== -1 && idxB < idxA;
                });
                if (traceAB) mustHave.add(traceAB);
                if (traceBA) mustHave.add(traceBA);
            }
            // Conflict
            const conflict = this.goalsService.selectedConflict;
            if (conflict) {
                const [Y, Z] = conflict;
                const { traceY, traceZ } = this._findAlignedConflictTraces(validEntries, Y, Z);
                if (traceY) mustHave.add(traceY);
                if (traceZ) mustHave.add(traceZ);
            }
            // Loop
            const loopA = this.goalsService.selectedLoopLabel;
            if (loopA) {
                let traceWithLoop = validEntries.find((entry) => entry.labels.filter((l) => l === loopA).length > 1);
                if (!traceWithLoop) {
                    traceWithLoop = validEntries.find((entry) => entry.labels.includes(loopA));
                }
                if (traceWithLoop) mustHave.add(traceWithLoop);
            }
        }

        // We want to add variation and fill up to maxTraces.
        const baseSelection = Array.from(mustHave);
        const remainingEntries = validEntries.filter((entry) => !mustHave.has(entry));

        let selectedEntries: FiringEntry[];
        let hash: string;
        let retries = 0;

        do {
            const shuffledRemaining = [...remainingEntries].sort(() => 0.5 - Math.random());
            const minSize = Math.max(baseSelection.length, 1);
            const maxSize = Math.max(minSize, maxTraces);
            const targetSize = minSize + Math.floor(Math.random() * (maxSize - minSize + 1));

            const additionalNeeded = targetSize - baseSelection.length;
            const additional = shuffledRemaining.slice(0, additionalNeeded);

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
            if (!entryY.labels.includes(Y) || entryY.labels.includes(Z)) continue;
            const idxY = entryY.labels.indexOf(Y);
            const prefixY = entryY.labels.slice(0, idxY);

            for (const entryZ of validEntries) {
                if (!entryZ.labels.includes(Z) || entryZ.labels.includes(Y)) continue;
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
            const traceYNotZ = validEntries.find((entry) => entry.labels.includes(Y) && !entry.labels.includes(Z));
            const traceZNotY = validEntries.find((entry) => entry.labels.includes(Z) && !entry.labels.includes(Y));
            return { traceY: traceYNotZ, traceZ: traceZNotY };
        }

        return { traceY: bestY, traceZ: bestZ };
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

    private _minimizeCandidateRx(
        ilpnSource: IlpnPetriNet,
        candidate: { elements: LabeledNetNode[]; connections: LabeledNetEdge[] },
        sourceNet: Diagram,
    ): Observable<{ elements: LabeledNetNode[]; connections: LabeledNetEdge[] }> {
        const conditions = candidate.elements.filter((el) => el instanceof Condition) as Condition[];

        const attemptPruning = (
            current: { elements: LabeledNetNode[]; connections: LabeledNetEdge[] },
            index: number,
        ): Observable<{ elements: LabeledNetNode[]; connections: LabeledNetEdge[] }> => {
            if (index >= conditions.length) {
                return of(current);
            }

            const targetCond = conditions[index];
            const currentConds = current.elements.filter((el) => el instanceof Condition);
            if (currentConds.length <= 1) {
                return attemptPruning(current, index + 1);
            }

            // Exclude the target condition and prune any events that become disconnected
            const connectionsAfterCondPrune = current.connections.filter(
                (conn) => conn.source !== targetCond.id && conn.target !== targetCond.id,
            );
            const activeEventIds = new Set<string>();
            connectionsAfterCondPrune.forEach((c) => {
                activeEventIds.add(c.source);
                activeEventIds.add(c.target);
            });
            const prunedElements = current.elements.filter((el) => {
                if (el instanceof Condition) {
                    return el.id !== targetCond.id;
                } else {
                    return activeEventIds.has(el.id);
                }
            });
            const prunedConnections = connectionsAfterCondPrune;

            const ilpnSpec = this.convertLpnToIlpn(prunedElements, prunedConnections);

            return this.validateSafe(ilpnSource, ilpnSpec).pipe(
                switchMap((results) => {
                    const allValid =
                        results.length === ilpnSource.getPlaces().length && results.every((res) => res.valid);

                    let allGoalsMet = false;
                    if (allValid) {
                        const checkInput = this.buildValidationInputForCandidate(
                            sourceNet,
                            prunedElements,
                            prunedConnections,
                        );
                        allGoalsMet = this.goalsService.internalGoals.every((goal) =>
                            goal.check(checkInput.elements, checkInput.connections, checkInput.petri),
                        );
                    }

                    if (allValid && allGoalsMet) {
                        const nextCandidate = { elements: prunedElements, connections: prunedConnections };
                        return attemptPruning(nextCandidate, index + 1);
                    } else {
                        return attemptPruning(current, index + 1);
                    }
                }),
            );
        };

        return attemptPruning(candidate, 0);
    }

    private adjustLpnToSatisfyGoals(
        initialElements: LabeledNetNode[],
        initialConnections: LabeledNetEdge[],
    ): { elements: LabeledNetNode[]; connections: LabeledNetEdge[] } {
        const splitLabel = this.goalsService.selectedSplitLabel;
        if (!splitLabel) return { elements: initialElements, connections: initialConnections };

        const elements = [...initialElements];
        const connections = [...initialConnections];

        let matchingEvents = elements.filter(
            (e): e is LabeledEvent => e instanceof LabeledEvent && e.label === splitLabel,
        );

        if (matchingEvents.length === 0) {
            // Fallback: if the event is missing entirely, duplicate any existing event and change its label
            const eventToDuplicate = elements.find((e): e is LabeledEvent => e instanceof LabeledEvent);
            if (eventToDuplicate) {
                const newId = this.stateService.generateElementId('drawn-trans');
                const newEvent = this.stateService.buildEvent(newId, splitLabel, splitLabel);
                newEvent.x = eventToDuplicate.x + 30;
                newEvent.y = eventToDuplicate.y + 30;
                elements.push(newEvent);

                const incoming = connections.filter((c) => c.target === eventToDuplicate.id);
                const outgoing = connections.filter((c) => c.source === eventToDuplicate.id);

                for (const conn of incoming) {
                    connections.push(
                        new LabeledNetEdge(
                            this.stateService.generateConnectionId('conn'),
                            conn.source,
                            newId,
                            conn.weight,
                        ),
                    );
                }

                for (const conn of outgoing) {
                    connections.push(
                        new LabeledNetEdge(
                            this.stateService.generateConnectionId('conn'),
                            newId,
                            conn.target,
                            conn.weight,
                        ),
                    );
                }

                matchingEvents = [newEvent];
            }
        }

        const currentCount = matchingEvents.length;
        const targetCount = 2; // Label splitting requires at least 2 duplicates

        if (currentCount > 0 && currentCount < targetCount) {
            const eventToDuplicate = matchingEvents[0];
            const numToAdd = targetCount - currentCount;

            for (let i = 0; i < numToAdd; i++) {
                const newId = this.stateService.generateElementId('drawn-trans');
                const newEvent = this.stateService.buildEvent(newId, splitLabel, splitLabel);
                newEvent.x = eventToDuplicate.x + 30 * (i + 1);
                newEvent.y = eventToDuplicate.y + 30 * (i + 1);
                elements.push(newEvent);

                const incoming = connections.filter((c) => c.target === eventToDuplicate.id);
                const outgoing = connections.filter((c) => c.source === eventToDuplicate.id);

                for (const conn of incoming) {
                    connections.push(
                        new LabeledNetEdge(
                            this.stateService.generateConnectionId('conn'),
                            conn.source,
                            newId,
                            conn.weight,
                        ),
                    );
                }

                for (const conn of outgoing) {
                    connections.push(
                        new LabeledNetEdge(
                            this.stateService.generateConnectionId('conn'),
                            newId,
                            conn.target,
                            conn.weight,
                        ),
                    );
                }
            }
        }

        return { elements, connections };
    }

    /**
     * Loads a parsed Petri Net / LPN structure from a Diagram object into the state service.
     * Restores LPN Condition trail markings, baseNames, event coordinates, and edge bendPoints.
     */
    public loadLpnFromDiagram(diagram: Diagram) {
        this.stateService.clear();

        const hasStartPlaces = diagram.places.some((place) => place.isStartPlace);

        // 1. Map places to LPN Conditions
        for (const p of diagram.places) {
            const rawLabel = p.label ?? p.displayLabel ?? p.id;

            // Extract baseName: if it is e.g. c1 or c2, use it. Otherwise use a new one.
            let baseName = rawLabel;
            if (!/^c\d+$/.test(rawLabel)) {
                if (/^c\d+$/.test(p.id)) {
                    baseName = p.id;
                } else {
                    baseName = this.stateService.generateConditionName();
                }
            }

            const isStart = hasStartPlaces ? p.isStartPlace : p.isStartPlace || p.tokenCount() > 0;

            // Build condition
            const condition = this.stateService.buildCondition(p.id, rawLabel, p.tokenCount(), {
                isStartPlace: isStart,
                hideTokens: !isStart,
                baseName: baseName,
            });

            condition.x = p.x;
            condition.y = p.y;

            // Parse label to recover trail markings
            const trailMarkings: Record<string, number> = {};
            const parts = rawLabel.split(' + ').map((part) => part.trim());
            for (const part of parts) {
                const match = part.match(/^(\d+)\*(.+)$|^(.+)$/);
                if (match) {
                    const multiplier = match[1] ? parseInt(match[1], 10) : 1;
                    const singleLabel = match[2] || match[3];
                    if (singleLabel !== baseName) {
                        trailMarkings[singleLabel] = (trailMarkings[singleLabel] ?? 0) + multiplier;
                    }
                }
            }
            condition.trailMarkings = trailMarkings;
            condition.updateDynamicLabel();

            this.stateService.addDrawnElement(condition);
        }

        // 2. Map transitions to LPN Events
        for (const t of diagram.transitions) {
            const label = t.label ?? t.displayLabel ?? t.id;
            const eventNode = this.stateService.buildEvent(t.id, label, label);
            eventNode.x = t.x;
            eventNode.y = t.y;
            this.stateService.addDrawnElement(eventNode);
        }

        // 3. Map arcs to LPN Connections
        for (const arc of diagram.arcs) {
            const edge = new LabeledNetEdge(arc.id, arc.source, arc.target, arc.weight);
            edge.bendPoints = arc.bendPoints ? arc.bendPoints.map((bp) => ({ x: bp.x, y: bp.y })) : [];
            this.stateService.addConnection(edge);
        }

        this.stateService.updateDrawnElements((e) => [...e]);
        this.stateService.updateConnections((c) => [...c]);
        this.stateService.requestFitView();
    }
}
