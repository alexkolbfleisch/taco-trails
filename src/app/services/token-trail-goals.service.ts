import { Injectable, inject, signal, effect } from '@angular/core';
import { TokenTrailStateService, LpnGenerationDifficulty } from './token-trail-state.service';
import { SourcePetriNetService } from './source-petri-net.service';
import { TokenTrailValidationService } from './token-trail-validation.service';
import { ToasterNotificationService } from './toaster-notification.service';
import { ModeService } from './mode.service';
import { Tab } from '../classes/tabs';
import { PetriNet, TokenTrailElement, TokenTrailConnection } from '../classes/token-trail.model';
import { Diagram } from '../classes/diagram/diagram';

export interface LpnGoal {
    id: string;
    description: string;
    completed: boolean;
}

export interface InternalGoal {
    id: string;
    description: string;
    check: (elements: TokenTrailElement[], connections: TokenTrailConnection[], sourceNet: PetriNet) => boolean;
}

@Injectable({
    providedIn: 'root',
})
export class TokenTrailGoalsService {
    private stateService = inject(TokenTrailStateService);
    private sourceNetService = inject(SourcePetriNetService);
    private validationService = inject(TokenTrailValidationService);
    private toaster = inject(ToasterNotificationService);
    private modeService = inject(ModeService);

    // Goal Progression / Difficulty State
    readonly currentDifficulty = signal<LpnGenerationDifficulty>('easy');
    readonly unlockedPuzzle = signal<Set<LpnGenerationDifficulty>>(new Set(['easy']));
    readonly unlockedConstruction = signal<Set<LpnGenerationDifficulty>>(new Set(['easy']));

    // Active goals list (with completed state)
    readonly activeGoals = signal<LpnGoal[]>([]);

    readonly sourceNet = signal<Diagram | null>(null);

    private lastSourceNetSignature = '';
    private lastDifficulty: LpnGenerationDifficulty | null = null;

    // Internal goal definitions (with check functions)
    public internalGoals: InternalGoal[] = [];

    constructor() {
        this.loadProgress();

        this.sourceNetService.sourceNet$.subscribe((net) => {
            this.sourceNet.set(net);
        });

        // Regenerate construction goals whenever the source net structure or selected difficulty changes
        effect(() => {
            const net = this.sourceNet();
            const difficulty = this.currentDifficulty();

            const sig = this.getNetSignature(net);
            if (sig === this.lastSourceNetSignature && difficulty === this.lastDifficulty) {
                return;
            }

            this.lastSourceNetSignature = sig;
            this.lastDifficulty = difficulty;
            this.generateGoals(net, difficulty);
        });

        // Evaluate goals in real-time or when explicitly validated
        effect(() => {
            const isExam = this.modeService.isExamMode(Tab.TOKEN_TRAIL);
            // Access sourceNet to establish reactive dependency on source net changes
            this.sourceNet();
            const triggerKey = this.validationService.validationTriggerKey();
            const lastTriggerKey = this.validationService.lastExplicitValidationTriggerKey();

            // In exam mode, only re-evaluate goals if the validation has been explicitly triggered
            if (isExam && triggerKey !== lastTriggerKey) {
                return;
            }

            const input = this.validationService.buildValidationInput();
            if (!input) {
                this.activeGoals.set([]);
                return;
            }

            const evaluated = this.internalGoals.map((g) => ({
                id: g.id,
                description: g.description,
                completed: g.check(input.elements, input.connections, input.petri),
            }));

            this.activeGoals.set(evaluated);

            // Automatic unlocking in Learn Mode
            if (!isExam) {
                const validation = this.validationService.liveValidation();
                if (validation && validation.valid) {
                    const displayMode = this.stateService.displayMode();
                    if (displayMode === 'puzzle') {
                        const currentDiff = this.stateService.lpnGenerationDifficulty();
                        this.unlockNextDifficulty('puzzle', currentDiff);
                    } else {
                        const allGoalsMet = evaluated.every((g) => g.completed);
                        if (allGoalsMet && evaluated.length > 0) {
                            const currentDiff = this.currentDifficulty();
                            this.unlockNextDifficulty('construction', currentDiff);
                        }
                    }
                }
            }
        });

        // Handle validation results and show appropriate toaster notifications
        this.validationService.explicitValidation$.subscribe(({ valid }) => {
            const displayMode = this.stateService.displayMode();

            if (!valid) {
                this.toaster.showError('TOKEN_TRAIL.VALIDATION_FAILED_TITLE', 'TOKEN_TRAIL.VALIDATION_FAILED_BODY');
                return;
            }

            if (displayMode === 'puzzle') {
                this.toaster.showSuccess('TOKEN_TRAIL.VALIDATION_SUCCESS_TITLE', 'TOKEN_TRAIL.VALIDATION_SUCCESS_BODY');
                const currentDiff = this.stateService.lpnGenerationDifficulty();
                this.unlockNextDifficulty('puzzle', currentDiff);
            } else {
                // Construction mode: check if all active goals are completed
                const allGoalsMet = this.activeGoals().every((g) => g.completed);
                if (allGoalsMet) {
                    this.toaster.showSuccess(
                        'TOKEN_TRAIL.VALIDATION_SUCCESS_TITLE',
                        'TOKEN_TRAIL.VALIDATION_SUCCESS_BODY',
                    );
                    const currentDiff = this.currentDifficulty();
                    this.unlockNextDifficulty('construction', currentDiff);
                } else {
                    this.toaster.showWarning(
                        'TOKEN_TRAIL.GOALS.VALIDATION_WARNING_TITLE',
                        'TOKEN_TRAIL.GOALS.VALIDATION_WARNING_BODY',
                    );
                }
            }
        });
    }

