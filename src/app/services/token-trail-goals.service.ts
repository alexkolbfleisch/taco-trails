import { Injectable, inject, signal, effect } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { TokenTrailStateService, LpnGenerationDifficulty, LpnDisplayMode } from './token-trail-state.service';
import { SourcePetriNetService } from './source-petri-net.service';
import { TokenTrailValidationService } from './token-trail-validation.service';
import { ToasterNotificationService } from './toaster-notification.service';
import { ModeService } from './mode.service';
import { Tab } from '../classes/tabs';
import { PlayService } from './play.service';
import { PlayValidationService } from './play-validation.service';
import { FiringEntry } from '../classes/firing-entry';
import {
    TokenTrailElement,
    TokenTrailConnection,
    LpnGoal,
    InternalGoal,
    SourceNetCapabilities,
    CandidateGoal,
} from '../classes/token-trail.model';
import { Diagram } from '../classes/diagram/diagram';
import { DiagramPlace } from '../classes/diagram/diagram-place';
import { DiagramTransition } from '../classes/diagram/diagram-transition';
import { DiagramArc } from '../classes/diagram/diagram-arc';

@Injectable({
    providedIn: 'root',
})
export class TokenTrailGoalsService {
    private stateService = inject(TokenTrailStateService);
    private sourceNetService = inject(SourcePetriNetService);
    private validationService = inject(TokenTrailValidationService);
    private toaster = inject(ToasterNotificationService);
    private modeService = inject(ModeService);
    private playService = inject(PlayService);
    private playValidationService = inject(PlayValidationService);
    // Goal Progression / Difficulty State
    readonly currentDifficulty = signal<LpnGenerationDifficulty>(LpnGenerationDifficulty.Easy);
    readonly unlockedPuzzle = signal<Set<LpnGenerationDifficulty>>(new Set([LpnGenerationDifficulty.Easy]));
    readonly unlockedConstruction = signal<Set<LpnGenerationDifficulty>>(new Set([LpnGenerationDifficulty.Easy]));

    // Active goals list (with completed state)
    readonly activeGoals = signal<LpnGoal[]>([]);

    readonly sourceNet = toSignal(this.sourceNetService.sourceNet$, { initialValue: null });

    private lastSourceNetSignature = '';
    private lastDifficulty: LpnGenerationDifficulty | null = null;

    // Tracking properties for seeding traces in LPN synthesis
    public selectedSequence: [string, string] | null = null;
    public selectedConflict: [string, string] | null = null;
    public selectedConcurrency: [string, string] | null = null;
    public selectedLoopLabel: string | null = null;
    public selectedRepeatLabel: string | null = null;
    public repeatableLabels: string[] = [];

    public get isTrueLoopActive(): boolean {
        return this.activeGoals().some((g) => g.id === 'loop-invariant' || g.id === 'true-concurrency-fallback');
    }

    // Internal goal definitions (with check functions)
    public internalGoals: InternalGoal[] = [];

