import { inject, Injectable } from '@angular/core';
import { PlayService } from './play.service';
import { PlayValidationService } from './play-validation.service';
import { PetriNetRegionSynthesisService } from '../../../ilpn-components/src/lib/algorithms/pn/regions/petri-net-region-synthesis.service';
import { LpnGenerationDifficulty, TokenTrailStateService } from './token-trail-state.service';
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
import { take } from 'rxjs';
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
            difficulty = this.modeService.isExamMode(Tab.TOKEN_TRAIL) ? 'hard' : 'easy';
        }
        this.stateService.setLpnGenerationDifficulty(difficulty);

        const config = DIFFICULTY_CONFIGURATIONS[difficulty];
        const nodeCount = sourceNet.allNodes.length;
        const maxTraceLength = Math.max(3, Math.floor(nodeCount * config.traceLengthMultiplier));
        const maxTraces = Math.max(1, Math.floor(nodeCount * config.maxTracesMultiplier));
        const maxEdges = Math.max(5, Math.floor(nodeCount * config.maxEdgesMultiplier));

        this.playService.firingEntries.set([]);
        this.playValidationService.findSequences(sourceNet, 1, maxTraceLength);

        const entries = this.playService.firingEntries();
        const validEntries = entries.filter((entry) => entry.isValid && entry.labels.length > 0);

        if (validEntries.length === 0) {
            if (onFailure) onFailure();
            return;
        }

        this.loadingService.show();

        // Clear existing solution cache
        this.stateService.solutionCache = null;

        const ilpnSource = this.convertSourceNetToIlpn(sourceNet);

        this.attemptSynthesis(sourceNet, ilpnSource, validEntries, maxTraces, maxEdges, config, 1, onFailure);
    }

    private attemptSynthesis(
        sourceNet: Diagram,
        ilpnSource: IlpnPetriNet,
        validEntries: FiringEntry[],
        maxTraces: number,
        maxEdges: number,
        config: LpnGenerationConfiguration,
        attempt: number,
        onFailure?: () => void,
    ) {
        const selectedEntries = this._selectEntriesWithVariation(validEntries, maxTraces);
        const inputNets: IlpnPetriNet[] = [];

        const splittingProbability = config.splittingProbability;

        for (const entry of selectedEntries) {
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
                        finalLabel = `${label}_instance${occ}`;
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
            inputNets.push(net);
        }

        this.regionSynthesisService
            .synthesise(inputNets, config.synthesisConfig)
            .pipe(take(1))
            .subscribe({
                next: (result) => {
                    // Generate local candidate LPN elements and connections
                    const candidate = this.buildCandidateLpn(result.result, maxEdges);
                    if (this.stateService.displayMode() === 'construction') {
                        const adjusted = this.adjustLpnToSatisfyGoals(candidate.elements, candidate.connections);
                        candidate.elements = adjusted.elements;
                        candidate.connections = adjusted.connections;
                    }

                    // Convert LPN to ilpn components representation for verification
                    const ilpnSpec = this.convertLpnToIlpn(candidate.elements, candidate.connections);

                    // Perform direct check using validator service
                    this.validatorService
                        .validate(ilpnSource, ilpnSpec)
                        .pipe(take(1))
                        .subscribe({
                            next: (results) => {
                                const allValid = results.every((res) => res.valid);
                                let allGoalsMet = true;
                                if (allValid && this.stateService.displayMode() === 'construction') {
                                    const input = this.buildValidationInputForCandidate(
                                        sourceNet,
                                        candidate.elements,
                                        candidate.connections,
                                    );
                                    if (input) {
                                        allGoalsMet = this.goalsService.internalGoals.every((goal) =>
                                            goal.check(input.elements, input.connections, input.petri),
                                        );
                                    }
                                }

                                if (allValid && allGoalsMet) {
                                    // Valid and goals satisfied! Render it visually by updating the state service
                                    this.stateService.clear(false);
                                    for (const el of candidate.elements) {
                                        this.stateService.addDrawnElement(el);
                                    }
                                    for (const conn of candidate.connections) {
                                        this.stateService.addConnection(conn);
                                    }

                                    this.sugiyamaService.calculateLayout(
                                        this.stateService.drawnElements(),
                                        this.stateService.connections(),
                                    );
                                    this.stateService.updateDrawnElements((e) => [...e]);
                                    this.stateService.updateConnections((c) => [...c]);
                                    this.stateService.requestFitView();

                                    // Cache the solution
                                    const solvedTrailsMap = this.mapValidatorResultsToSolvedTrails(results);
                                    this.stateService.solutionCache = solvedTrailsMap;
                                    this.stateService.lastSynthesizedNetSignature = this.getNetSignature(sourceNet);
                                    if (this.stateService.displayMode() === 'construction') {
                                        this.stateService.cachedConstructionSolutionElements =
                                            this.stateService.cloneDrawnElements(this.stateService.drawnElements());
                                        this.stateService.cachedConstructionSolutionConnections =
                                            this.stateService.cloneConnections(this.stateService.connections());
                                        this.stateService.setSolvedTokenTrails(solvedTrailsMap);
                                        this.stateService.setShowingSolution(true);
                                        this.toaster.showSuccess(
                                            'TOKEN_TRAIL.SOLUTION_FOUND_TITLE',
                                            'TOKEN_TRAIL.SOLUTION_FOUND_BODY',
                                        );
                                    }
                                    this.loadingService.hide();
                                } else {
                                    // Invalid LPN check failed or goals not met, retry if under max retries limit
                                    if (attempt < 15) {
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
                                            onFailure,
                                        );
                                    } else {
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
                            },
                            error: (err) => {
                                console.error('LPN check validator solver error:', err);
                                this.loadingService.hide();
                                if (onFailure) {
                                    onFailure();
                                }
                                if (this.tabStateService.currentTab() === Tab.TOKEN_TRAIL) {
                                    this.toaster.showError(
                                        'TOKEN_TRAIL.LPN_SYNTHESIS_ERROR_TITLE',
                                        'TOKEN_TRAIL.LPN_SYNTHESIS_ERROR_BODY',
                                    );
                                }
                            },
                        });
                },
                error: () => {
                    this.loadingService.hide();
                    if (onFailure) {
                        onFailure();
                    }
                    if (this.tabStateService.currentTab() === Tab.TOKEN_TRAIL) {
                        this.toaster.showError(
                            'TOKEN_TRAIL.LPN_SYNTHESIS_ERROR_TITLE',
                            'TOKEN_TRAIL.LPN_SYNTHESIS_ERROR_BODY',
                        );
                    }
                },
            });
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

    private getGoalRequirements(): { requiredLabels: Set<string>; parallelPairs: [string, string][] } {
        const requiredLabels = new Set<string>();
        const parallelPairs: [string, string][] = [];

        if (this.stateService.displayMode() !== 'construction') {
            return { requiredLabels, parallelPairs };
        }

        const goals = this.goalsService.internalGoals;
        for (const goal of goals) {
            if (goal.id === 'easy-label-presence' || goal.id === 'duplicate-event' || goal.id === 'triplicate-event') {
                const match = goal.description.match(/label '([^']+)'/);
                if (match) {
                    requiredLabels.add(match[1]);
                }
            } else if (goal.id === 'flow-event') {
                const match = goal.description.match(/event '([^']+)'/);
                if (match) {
                    requiredLabels.add(match[1]);
                }
            } else if (goal.id === 'parallel-events') {
                const match = goal.description.match(/events labeled '([^']+)' and '([^']+)'/);
                if (match) {
                    requiredLabels.add(match[1]);
                    requiredLabels.add(match[2]);
                    parallelPairs.push([match[1], match[2]]);
                }
            }
        }

        return { requiredLabels, parallelPairs };
    }

    /**
     * Selects a subset of unique firing entries, shuffling and using a hash check to ensure variation
     * in the synthesized traces compared to the last selection. Ensures goal-relevant traces are included.
     *
     * @param validEntries The list of valid firing sequences.
     * @param maxTraces The maximum number of traces to select.
     * @returns A subset of firing entries.
     */
    private _selectEntriesWithVariation(validEntries: FiringEntry[], maxTraces: number): FiringEntry[] {
        const { requiredLabels, parallelPairs } = this.getGoalRequirements();

        const mustHave = new Set<FiringEntry>();

        // 1. Handle parallel pairs first to ensure we get both interleavings
        for (const [l1, l2] of parallelPairs) {
            // Find a trace with l1 before l2
            const traceL1BeforeL2 = validEntries.find((entry) => {
                const idx1 = entry.labels.indexOf(l1);
                const idx2 = entry.labels.indexOf(l2);
                return idx1 !== -1 && idx2 !== -1 && idx1 < idx2;
            });
            if (traceL1BeforeL2) {
                mustHave.add(traceL1BeforeL2);
            }

            // Find a trace with l2 before l1
            const traceL2BeforeL1 = validEntries.find((entry) => {
                const idx1 = entry.labels.indexOf(l1);
                const idx2 = entry.labels.indexOf(l2);
                return idx1 !== -1 && idx2 !== -1 && idx2 < idx1;
            });
            if (traceL2BeforeL1) {
                mustHave.add(traceL2BeforeL1);
            }
        }

        // 2. Handle other required labels
        for (const label of requiredLabels) {
            // Check if we already have a trace containing this label in mustHave
            const alreadyHasLabel = Array.from(mustHave).some((entry) => entry.labels.includes(label));
            if (!alreadyHasLabel) {
                // Find any trace containing this label
                const traceWithLabel = validEntries.find((entry) => entry.labels.includes(label));
                if (traceWithLabel) {
                    mustHave.add(traceWithLabel);
                }
            }
        }

        // Now we have our base mustHave list.
        const baseSelection = Array.from(mustHave);

        // We want to add variation and fill up to maxTraces.
        // We will randomly select from the remaining validEntries.
        const remainingEntries = validEntries.filter((entry) => !mustHave.has(entry));

        let selectedEntries: FiringEntry[];
        let hash: string;
        let retries = 0;

        do {
            const shuffledRemaining = [...remainingEntries].sort(() => 0.5 - Math.random());
            // Target size is between baseSelection.length and maxTraces
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

    private adjustLpnToSatisfyGoals(
        initialElements: LabeledNetNode[],
        initialConnections: LabeledNetEdge[],
    ): { elements: LabeledNetNode[]; connections: LabeledNetEdge[] } {
        const goals = this.goalsService.internalGoals;
        if (!goals || goals.length === 0) return { elements: initialElements, connections: initialConnections };

        const elements = [...initialElements];
        const connections = [...initialConnections];

        // 1. Process duplicate/triplicate/presence goals first
        for (const goal of goals) {
            if (goal.id === 'duplicate-event' || goal.id === 'triplicate-event' || goal.id === 'easy-label-presence') {
                const labelMatch = goal.description.match(/label '([^']+)'/);
                if (!labelMatch) continue;
                const label = labelMatch[1];

                const targetCount = goal.id === 'triplicate-event' ? 3 : goal.id === 'duplicate-event' ? 2 : 1;

                let matchingEvents = elements.filter(
                    (e): e is LabeledEvent => e instanceof LabeledEvent && e.label === label,
                );

                if (matchingEvents.length === 0) {
                    // Fallback: if the event is missing entirely, duplicate any existing event and change its label
                    const eventToDuplicate = elements.find((e): e is LabeledEvent => e instanceof LabeledEvent);
                    if (eventToDuplicate) {
                        const newId = this.stateService.generateElementId('drawn-trans');
                        const newEvent = this.stateService.buildEvent(newId, label, label);
                        newEvent.x = eventToDuplicate.x + 30;
                        newEvent.y = eventToDuplicate.y + 30;
                        elements.push(newEvent);

                        const incoming = connections.filter((c) => c.target === eventToDuplicate.id);
                        const outgoing = connections.filter((c) => c.source === eventToDuplicate.id);

                        for (const conn of incoming) {
                            const newConn = new LabeledNetEdge(
                                this.stateService.generateConnectionId('conn'),
                                conn.source,
                                newId,
                                conn.weight,
                            );
                            connections.push(newConn);
                        }

                        for (const conn of outgoing) {
                            const newConn = new LabeledNetEdge(
                                this.stateService.generateConnectionId('conn'),
                                newId,
                                conn.target,
                                conn.weight,
                            );
                            connections.push(newConn);
                        }

                        matchingEvents = [newEvent];
                    }
                }

                const currentCount = matchingEvents.length;

                if (currentCount > 0 && currentCount < targetCount) {
                    const eventToDuplicate = matchingEvents[0];
                    const numToAdd = targetCount - currentCount;

                    for (let i = 0; i < numToAdd; i++) {
                        const newId = this.stateService.generateElementId('drawn-trans');
                        const newEvent = this.stateService.buildEvent(newId, label, label);
                        newEvent.x = eventToDuplicate.x + 30 * (i + 1);
                        newEvent.y = eventToDuplicate.y + 30 * (i + 1);
                        elements.push(newEvent);

                        const incoming = connections.filter((c) => c.target === eventToDuplicate.id);
                        const outgoing = connections.filter((c) => c.source === eventToDuplicate.id);

                        for (const conn of incoming) {
                            const newConn = new LabeledNetEdge(
                                this.stateService.generateConnectionId('conn'),
                                conn.source,
                                newId,
                                conn.weight,
                            );
                            connections.push(newConn);
                        }

                        for (const conn of outgoing) {
                            const newConn = new LabeledNetEdge(
                                this.stateService.generateConnectionId('conn'),
                                newId,
                                conn.target,
                                conn.weight,
                            );
                            connections.push(newConn);
                        }
                    }
                }
            }
        }

        // 2. Process min-events goal
        const minEventsGoal = goals.find((g) => g.id === 'min-events');
        if (minEventsGoal) {
            const minEventsMatch = minEventsGoal.description.match(/at least (\d+) events/);
            if (minEventsMatch) {
                const minEvents = parseInt(minEventsMatch[1], 10);
                const currentEvents = elements.filter((e): e is LabeledEvent => e instanceof LabeledEvent);
                const currentCount = currentEvents.length;

                if (currentCount > 0 && currentCount < minEvents) {
                    const numToAdd = minEvents - currentCount;
                    for (let i = 0; i < numToAdd; i++) {
                        const eventToDuplicate = currentEvents[i % currentEvents.length];
                        const label = eventToDuplicate.label;
                        const newId = this.stateService.generateElementId('drawn-trans');
                        const newEvent = this.stateService.buildEvent(newId, label, label);
                        newEvent.x = eventToDuplicate.x + 30 * (Math.floor(i / currentEvents.length) + 1);
                        newEvent.y = eventToDuplicate.y + 30 * (Math.floor(i / currentEvents.length) + 1);
                        elements.push(newEvent);

                        const incoming = connections.filter((c) => c.target === eventToDuplicate.id);
                        const outgoing = connections.filter((c) => c.source === eventToDuplicate.id);

                        for (const conn of incoming) {
                            const newConn = new LabeledNetEdge(
                                this.stateService.generateConnectionId('conn'),
                                conn.source,
                                newId,
                                conn.weight,
                            );
                            connections.push(newConn);
                        }

                        for (const conn of outgoing) {
                            const newConn = new LabeledNetEdge(
                                this.stateService.generateConnectionId('conn'),
                                newId,
                                conn.target,
                                conn.weight,
                            );
                            connections.push(newConn);
                        }
                    }
                }
            }
        }

        // 3. Process flow-event goal
        const flowGoal = goals.find((g) => g.id === 'flow-event');
        if (flowGoal) {
            const labelMatch = flowGoal.description.match(/event '([^']+)'/);
            if (labelMatch) {
                const label = labelMatch[1];
                const matchingEvents = elements.filter(
                    (e): e is LabeledEvent => e instanceof LabeledEvent && e.label === label,
                );

                if (matchingEvents.length > 0) {
                    const satisfied = matchingEvents.some((evt) => {
                        const hasIncoming = connections.some((c) => c.target === evt.id);
                        const hasOutgoing = connections.some((c) => c.source === evt.id);
                        return hasIncoming && hasOutgoing;
                    });

                    if (!satisfied) {
                        const evt = matchingEvents[0];
                        const hasIncoming = connections.some((c) => c.target === evt.id);
                        const hasOutgoing = connections.some((c) => c.source === evt.id);

                        const conditions = elements.filter((e): e is Condition => e instanceof Condition);
                        if (conditions.length > 0) {
                            if (!hasIncoming) {
                                const startPlace = conditions.find((c) => c.isStartPlace) || conditions[0];
                                connections.push(
                                    new LabeledNetEdge(
                                        this.stateService.generateConnectionId('conn'),
                                        startPlace.id,
                                        evt.id,
                                        1,
                                    ),
                                );
                            }
                            if (!hasOutgoing) {
                                const endPlace =
                                    conditions.find((c) => !c.isStartPlace) || conditions[conditions.length - 1];
                                connections.push(
                                    new LabeledNetEdge(
                                        this.stateService.generateConnectionId('conn'),
                                        evt.id,
                                        endPlace.id,
                                        1,
                                    ),
                                );
                            }
                        }
                    }
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