    private loadProgress() {
        try {
            const puzzleData = localStorage.getItem('token-trail-unlocked-puzzle');
            if (puzzleData) {
                const diffs = JSON.parse(puzzleData) as LpnGenerationDifficulty[];
                this.unlockedPuzzle.set(new Set(diffs));
            }
            const constData = localStorage.getItem('token-trail-unlocked-construction');
            if (constData) {
                const diffs = JSON.parse(constData) as LpnGenerationDifficulty[];
                this.unlockedConstruction.set(new Set(diffs));
            }
        } catch (e) {
            console.error('Failed to load goal progress from localStorage', e);
        }
    }

    private saveProgress() {
        try {
            localStorage.setItem('token-trail-unlocked-puzzle', JSON.stringify(Array.from(this.unlockedPuzzle())));
            localStorage.setItem(
                'token-trail-unlocked-construction',
                JSON.stringify(Array.from(this.unlockedConstruction())),
            );
        } catch (e) {
            console.error('Failed to save goal progress to localStorage', e);
        }
    }

    setDifficulty(difficulty: LpnGenerationDifficulty) {
        const isUnlocked =
            this.stateService.displayMode() === 'puzzle'
                ? this.unlockedPuzzle().has(difficulty)
                : this.unlockedConstruction().has(difficulty);

        if (!isUnlocked) {
            this.toaster.showError('TOKEN_TRAIL.GOALS.LOCKED_TITLE', 'TOKEN_TRAIL.GOALS.LOCKED_BODY');
            return;
        }

        if (this.currentDifficulty() === difficulty) {
            this.generateGoals(this.sourceNet(), difficulty);
        } else {
            this.currentDifficulty.set(difficulty);
        }
    }

    /**
     * Unlocks the next difficulty when the current one is solved
     */
    unlockNextDifficulty(mode: 'puzzle' | 'construction', currentDiff: LpnGenerationDifficulty) {
        const unlockedSet = mode === 'puzzle' ? this.unlockedPuzzle : this.unlockedConstruction;
        let nextDiff: LpnGenerationDifficulty | null = null;

        if (currentDiff === 'easy' && !unlockedSet().has('medium')) {
            nextDiff = 'medium';
        } else if (currentDiff === 'medium' && !unlockedSet().has('hard')) {
            nextDiff = 'hard';
        }

        if (nextDiff) {
            unlockedSet.update((set) => {
                const nextSet = new Set(set);
                nextSet.add(nextDiff!);
                return nextSet;
            });
            this.saveProgress();

            this.toaster.showSuccess(
                'TOKEN_TRAIL.GOALS.CONGRATS_TITLE',
                mode === 'puzzle'
                    ? 'TOKEN_TRAIL.GOALS.CONGRATS_PUZZLE_BODY'
                    : 'TOKEN_TRAIL.GOALS.CONGRATS_CONSTRUCTION_BODY',
                {
                    messageParams: {
                        nextDifficulty: nextDiff.toUpperCase(),
                    },
                },
            );
        }
    }