    constructor() {
        this.loadProgress();

        // Regenerate construction goals whenever the source net structure or selected difficulty changes
        effect(() => {
            const net = this.sourceNet();
            const difficulty = this.currentDifficulty();

            const sig = Diagram.getSignature(net);
            if (sig === this.lastSourceNetSignature && difficulty === this.lastDifficulty) {
                return;
            }

            this.generateGoals(net, difficulty, true);
        });

        // Evaluate goals in real-time or when explicitly validated
        effect(() => {
            if (this.stateService.displayMode() === LpnDisplayMode.Puzzle) {
                this.activeGoals.set([]);
                return;
            }

            const isExam = this.modeService.isExamMode(Tab.TOKEN_TRAIL);
            // Access sourceNet to establish reactive dependency on source net changes
            this.sourceNet();
            const triggerKey = this.validationService.validationTriggerKey();
            const lastTriggerKey = this.validationService.lastExplicitValidationTriggerKey();

            const input = this.validationService.buildValidationInput();
            if (!input) {
                this.activeGoals.set([]);
                return;
            }

            // In exam mode, only re-evaluate goals if the validation has been explicitly triggered
            if (isExam && triggerKey !== lastTriggerKey) {
                return;
            }

            const evaluated = this.internalGoals.map((g) => ({
                id: g.id,
                descriptionKey: g.descriptionKey,
                descriptionParams: g.descriptionParams,
                completed: g.check(input.elements, input.connections, input.petri),
            }));

            this.activeGoals.set(evaluated);

            // Automatic unlocking in Learn Mode
            if (!isExam && !this.stateService.showingSolution()) {
                const validation = this.validationService.liveValidation();
                if (validation && validation.valid) {
                    const displayMode = this.stateService.displayMode();
                    if (displayMode === LpnDisplayMode.Puzzle) {
                        const currentDiff = this.stateService.lpnGenerationDifficulty();
                        this.unlockNextDifficulty(LpnDisplayMode.Puzzle, currentDiff);
                    } else {
                        const allGoalsMet = evaluated.every((g) => g.completed);
                        if (allGoalsMet && evaluated.length > 0) {
                            const currentDiff = this.currentDifficulty();
                            this.unlockNextDifficulty(LpnDisplayMode.Construction, currentDiff);
                        }
                    }
                }
            }
        });

        // Handle validation results and show appropriate toaster notifications
        this.validationService.explicitValidation$.subscribe(({ valid }) => {
            if (this.stateService.showingSolution()) {
                return;
            }

            const displayMode = this.stateService.displayMode();

            if (!valid) {
                this.toaster.showError('TOKEN_TRAIL.VALIDATION_FAILED_TITLE', 'TOKEN_TRAIL.VALIDATION_FAILED_BODY');
                return;
            }

            if (displayMode === LpnDisplayMode.Puzzle) {
                this.toaster.showSuccess('TOKEN_TRAIL.VALIDATION_SUCCESS_TITLE', 'TOKEN_TRAIL.VALIDATION_SUCCESS_BODY');
                const currentDiff = this.stateService.lpnGenerationDifficulty();
                this.unlockNextDifficulty(LpnDisplayMode.Puzzle, currentDiff);
            } else {
                // Construction mode: check if all active goals are completed
                const allGoalsMet = this.activeGoals().every((g) => g.completed);
                if (allGoalsMet) {
                    this.toaster.showSuccess(
                        'TOKEN_TRAIL.VALIDATION_SUCCESS_TITLE',
                        'TOKEN_TRAIL.VALIDATION_SUCCESS_BODY',
                    );
                    const currentDiff = this.currentDifficulty();
                    this.unlockNextDifficulty(LpnDisplayMode.Construction, currentDiff);
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
            this.stateService.displayMode() === LpnDisplayMode.Puzzle
                ? this.unlockedPuzzle().has(difficulty)
                : this.unlockedConstruction().has(difficulty);

        if (!isUnlocked) {
            this.toaster.showError('TOKEN_TRAIL.GOALS.LOCKED_TITLE', 'TOKEN_TRAIL.GOALS.LOCKED_BODY');
            return;
        }

        if (this.currentDifficulty() === difficulty) {
            this.generateGoals(this.sourceNet(), difficulty, true);
        } else {
            this.currentDifficulty.set(difficulty);
        }
    }

    /**
     * Unlocks the next difficulty when the current one is solved
     */
    unlockNextDifficulty(mode: LpnDisplayMode, currentDiff: LpnGenerationDifficulty) {
        const unlockedSet = mode === LpnDisplayMode.Puzzle ? this.unlockedPuzzle : this.unlockedConstruction;
        let nextDiff: LpnGenerationDifficulty | null = null;

        if (currentDiff === LpnGenerationDifficulty.Easy && !unlockedSet().has(LpnGenerationDifficulty.Medium)) {
            nextDiff = LpnGenerationDifficulty.Medium;
        } else if (currentDiff === LpnGenerationDifficulty.Medium && !unlockedSet().has(LpnGenerationDifficulty.Hard)) {
            nextDiff = LpnGenerationDifficulty.Hard;
        } else if (currentDiff === LpnGenerationDifficulty.Hard && !unlockedSet().has(LpnGenerationDifficulty.Expert)) {
            nextDiff = LpnGenerationDifficulty.Expert;
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
     * Generates construction goals for the given difficulty using a strategy map.
     * Each difficulty entry is a factory function returning its specific InternalGoal list.
     */
    public generateGoals(
        sourceNet: Diagram | null,
        difficulty: LpnGenerationDifficulty,
        force = false,
    ): LpnGenerationDifficulty {
        const sig = sourceNet ? Diagram.getSignature(sourceNet) : '';
        if (
            !force &&
            sig === this.lastSourceNetSignature &&
            difficulty === this.lastDifficulty &&
            this.internalGoals.length > 0
        ) {
            return difficulty;
        }

        this.lastSourceNetSignature = sig;
        this.lastDifficulty = difficulty;

        this.stateService.cachedConstructionSolutionElements = null;
        this.stateService.cachedConstructionSolutionConnections = null;
        this.selectedSequence = null;
        this.selectedConflict = null;
        this.selectedConcurrency = null;
        this.selectedLoopLabel = null;
        this.selectedRepeatLabel = null;
        this.repeatableLabels = [];

        if (!sourceNet) {
            this.internalGoals = [];
            this.activeGoals.set([]);
            return difficulty;
        }

        // Pre-populate firing sequences so trace-based loop dependency checks have access to valid traces
        this.playService.firingEntries.set([]);
        this.playValidationService.findSequences(sourceNet, 1, 300);

        const caps = this.exploreSourceNet(sourceNet);
        const placeIds = sourceNet.places.map((p) => p.id);
        const transitionIds = sourceNet.transitions.map((t) => t.id);

        this.repeatableLabels = sourceNet.transitions
            .filter((t) => this.canTransitionFireTwice(sourceNet, caps, t.id))
            .map((t) => t.label);

        const strategies: Record<LpnGenerationDifficulty, () => InternalGoal[]> = {
            [LpnGenerationDifficulty.Easy]: () => this.buildEasyGoals(sourceNet, caps, placeIds, transitionIds),
            [LpnGenerationDifficulty.Medium]: () => this.buildMediumGoals(sourceNet, caps, placeIds),
            [LpnGenerationDifficulty.Hard]: () => this.buildHardGoals(sourceNet, caps, placeIds, transitionIds),
            [LpnGenerationDifficulty.Expert]: () => this.buildExpertGoals(sourceNet, caps, placeIds, transitionIds),
        };

        const goalsList = strategies[difficulty]();

        this.internalGoals = goalsList;

        // Immediately evaluate goals so the panel populates right away.
        // The reactive effect only re-fires on signal changes — since internalGoals
        // is a plain array, we must seed activeGoals here after every regeneration.
        const input = this.validationService.buildValidationInput();
        this.activeGoals.set(
            input
                ? goalsList.map((g) => ({
                      id: g.id,
                      descriptionKey: g.descriptionKey,
                      descriptionParams: g.descriptionParams,
                      completed: g.check(input.elements, input.connections, input.petri),
                  }))
                : [],
        );

        return difficulty;
    }

    // ─── Difficulty Strategy Builders ───────────────────────────────────────────

    private getPresetAndPostset(
        elements: TokenTrailElement[],
        connections: TokenTrailConnection[],
    ): { preset: Record<string, string[]>; postset: Record<string, string[]> } {
        const preset: Record<string, string[]> = {};
        const postset: Record<string, string[]> = {};
        for (const e of elements) {
            preset[e.id] = [];
            postset[e.id] = [];
        }
        for (const c of connections) {
            if (preset[c.to]) preset[c.to].push(c.from);
            if (postset[c.from]) postset[c.from].push(c.to);
        }
        return { preset, postset };
    }

    private isAcyclic(elements: TokenTrailElement[], connections: TokenTrailConnection[]): boolean {
        const adj = this.buildAdjacency(connections);
        const visited = new Set<string>();
        const temp = new Set<string>();

        const hasCycle = (node: string): boolean => {
            if (temp.has(node)) return true;
            if (visited.has(node)) return false;
            temp.add(node);
            for (const next of adj[node] ?? []) {
                if (hasCycle(next)) return true;
            }
            temp.delete(node);
            visited.add(node);
            return false;
        };

        for (const e of elements) {
            if (!visited.has(e.id)) {
                if (hasCycle(e.id)) return false;
            }
        }
        return true;
    }

    private checkSequenceNetTopology(elements: TokenTrailElement[], connections: TokenTrailConnection[]): boolean {
        const places = elements.filter((e) => e.type === 'Condition');
        if (places.length === 0) return false;

        const { preset, postset } = this.getPresetAndPostset(elements, connections);

        // Exactly one place i has an empty preset
        const starts = places.filter((p) => preset[p.id].length === 0);
        if (starts.length !== 1) return false;
        const i = starts[0];

        // Exactly one place o has an empty postset
        const ends = places.filter((p) => postset[p.id].length === 0);
        if (ends.length !== 1) return false;
        const o = ends[0];

        // Directed path from i to o visiting all nodes
        const path: string[] = [];
        let current = i.id;
        const visited = new Set<string>();
        while (current) {
            path.push(current);
            visited.add(current);
            const nexts = postset[current] || [];
            if (nexts.length === 0) break;
            current = nexts[0];
            if (visited.has(current)) return false;
        }

        if (current !== o.id) return false;
        return visited.size === elements.length;
    }

    private checkSequencePathFallback(elements: TokenTrailElement[], connections: TokenTrailConnection[]): boolean {
        const startPlaces = elements
            .filter((e) => e.type === 'Condition' && e.isStartCondition === true)
            .map((e) => e.id);
        if (startPlaces.length === 0) return false;
        const adj = this.buildAdjacency(connections);
        const visited = new Set<string>(startPlaces);
        const queue = [...startPlaces];
        while (queue.length > 0) {
            const curr = queue.shift()!;
            const isTransition = elements.some((e) => e.id === curr && e.type === 'Event');
            if (isTransition) return true;
            for (const next of adj[curr] ?? []) {
                if (!visited.has(next)) {
                    visited.add(next);
                    queue.push(next);
                }
            }
        }
        return false;
    }

    private checkPartialOrderNetTopology(elements: TokenTrailElement[], connections: TokenTrailConnection[]): boolean {
        const places = elements.filter((e) => e.type === 'Condition');
        const transitions = elements.filter((e) => e.type === 'Event');

        const { preset, postset } = this.getPresetAndPostset(elements, connections);

        // LPN graph must be acyclic (no loops)
        if (!this.isAcyclic(elements, connections)) return false;

        // Every transition has >= 1 incoming and >= 1 outgoing arc
        for (const t of transitions) {
            if (preset[t.id].length < 1 || postset[t.id].length < 1) return false;
        }

        // Every place has at most one incoming and at most one outgoing arc
        for (const p of places) {
            if (preset[p.id].length > 1 || postset[p.id].length > 1) return false;
        }

        return true;
    }

    private checkStateGraphNetTopology(elements: TokenTrailElement[], connections: TokenTrailConnection[]): boolean {
        const places = elements.filter((e) => e.type === 'Condition');
        const transitions = elements.filter((e) => e.type === 'Event');
        if (places.length === 0) return false;

        const { preset, postset } = this.getPresetAndPostset(elements, connections);

        // Exactly one place i has an empty preset
        const starts = places.filter((p) => preset[p.id].length === 0);
        if (starts.length !== 1) return false;
        const i = starts[0];

        // Every transition has exactly one predecessor and one successor
        for (const t of transitions) {
            if (preset[t.id].length !== 1 || postset[t.id].length !== 1) return false;
        }

        // Directed path from i to any other place in the net
        const visited = new Set<string>([i.id]);
        const queue = [i.id];
        const adj = this.buildAdjacency(connections);
        while (queue.length > 0) {
            const curr = queue.shift()!;
            for (const next of adj[curr] ?? []) {
                if (!visited.has(next)) {
                    visited.add(next);
                    queue.push(next);
                }
            }
        }

        return places.every((p) => visited.has(p.id));
    }

    private checkAlternativeBranching(
        elements: TokenTrailElement[],
        connections: TokenTrailConnection[],
        y: string,
        z: string,
    ): boolean {
        const eventsY = elements.filter((e) => e.type === 'Event' && e.label === y).map((e) => e.id);
        const eventsZ = elements.filter((e) => e.type === 'Event' && e.label === z).map((e) => e.id);
        if (eventsY.length === 0 || eventsZ.length === 0) return false;

        const { preset } = this.getPresetAndPostset(elements, connections);

        let sharesPreset = false;
        for (const yId of eventsY) {
            for (const zId of eventsZ) {
                const presetY = preset[yId] ?? [];
                const presetZ = preset[zId] ?? [];
                const hasSharedCondition = presetY.some((condId) => presetZ.includes(condId));
                if (hasSharedCondition) {
                    sharesPreset = true;
                    break;
                }
            }
            if (sharesPreset) break;
        }

        if (!sharesPreset) return false;
        return !this.checkParallelConcurrency(elements, connections, y, z);
    }
    private buildEasyGoals(
        sourceNet: Diagram,
        caps: SourceNetCapabilities,
        placeIds: string[],
        transitionIds: string[],
    ): InternalGoal[] {
        const goals: InternalGoal[] = [];

        // Goal 2: Sequence Net Topology (Paper Def. 8)
        goals.push({
            id: 'sequence-net-topology',
            descriptionKey: 'TOKEN_TRAIL.GOALS.GOAL_SEQUENCE_NET_TOPOLOGY',
            check: (elements, connections) => this.checkSequenceNetTopology(elements, connections),
        });

        // Goal 3: Direct Sequence Mapping
        const seqPair = this.pickSequencePair(sourceNet, caps, placeIds, transitionIds);
        if (seqPair) {
            this.selectedSequence = seqPair;
            const [A, B] = seqPair;
            goals.push({
                id: 'causal-sequence',
                descriptionKey: 'TOKEN_TRAIL.GOALS.GOAL_SEQUENCE_PATH',
                descriptionParams: { a: A, b: B },
                check: (elements, connections) => this.findPathBetweenLabels(elements, connections, A, B),
            });
        } else {
            goals.push({
                id: 'causal-sequence-fallback',
                descriptionKey: 'TOKEN_TRAIL.GOALS.GOAL_SEQUENCE_PATH_FALLBACK',
                check: (elements, connections) => this.checkSequencePathFallback(elements, connections),
            });
        }

        return goals;
    }

    private buildMediumGoals(sourceNet: Diagram, caps: SourceNetCapabilities, placeIds: string[]): InternalGoal[] {
        const goals: InternalGoal[] = [];

        // Goal 2: Partial Order Net Topology (Paper Def. 10)
        goals.push({
            id: 'partial-order-net-topology',
            descriptionKey: 'TOKEN_TRAIL.GOALS.GOAL_PARTIAL_ORDER_TOPOLOGY',
            check: (elements, connections) => this.checkPartialOrderNetTopology(elements, connections),
        });

        // Goal 3: Concurrency Check
        const concurrentPair = this.pickConcurrentPair(sourceNet, caps, placeIds);
        if (concurrentPair) {
            this.selectedConcurrency = concurrentPair;
            const [A, B] = concurrentPair;
            goals.push({
                id: 'true-concurrency',
                descriptionKey: 'TOKEN_TRAIL.GOALS.GOAL_CONCURRENCY_CHECK',
                descriptionParams: { a: A, b: B },
                check: (elements, connections) => this.checkParallelConcurrency(elements, connections, A, B),
            });
        } else {
            const loopLabel = this.pickLoopLabel(sourceNet, caps);
            if (loopLabel) {
                this.selectedLoopLabel = loopLabel;
                goals.push({
                    id: 'true-concurrency-fallback',
                    descriptionKey: 'TOKEN_TRAIL.GOALS.GOAL_CONCURRENCY_FALLBACK',
                    descriptionParams: { a: loopLabel },
                    check: (elements, connections) => this.checkTInvariant(elements, connections, loopLabel),
                });
            }
        }

        return goals;
    }

    private buildHardGoals(
        sourceNet: Diagram,
        caps: SourceNetCapabilities,
        placeIds: string[],
        transitionIds: string[],
    ): InternalGoal[] {
        const goals: InternalGoal[] = [];

        // Goal 2: State Graph Net Topology (Paper Def. 9)
        goals.push({
            id: 'state-graph-net-topology',
            descriptionKey: 'TOKEN_TRAIL.GOALS.GOAL_STATE_GRAPH_TOPOLOGY',
            check: (elements, connections) => this.checkStateGraphNetTopology(elements, connections),
        });

        // Goal 3: Alternative Choice
        const conflictPair = this.pickConflictPair(sourceNet, caps, placeIds);
        if (conflictPair) {
            this.selectedConflict = conflictPair;
            const [Y, Z] = conflictPair;
            goals.push({
                id: 'alternative-branching',
                descriptionKey: 'TOKEN_TRAIL.GOALS.GOAL_ALTERNATIVE_CHOICE',
                descriptionParams: { y: Y, z: Z },
                check: (elements, connections) => this.checkAlternativeBranching(elements, connections, Y, Z),
            });
        } else {
            const fallbackSeqPair = this.pickSequencePair(sourceNet, caps, placeIds, transitionIds);
            if (fallbackSeqPair) {
                const [Y, Z] = fallbackSeqPair;
                goals.push({
                    id: 'alternative-branching-fallback',
                    descriptionKey: 'TOKEN_TRAIL.GOALS.GOAL_ALTERNATIVE_FALLBACK',
                    descriptionParams: { y: Y, z: Z },
                    check: (elements, connections) => this.findPathBetweenLabels(elements, connections, Y, Z),
                });
            }
        }

        return goals;
    }

    private buildExpertGoals(
        sourceNet: Diagram,
        caps: SourceNetCapabilities,
        placeIds: string[],
        transitionIds: string[],
    ): InternalGoal[] {
        // Reset all expert selection variables first
        this.selectedConcurrency = null;
        this.selectedConflict = null;
        this.selectedLoopLabel = null;

        const availableConcurrency = this.pickConcurrentPair(sourceNet, caps, placeIds);
        const availableConflict = this.pickConflictPair(sourceNet, caps, placeIds);

        const trueLoopOptions = sourceNet.transitions
            .filter((t) => this.isTransitionInTrueLoop(sourceNet, caps, t.id))
            .map((t) => t.label);
        const availableTrueLoop =
            trueLoopOptions.length > 0 ? trueLoopOptions[Math.floor(Math.random() * trueLoopOptions.length)] : null;

        const repeatOptions = sourceNet.transitions
            .filter((t) => this.canTransitionFireTwice(sourceNet, caps, t.id))
            .map((t) => t.label);
        const availableRepeat =
            repeatOptions.length > 0 ? repeatOptions[Math.floor(Math.random() * repeatOptions.length)] : null;

        const availableSequence = this.pickSequencePair(sourceNet, caps, placeIds, transitionIds);

        // Build the pool of all structurally available goals for this source net
        const pool: CandidateGoal[] = [];

        if (availableConcurrency) {
            const [A, B] = availableConcurrency;
            pool.push({
                type: 'concurrency',
                value: availableConcurrency,
                goal: {
                    id: 'true-concurrency',
                    descriptionKey: 'TOKEN_TRAIL.GOALS.GOAL_CONCURRENCY_CHECK',
                    descriptionParams: { a: A, b: B },
                    check: (elements, connections) => this.checkParallelConcurrency(elements, connections, A, B),
                },
            });
        }

        if (availableConflict) {
            const [Y, Z] = availableConflict;
            pool.push({
                type: 'conflict',
                value: availableConflict,
                goal: {
                    id: 'alternative-branching',
                    descriptionKey: 'TOKEN_TRAIL.GOALS.GOAL_ALTERNATIVE_CHOICE',
                    descriptionParams: { y: Y, z: Z },
                    check: (elements, connections) => this.checkAlternativeBranching(elements, connections, Y, Z),
                },
            });
        }

        if (availableTrueLoop) {
            pool.push({
                type: 'loop',
                value: availableTrueLoop,
                goal: {
                    id: 'loop-invariant',
                    descriptionKey: 'TOKEN_TRAIL.GOALS.GOAL_CONCURRENCY_FALLBACK',
                    descriptionParams: { a: availableTrueLoop },
                    check: (elements, connections) => this.checkTInvariant(elements, connections, availableTrueLoop),
                },
            });
        }

        if (availableRepeat) {
            pool.push({
                type: 'repeat',
                value: availableRepeat,
                goal: {
                    id: 'repeat-event',
                    descriptionKey: 'TOKEN_TRAIL.GOALS.GOAL_REPEAT_EVENT',
                    descriptionParams: { a: availableRepeat },
                    check: (elements) =>
                        this.checkTransitionFiresTwice(elements, availableRepeat),
                },
            });
        }

        // Shuffle the pool and select up to 2 goals
        pool.sort(() => Math.random() - 0.5);
        const selected = pool.slice(0, 2);

        // Fallback to causal sequence to guarantee we have exactly two goals if possible
        if (selected.length < 2 && availableSequence) {
            const [Y, Z] = availableSequence;
            selected.push({
                type: 'sequence',
                value: availableSequence,
                goal: {
                    id: 'sequence-path',
                    descriptionKey: 'TOKEN_TRAIL.GOALS.GOAL_ALTERNATIVE_FALLBACK',
                    descriptionParams: { y: Y, z: Z },
                    check: (elements, connections) => this.findPathBetweenLabels(elements, connections, Y, Z),
                },
            });
        }

        // Apply selection to the service properties
        this.selectedConflict = null;
        this.selectedLoopLabel = null;
        this.selectedRepeatLabel = null;
        for (const item of selected) {
            if (item.type === 'concurrency') {
                this.selectedConcurrency = item.value as [string, string];
            } else if (item.type === 'conflict') {
                this.selectedConflict = item.value as [string, string];
            } else if (item.type === 'loop') {
                this.selectedLoopLabel = item.value as string;
            } else if (item.type === 'repeat') {
                this.selectedRepeatLabel = item.value as string;
            }
        }

        return selected.map((s) => s.goal);
    }

    /**
     * Picks a random valid (A → B) sequence pair from the source net,
     * filtered by structural sequence and reachability.
     */
    private pickSequencePair(
        sourceNet: Diagram,
        caps: SourceNetCapabilities,
        placeIds: string[],
        transitionIds: string[],
    ): [string, string] | null {
        const pairs: [string, string][] = [];
        for (const aId of transitionIds) {
            for (const bId of transitionIds) {
                if (aId === bId) continue;
                if (this.hasDirectSequence(caps, placeIds, aId, bId)) {
                    const labelA = sourceNet.getTransitionByLabel(aId)?.label ?? aId;
                    const labelB = sourceNet.getTransitionByLabel(bId)?.label ?? bId;
                    if (this.canLabelPrecede(caps, placeIds, sourceNet, labelA, labelB)) {
                        pairs.push([labelA, labelB]);
                    }
                }
            }
        }
        if (pairs.length === 0) return null;
        return pairs[Math.floor(Math.random() * pairs.length)];
    }

    /**
     * Picks a random mutually-exclusive transition pair (conflict) from the source net.
     */
    private pickConflictPair(
        sourceNet: Diagram,
        caps: SourceNetCapabilities,
        placeIds: string[],
    ): [string, string] | null {
        const pairs: [string, string][] = [];
        for (const t1 of sourceNet.transitions) {
            for (const t2 of sourceNet.transitions) {
                if (t1.id === t2.id) continue;
                if (this.hasConflict(caps, placeIds, t1.id, t2.id)) {
                    pairs.push([t1.label, t2.label]);
                }
            }
        }
        if (pairs.length === 0) return null;
        return pairs[Math.floor(Math.random() * pairs.length)];
    }

    /**
     * Picks a random concurrently-enabled transition pair from the source net.
     */
    /**
     * Detects if a label is structurally part of the loop cycle or strictly sequenced by it.
     */
    public isLabelLockedInLoop(validEntries: FiringEntry[], candidateLabel: string, activeLoopLabel: string): boolean {
        // Find a trace where the loop label fires multiple times
        const multiLoopTrace = validEntries.find((e) => e.labels.filter((l) => l === activeLoopLabel).length > 1);

        if (multiLoopTrace) {
            const firstIdx = multiLoopTrace.labels.indexOf(activeLoopLabel);
            const lastIdx = multiLoopTrace.labels.lastIndexOf(activeLoopLabel);

            // If the candidate label is executed BETWEEN the loop iterations,
            // it is structurally trapped inside the loop cycle!
            const subSequence = multiLoopTrace.labels.slice(firstIdx, lastIdx + 1);
            if (subSequence.includes(candidateLabel)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Validates if the concurrency pair conflicts with the active loop constraint.
     */
    public isGoalCombinationValid(
        validEntries: FiringEntry[],
        concurrentLabelA: string,
        concurrentLabelB: string,
        activeLoopLabel: string | null,
    ): boolean {
        if (!activeLoopLabel) return true;

        // 1. Direct block: The loop label itself cannot be part of the concurrency goal
        if (concurrentLabelA === activeLoopLabel || concurrentLabelB === activeLoopLabel) {
            return false;
        }

        // 2. Structural block: Any transition trapped inside the loop cycle (like t4)
        // cannot be paired as concurrent with anything else.
        if (
            this.isLabelLockedInLoop(validEntries, concurrentLabelA, activeLoopLabel) ||
            this.isLabelLockedInLoop(validEntries, concurrentLabelB, activeLoopLabel)
        ) {
            return false;
        }

        return true;
    }

    private pickConcurrentPair(
        sourceNet: Diagram,
        caps: SourceNetCapabilities,
        placeIds: string[],
    ): [string, string] | null {
        const loopLabel = this.selectedLoopLabel;
        const validEntries = this.playService.firingEntries().filter((e) => e.isValid);
        const pairs: [string, string][] = [];
        for (const t1 of sourceNet.transitions) {
            for (const t2 of sourceNet.transitions) {
                if (t1.id === t2.id) continue;
                if (
                    this.hasConcurrency(caps, placeIds, t1.id, t2.id) &&
                    this.canLabelPrecede(caps, placeIds, sourceNet, t1.label, t2.label) &&
                    this.canLabelPrecede(caps, placeIds, sourceNet, t2.label, t1.label) &&
                    this.isGoalCombinationValid(validEntries, t1.label, t2.label, loopLabel)
                ) {
                    pairs.push([t1.label, t2.label]);
                }
            }
        }
        if (pairs.length === 0) return null;
        return pairs[Math.floor(Math.random() * pairs.length)];
    }

    private pickLoopLabel(sourceNet: Diagram, caps: SourceNetCapabilities): string | null {
        const trueLoops = sourceNet.transitions
            .filter((t) => this.isTransitionInTrueLoop(sourceNet, caps, t.id))
            .map((t) => t.label);
        if (trueLoops.length > 0) return trueLoops[Math.floor(Math.random() * trueLoops.length)];

        // Fallback: Find repeatable transitions that can fire at least 2 times
        const repeatable = sourceNet.transitions
            .filter((t) => this.canTransitionFireTwice(sourceNet, caps, t.id))
            .map((t) => t.label);
        if (repeatable.length > 0) return repeatable[Math.floor(Math.random() * repeatable.length)];

        return null;
    }

    private canTransitionFireTwice(sourceNet: Diagram, caps: SourceNetCapabilities, tId: string): boolean {
        const placeIds = sourceNet.places.map((p) => p.id);
        const transitionIds = sourceNet.transitions.map((t) => t.id);
        const getMarkingKey = (m: Record<string, number>) => placeIds.map((pId) => m[pId] ?? 0).join(',');

        const startMarking: Record<string, number> = Object.fromEntries(
            sourceNet.places.map((p) => [p.id, sourceNet.startMarking[p.id] ?? 0]),
        );

        const startKey = getMarkingKey(startMarking);
        const visited = new Map<string, number>([[startKey, 0]]);
        const queue: { marking: Record<string, number>; count: number }[] = [{ marking: startMarking, count: 0 }];

        while (queue.length > 0) {
            const { marking, count } = queue.shift()!;
            if (count >= 2) return true;

            for (const otherTId of transitionIds) {
                const req = caps.preset[otherTId];
                if (!req) continue;
                const enabled = placeIds.every((pId) => (marking[pId] ?? 0) >= (req[pId] ?? 0));
                if (!enabled) continue;

                const next: Record<string, number> = { ...marking };
                const add = caps.postset[otherTId] ?? {};
                for (const pId of placeIds) {
                    next[pId] = (next[pId] ?? 0) - (req[pId] ?? 0) + (add[pId] ?? 0);
                }

                const nextCount = count + (otherTId === tId ? 1 : 0);
                const nextKey = getMarkingKey(next);
                const prevCount = visited.get(nextKey);
                if (prevCount === undefined || nextCount > prevCount) {
                    visited.set(nextKey, nextCount);
                    queue.push({ marking: next, count: nextCount });
                }
            }
        }

        return false;
    }

    private isTransitionInTrueLoop(sourceNet: Diagram, caps: SourceNetCapabilities, tId: string): boolean {
        const placeIds = sourceNet.places.map((p) => p.id);
        const transitionIds = sourceNet.transitions.map((t) => t.id);
        const getMarkingKey = (m: Record<string, number>) => placeIds.map((pId) => m[pId] ?? 0).join(',');

        const adj: Record<string, { tId: string; nextKey: string }[]> = {};

        for (const M of caps.reachableMarkings) {
            const mKey = getMarkingKey(M);
            adj[mKey] = [];

            for (const otherTId of transitionIds) {
                const req = caps.preset[otherTId];
                if (!req) continue;
                const enabled = placeIds.every((pId) => (M[pId] ?? 0) >= (req[pId] ?? 0));
                if (!enabled) continue;

                const next: Record<string, number> = { ...M };
                const add = caps.postset[otherTId] ?? {};
                for (const pId of placeIds) {
                    next[pId] = (next[pId] ?? 0) - (req[pId] ?? 0) + (add[pId] ?? 0);
                }
                const nextKey = getMarkingKey(next);
                adj[mKey].push({ tId: otherTId, nextKey });
            }
        }

        for (const M1 of caps.reachableMarkings) {
            const m1Key = getMarkingKey(M1);
            const outgoing = adj[m1Key] ?? [];
            const edge = outgoing.find((e) => e.tId === tId);
            if (!edge) continue;

            const m2Key = edge.nextKey;

            const visited = new Set<string>([m2Key]);
            const queue = [m2Key];
            let foundPath = false;

            while (queue.length > 0) {
                const curr = queue.shift()!;
                if (curr === m1Key) {
                    foundPath = true;
                    break;
                }
                for (const nextEdge of adj[curr] ?? []) {
                    if (!visited.has(nextEdge.nextKey)) {
                        visited.add(nextEdge.nextKey);
                        queue.push(nextEdge.nextKey);
                    }
                }
            }

            if (foundPath) return true;
        }

        return false;
    }

    // ─── LPN Graph Helpers ───────────────────────────────────────────────────────

    /**
     * BFS from all events labelled A to check if any event labelled B is reachable.
     */
    private findPathBetweenLabels(
        elements: TokenTrailElement[],
        connections: TokenTrailConnection[],
        labelA: string,
        labelB: string,
    ): boolean {
        const startNodes = elements.filter((e) => e.type === 'Event' && e.label === labelA).map((e) => e.id);
        const targetNodes = new Set(elements.filter((e) => e.type === 'Event' && e.label === labelB).map((e) => e.id));

        if (startNodes.length === 0 || targetNodes.size === 0) return false;

        const adj = this.buildAdjacency(connections);
        const visited = new Set<string>(startNodes);
        const queue = [...startNodes];

        while (queue.length > 0) {
            const curr = queue.shift()!;
            if (targetNodes.has(curr)) return true;
            for (const next of adj[curr] ?? []) {
                if (!visited.has(next)) {
                    visited.add(next);
                    queue.push(next);
                }
            }
        }
        return false;
    }

    /**
     * Checks whether a T-invariant containing label A exists in the LPN
     * (i.e. the event can be part of a repeating cycle).
     */
    private checkTInvariant(
        elements: TokenTrailElement[],
        connections: TokenTrailConnection[],
        labelA: string,
    ): boolean {
        // Find the event ID(s) corresponding to labelA
        const targetEventIds = elements.filter((e) => e.type === 'Event' && e.label === labelA).map((e) => e.id);

        if (targetEventIds.length === 0) return false;

        // Build adjacency list for the LPN graph
        const adj: Record<string, string[]> = {};
        for (const el of elements) {
            adj[el.id] = [];
        }
        for (const conn of connections) {
            if (adj[conn.from]) {
                adj[conn.from].push(conn.to);
            }
        }

        // BFS to find if any targetEventId can reach itself in a cycle
        for (const startId of targetEventIds) {
            const visited = new Set<string>();
            const queue = [...(adj[startId] ?? [])];
            while (queue.length > 0) {
                const curr = queue.shift()!;
                if (curr === startId) {
                    return true;
                }
                if (!visited.has(curr)) {
                    visited.add(curr);
                    queue.push(...(adj[curr] ?? []));
                }
            }
        }

        return false;
    }

    private checkTransitionFiresTwice(
        elements: TokenTrailElement[],
        labelA: string,
    ): boolean {
        const nodesCount = elements.filter((e) => e.type === 'Event' && e.label === labelA).length;
        return nodesCount >= 2;
    }

    // ─── Source Net Analysis Helpers ─────────────────────────────────────────────

    /**
     * Explores the source net via BFS to collect all reachable markings and
     * the preset/postset for each transition. Used as the base for all
     * structural analyses to avoid re-computing the state space repeatedly.
     */
    private exploreSourceNet(sourceNet: Diagram): SourceNetCapabilities {
        const placeIds = sourceNet.places.map((p) => p.id);
        const transitionIds = sourceNet.transitions.map((t) => t.id);

        const preset: Record<string, Record<string, number>> = Object.fromEntries(transitionIds.map((id) => [id, {}]));
        const postset: Record<string, Record<string, number>> = Object.fromEntries(transitionIds.map((id) => [id, {}]));

        for (const arc of sourceNet.arcs) {
            const { source: s, target } = arc;
            if (transitionIds.includes(target) && placeIds.includes(s)) {
                preset[target][s] = arc.weight ?? 1;
            } else if (transitionIds.includes(s) && placeIds.includes(target)) {
                postset[s][target] = arc.weight ?? 1;
            }
        }

        const startMarking: Record<string, number> = Object.fromEntries(
            sourceNet.places.map((p) => [p.id, sourceNet.startMarking[p.id] ?? 0]),
        );

        const getMarkingKey = (m: Record<string, number>) => placeIds.map((pId) => m[pId] ?? 0).join(',');

        const visited = new Set<string>([getMarkingKey(startMarking)]);
        const queue: Record<string, number>[] = [startMarking];
        const reachableMarkings: Record<string, number>[] = [];
        const maxStates = 1000;

        while (queue.length > 0 && reachableMarkings.length < maxStates) {
            const current = queue.shift()!;
            reachableMarkings.push(current);

            for (const tId of transitionIds) {
                const req = preset[tId];
                const enabled = placeIds.every((pId) => (current[pId] ?? 0) >= (req[pId] ?? 0));
                if (!enabled) continue;

                const next: Record<string, number> = { ...current };
                const add = postset[tId];
                for (const pId of placeIds) {
                    next[pId] = (next[pId] ?? 0) - (req[pId] ?? 0) + (add[pId] ?? 0);
                }

                const key = getMarkingKey(next);
                if (!visited.has(key)) {
                    visited.add(key);
                    queue.push(next);
                }
            }
        }

        return { reachableMarkings, preset, postset };
    }

    /**
     * Checks whether labelA can fire before labelB in any reachable state,
     * without firing labelB first. Reuses pre-computed caps to avoid
     * redundant state-space exploration.
     */
    private canLabelPrecede(
        caps: SourceNetCapabilities,
        placeIds: string[],
        sourceNet: Diagram,
        labelA: string,
        labelB: string,
    ): boolean {
        const getMarkingKey = (m: Record<string, number>) => placeIds.map((pId) => m[pId] ?? 0).join(',');

        const startMarking: Record<string, number> = Object.fromEntries(
            sourceNet.places.map((p) => [p.id, sourceNet.startMarking[p.id] ?? 0]),
        );

        const visited = new Set<string>([getMarkingKey(startMarking)]);
        const queue: Record<string, number>[] = [startMarking];
        const maxStates = 500;
        let stateCount = 0;

        while (queue.length > 0 && stateCount < maxStates) {
            const current = queue.shift()!;
            stateCount++;

            for (const t of sourceNet.transitions) {
                const req = caps.preset[t.id] ?? {};
                const enabled = placeIds.every((pId) => (current[pId] ?? 0) >= (req[pId] ?? 0));
                if (!enabled) continue;

                if (t.label === labelA) return true;
                if (t.label === labelB) continue; // don't fire B before A

                const next: Record<string, number> = { ...current };
                const add = caps.postset[t.id] ?? {};
                for (const pId of placeIds) {
                    next[pId] = (next[pId] ?? 0) - (req[pId] ?? 0) + (add[pId] ?? 0);
                }

                const key = getMarkingKey(next);
                if (!visited.has(key)) {
                    visited.add(key);
                    queue.push(next);
                }
            }
        }
        return false;
    }

    private hasDirectSequence(caps: SourceNetCapabilities, placeIds: string[], aId: string, bId: string): boolean {
        // Structural check: there must be a place in both the postset of A and the preset of B
        const hasStructuralPlace = placeIds.some(
            (pId) => (caps.postset[aId]?.[pId] ?? 0) > 0 && (caps.preset[bId]?.[pId] ?? 0) > 0,
        );
        if (!hasStructuralPlace) return false;

        // Behavioural check: find a reachable marking where A is enabled and B becomes enabled after A fires
        for (const M of caps.reachableMarkings) {
            const reqA = caps.preset[aId] ?? {};
            const aEnabled = placeIds.every((pId) => (M[pId] ?? 0) >= (reqA[pId] ?? 0));
            if (!aEnabled) continue;

            const MPrime: Record<string, number> = { ...M };
            const postA = caps.postset[aId] ?? {};
            for (const pId of placeIds) {
                MPrime[pId] = (MPrime[pId] ?? 0) - (reqA[pId] ?? 0) + (postA[pId] ?? 0);
            }

            const reqB = caps.preset[bId] ?? {};
            const bEnabled = placeIds.every((pId) => (MPrime[pId] ?? 0) >= (reqB[pId] ?? 0));
            if (bEnabled) return true;
        }
        return false;
    }

    private hasConflict(caps: SourceNetCapabilities, placeIds: string[], yId: string, zId: string): boolean {
        const presetY = caps.preset[yId] ?? {};
        const presetZ = caps.preset[zId] ?? {};

        // Structural check: Y and Z must share at least one input place
        const hasSharedInput = placeIds.some((pId) => (presetY[pId] ?? 0) > 0 && (presetZ[pId] ?? 0) > 0);
        if (!hasSharedInput) return false;

        let yReachable = false;
        let zReachable = false;
        let bothEnabledInSomeMarking = false;

        for (const M of caps.reachableMarkings) {
            const yEnabled = placeIds.every((pId) => (M[pId] ?? 0) >= (presetY[pId] ?? 0));
            const zEnabled = placeIds.every((pId) => (M[pId] ?? 0) >= (presetZ[pId] ?? 0));

            if (yEnabled) yReachable = true;
            if (zEnabled) zReachable = true;

            if (yEnabled && zEnabled) {
                bothEnabledInSomeMarking = true;
                // If both are concurrently enabled in any marking → not a conflict
                if (placeIds.every((pId) => (M[pId] ?? 0) >= (presetY[pId] ?? 0) + (presetZ[pId] ?? 0))) {
                    return false;
                }
            }
        }

        return yReachable && zReachable && bothEnabledInSomeMarking;
    }

    private hasConcurrency(caps: SourceNetCapabilities, placeIds: string[], aId: string, bId: string): boolean {
        const presetA = caps.preset[aId] ?? {};
        const presetB = caps.preset[bId] ?? {};

        return caps.reachableMarkings.some((M) =>
            placeIds.every((pId) => (M[pId] ?? 0) >= (presetA[pId] ?? 0) + (presetB[pId] ?? 0)),
        );
    }

    private checkParallelConcurrency(
        elements: TokenTrailElement[],
        connections: TokenTrailConnection[],
        label1: string,
        label2: string,
    ): boolean {
        const places = elements
            .filter((e) => e.type === 'Condition')
            .map((c) => new DiagramPlace(c.id, c.isStartCondition ? 1 : (c.marking ?? 0), c.label));

        const transitions = elements
            .filter((e) => e.type === 'Event')
            .map((ev) => new DiagramTransition(ev.id, ev.label ?? ev.id));

        const arcs = connections.map((c) => new DiagramArc(c.id || `${c.from}-${c.to}`, c.from, c.to, c.weight));

        const lpnDiagram = new Diagram(places, transitions, arcs);

        const caps = this.exploreSourceNet(lpnDiagram);
        const placeIds = lpnDiagram.places.map((p) => p.id);

        for (const t1 of lpnDiagram.transitions) {
            for (const t2 of lpnDiagram.transitions) {
                if (t1.id === t2.id) continue;
                if ((t1.label === label1 && t2.label === label2) || (t1.label === label2 && t2.label === label1)) {
                    if (this.hasConcurrency(caps, placeIds, t1.id, t2.id)) {
                        return true;
                    }
                }
            }
        }

        return false;
    }

    // ─── Shared Utilities ────────────────────────────────────────────────────────

    /** Builds a forward adjacency map from a connection list. */
    private buildAdjacency(connections: TokenTrailConnection[]): Record<string, string[]> {
        const adj: Record<string, string[]> = {};
        for (const conn of connections) {
            (adj[conn.from] ??= []).push(conn.to);
        }
        return adj;
    }

    public hasConcurrencyInNet(sourceNet: Diagram): boolean {
        const caps = this.exploreSourceNet(sourceNet);
        const placeIds = sourceNet.places.map((p) => p.id);
        for (const t1 of sourceNet.transitions) {
            for (const t2 of sourceNet.transitions) {
                if (t1.id === t2.id) continue;
                if (
                    this.hasConcurrency(caps, placeIds, t1.id, t2.id) &&
                    this.canLabelPrecede(caps, placeIds, sourceNet, t1.label, t2.label) &&
                    this.canLabelPrecede(caps, placeIds, sourceNet, t2.label, t1.label)
                ) {
                    return true;
                }
            }
        }
        return false;
    }

    public hasConflictInNet(sourceNet: Diagram): boolean {
        const caps = this.exploreSourceNet(sourceNet);
        const placeIds = sourceNet.places.map((p) => p.id);
        for (const t1 of sourceNet.transitions) {
            for (const t2 of sourceNet.transitions) {
                if (t1.id === t2.id) continue;
                if (this.hasConflict(caps, placeIds, t1.id, t2.id)) {
                    return true;
                }
            }
        }
        return false;
    }

    public hasLoopInNet(sourceNet: Diagram): boolean {
        const caps = this.exploreSourceNet(sourceNet);
        return sourceNet.transitions.some((t) => this.isTransitionInTrueLoop(sourceNet, caps, t.id));
    }
}