    /**
     * Helper to generate construction goals based on the source Petri Net structure
     */
    private generateGoals(sourceNet: Diagram | null, difficulty: LpnGenerationDifficulty) {
        this.stateService.cachedConstructionSolutionElements = null;
        this.stateService.cachedConstructionSolutionConnections = null;

        if (!sourceNet) {
            this.internalGoals = [];
            this.activeGoals.set([]);
            return;
        }

        const nodes = sourceNet.getNodes();
        const places = nodes.filter((n) => n.shape === 'circle');
        const transitions = nodes.filter((n) => n.shape === 'rect');

        const P = places.length;
        const T = transitions.length;

        const uniqueLabels = Array.from(new Set(transitions.map((t) => t.displayLabel || t.id).filter(Boolean)));

        // Helper to pick a random label
        const getRandomLabel = (exclude?: string[]): string | null => {
            const filtered = uniqueLabels.filter((l) => !(exclude ?? []).includes(l));
            if (filtered.length === 0) return null;
            return filtered[Math.floor(Math.random() * filtered.length)];
        };

        const goalsList: InternalGoal[] = [];

        if (difficulty === 'easy') {
            // Easy Mode: relaxed min-events and max-conditions, select exactly 2 goals
            const minEvents = Math.max(1, T - 2 + Math.floor(Math.random() * 2)); // range T-2 to T-1
            goalsList.push({
                id: 'min-events',
                description: `Construct an LPN with at least ${minEvents} events.`,
                check: (elements) => elements.filter((e) => e.type === 'Event').length >= minEvents,
            });

            const choice = Math.random();
            const label = getRandomLabel();

            if (label && choice < 0.5) {
                goalsList.push({
                    id: 'easy-label-presence',
                    description: `The event label '${label}' must appear at least 1 time.`,
                    check: (elements) => elements.some((e) => e.type === 'Event' && e.label === label),
                });
            } else {
                const maxConditions = P + 3 + Math.floor(Math.random() * 3); // range P+3 to P+5
                goalsList.push({
                    id: 'max-conditions',
                    description: `Construct an LPN with at most ${maxConditions} conditions.`,
                    check: (elements) => elements.filter((e) => e.type === 'Condition').length <= maxConditions,
                });
            }
        } else if (difficulty === 'medium') {
            // Medium Mode: relaxed min-events and max-conditions
            const minEvents = Math.max(1, T - 1 + Math.floor(Math.random() * 2)); // range T-1 to T
            goalsList.push({
                id: 'min-events',
                description: `Construct an LPN with at least ${minEvents} events.`,
                check: (elements) => elements.filter((e) => e.type === 'Event').length >= minEvents,
            });

            const maxConditions = P + 1 + Math.floor(Math.random() * 2); // range P+1 to P+2
            goalsList.push({
                id: 'max-conditions',
                description: `Construct an LPN with at most ${maxConditions} conditions.`,
                check: (elements) => elements.filter((e) => e.type === 'Condition').length <= maxConditions,
            });

            const label = getRandomLabel();
            if (label) {
                const choice = Math.random();
                if (choice < 0.5) {
                    goalsList.push({
                        id: 'duplicate-event',
                        description: `The event label '${label}' must appear at least 2 times.`,
                        check: (elements) =>
                            elements.filter((e) => e.type === 'Event' && e.label === label).length >= 2,
                    });
                } else {
                    goalsList.push({
                        id: 'flow-event',
                        description: `The event '${label}' must have at least 1 incoming and 1 outgoing connection.`,
                        check: (elements, connections) => {
                            const matchingEvents = elements.filter((e) => e.type === 'Event' && e.label === label);
                            return matchingEvents.some((evt) => {
                                const hasIncoming = connections.some((c) => c.to === evt.id);
                                const hasOutgoing = connections.some((c) => c.from === evt.id);
                                return hasIncoming && hasOutgoing;
                            });
                        },
                    });
                }
            }
        } else if (difficulty === 'hard') {
            // Hard Mode: relaxed min-events and max-conditions
            const minEvents = T + Math.floor(Math.random() * 2); // range T to T+1
            goalsList.push({
                id: 'min-events',
                description: `Construct an LPN with at least ${minEvents} events.`,
                check: (elements) => elements.filter((e) => e.type === 'Event').length >= minEvents,
            });

            const maxConditions = P + Math.floor(Math.random() * 2); // range P to P+1
            goalsList.push({
                id: 'max-conditions',
                description: `Construct an LPN with at most ${maxConditions} conditions.`,
                check: (elements) => elements.filter((e) => e.type === 'Condition').length <= maxConditions,
            });

            const findConcurrentLabelPair = (): [string, string] | null => {
                const shuffled = [...uniqueLabels].sort(() => Math.random() - 0.5);
                for (let i = 0; i < shuffled.length; i++) {
                    for (let j = i + 1; j < shuffled.length; j++) {
                        if (this.canExecuteConcurrentlyInSourceNet(sourceNet, shuffled[i], shuffled[j])) {
                            return [shuffled[i], shuffled[j]];
                        }
                    }
                }
                return null;
            };

            const choice = Math.random();
            const concurrentPair = choice < 0.5 ? findConcurrentLabelPair() : null;

            if (concurrentPair) {
                const [label1, label2] = concurrentPair;
                goalsList.push({
                    id: 'parallel-events',
                    description: `The events labeled '${label1}' and '${label2}' must be executable in parallel.`,
                    check: (elements, connections) => {
                        return this.checkParallelConcurrency(elements, connections, label1, label2);
                    },
                });
            } else {
                const label1 = getRandomLabel();
                if (label1) {
                    goalsList.push({
                        id: 'triplicate-event',
                        description: `The event label '${label1}' must appear at least 3 times.`,
                        check: (elements) =>
                            elements.filter((e) => e.type === 'Event' && e.label === label1).length >= 3,
                    });
                }
            }
        }

        this.internalGoals = goalsList;
        // Trigger initial check
        const input = this.validationService.buildValidationInput();
        const initialEvaluated = input
            ? goalsList.map((g) => ({
                  id: g.id,
                  description: g.description,
                  completed: g.check(input.elements, input.connections, input.petri),
              }))
            : [];
        this.activeGoals.set(initialEvaluated);
    }

    /**
     * Converts LPN elements and connections to a PetriNet and runs reachability
     * to check if two labeled events can fire concurrently in any reachable marking.
     */
    private checkParallelConcurrency(
        elements: TokenTrailElement[],
        connections: TokenTrailConnection[],
        label1: string,
        label2: string,
    ): boolean {
        // 1. Build a local PetriNet for the LPN
        const lpnPlaces = elements.filter((e) => e.type === 'Condition').map((e) => e.id);
        const lpnTransitions = elements.filter((e) => e.type === 'Event').map((e) => e.id);
        const lpnLabels = Object.fromEntries(elements.filter((e) => e.type === 'Event').map((e) => [e.id, e.label]));

        const lpnArcs: Record<string, number> = {};
        for (const conn of connections) {
            lpnArcs[`${conn.from},${conn.to}`] = conn.weight;
        }

        const lpnMarking: Record<string, number> = {};
        for (const el of elements) {
            if (el.type === 'Condition' && (el.marking ?? 0) > 0) {
                lpnMarking[el.id] = el.marking!;
            }
        }

        // 2. Perform BFS traversal of the state space up to a safe maximum size (e.g. 500 states)
        const visited = new Set<string>();
        const getMarkingKey = (m: Record<string, number>) => lpnPlaces.map((p) => m[p] || 0).join(',');

        const initialKey = getMarkingKey(lpnMarking);
        const queue: Record<string, number>[] = [lpnMarking];
        visited.add(initialKey);

        let stateCount = 0;
        const maxStates = 500;

        while (queue.length > 0 && stateCount < maxStates) {
            const current = queue.shift()!;
            stateCount++;

            // Check if there are two distinct event nodes E1 and E2 labeled as label1 and label2
            // that are concurrently enabled in this marking 'current'.
            for (const t1 of lpnTransitions) {
                for (const t2 of lpnTransitions) {
                    if (t1 === t2) continue;

                    const l1 = lpnLabels[t1];
                    const l2 = lpnLabels[t2];

                    if ((l1 === label1 && l2 === label2) || (l1 === label2 && l2 === label1)) {
                        // Check if t1 and t2 can fire concurrently
                        let concurrentlyEnabled = true;
                        for (const p of lpnPlaces) {
                            const req1 = lpnArcs[`${p},${t1}`] || 0;
                            const req2 = lpnArcs[`${p},${t2}`] || 0;
                            if ((current[p] || 0) < req1 + req2) {
                                concurrentlyEnabled = false;
                                break;
                            }
                        }

                        if (concurrentlyEnabled) {
                            return true; // We found a state where they are executable in parallel!
                        }
                    }
                }
            }

            // Find all enabled single transitions to expand reachability graph
            for (const t of lpnTransitions) {
                let enabled = true;
                for (const p of lpnPlaces) {
                    const req = lpnArcs[`${p},${t}`] || 0;
                    if ((current[p] || 0) < req) {
                        enabled = false;
                        break;
                    }
                }

                if (enabled) {
                    const next = { ...current };
                    for (const p of lpnPlaces) {
                        const sub = lpnArcs[`${p},${t}`] || 0;
                        const add = lpnArcs[`${t},${p}`] || 0;
                        next[p] = (next[p] || 0) - sub + add;
                    }

                    const key = getMarkingKey(next);
                    if (!visited.has(key)) {
                        visited.add(key);
                        queue.push(next);
                    }
                }
            }
        }

        return false;
    }

    private canExecuteConcurrentlyInSourceNet(sourceNet: Diagram, label1: string, label2: string): boolean {
        const places = sourceNet.places;
        const transitions = sourceNet.transitions;
        const arcs = sourceNet.arcs;

        const placeIds = places.map((p) => p.id);
        const t1List = transitions.filter((t) => (t.displayLabel || t.id) === label1);
        const t2List = transitions.filter((t) => (t.displayLabel || t.id) === label2);

        if (t1List.length === 0 || t2List.length === 0) {
            return false;
        }

        const arcWeights: Record<string, number> = {};
        for (const arc of arcs) {
            arcWeights[`${arc.source},${arc.target}`] = arc.weight;
        }

        const startMarking: Record<string, number> = { ...sourceNet.startMarking };
        const visited = new Set<string>();
        const getMarkingKey = (m: Record<string, number>) => placeIds.map((p) => m[p] || 0).join(',');

        const queue: Record<string, number>[] = [startMarking];
        visited.add(getMarkingKey(startMarking));

        const maxStates = 1000;
        let stateCount = 0;

        while (queue.length > 0 && stateCount < maxStates) {
            const current = queue.shift()!;
            stateCount++;

            for (const ta of t1List) {
                for (const tb of t2List) {
                    if (ta.id === tb.id) continue;

                    let concurrentlyEnabled = true;
                    for (const pId of placeIds) {
                        const reqA = arcWeights[`${pId},${ta.id}`] || 0;
                        const reqB = arcWeights[`${pId},${tb.id}`] || 0;
                        if ((current[pId] || 0) < reqA + reqB) {
                            concurrentlyEnabled = false;
                            break;
                        }
                    }

                    if (concurrentlyEnabled) {
                        return true;
                    }
                }
            }

            for (const t of transitions) {
                let enabled = true;
                for (const pId of placeIds) {
                    const req = arcWeights[`${pId},${t.id}`] || 0;
                    if ((current[pId] || 0) < req) {
                        enabled = false;
                        break;
                    }
                }

                if (enabled) {
                    const next = { ...current };
                    for (const pId of placeIds) {
                        const sub = arcWeights[`${pId},${t.id}`] || 0;
                        const add = arcWeights[`${t.id},${pId}`] || 0;
                        next[pId] = (next[pId] || 0) - sub + add;
                    }

                    const key = getMarkingKey(next);
                    if (!visited.has(key)) {
                        visited.add(key);
                        queue.push(next);
                    }
                }
            }
        }

        return false;
    }

    private getNetSignature(net: Diagram | null): string {
        if (!net) return '';
        const nodes = net
            .getNodes()
            .map((n) => `${n.id}:${n.displayLabel || n.id}`)
            .sort()
            .join('|');
        const markings = Object.entries(net.startMarking || {})
            .map(([placeId, tokenCount]) => `${placeId}:${tokenCount}`)
            .sort()
            .join('|');
        const edges = net
            .getEdges()
            .map((a) => `${a.source}->${a.target}:${(a as unknown as { weight?: number }).weight || 1}`)
            .sort()
            .join('|');
        return `${nodes}::${markings}::${edges}`;
    }
}
