import { Injectable, signal } from '@angular/core';
import { DiagramPlaceLabelPlacement } from '../classes/diagram/diagram-place';
import {
    Condition,
    Event as LabeledEvent,
    LabeledNetEdge,
    LabeledNetGraph,
    LabeledNetNode,
} from '../classes/labeled-net.model';
import { viewBoxValues } from '../components/display/display.constants';
import { Subject } from 'rxjs';

export enum LpnGenerationDifficulty {
    Easy = 'easy',
    Medium = 'medium',
    Hard = 'hard',
    Expert = 'expert',
}

export enum LpnDisplayMode {
    Puzzle = 'puzzle',
    Construction = 'construction',
}

@Injectable({ providedIn: 'root' })
export class TokenTrailStateService {
    readonly graph = signal<LabeledNetGraph>(new LabeledNetGraph());

    // Connectors for backwards compatibility/easier refactoring in components
    readonly drawnElements = signal<LabeledNetNode[]>([]);
    readonly connections = signal<LabeledNetEdge[]>([]);

    private conditionCounter = 0;
    private releasedConditionNumbers = new Set<number>();
    private elementIdCounter = 0;
    private connectionIdCounter = 0;

    readonly viewBox = signal<{ minX: number; minY: number; width: number; height: number }>(viewBoxValues);
    readonly selectedPetriPlaceId = signal<string | null>(null);
    readonly heldPetriPlaceId = signal<string | null>(null);

    readonly displayMode = signal<LpnDisplayMode>(LpnDisplayMode.Puzzle);
    readonly lpnGenerationDifficulty = signal<LpnGenerationDifficulty>(LpnGenerationDifficulty.Easy);
    readonly showingSolution = signal<boolean>(false);
    readonly solvedTokenTrails = signal<Map<string, Record<string, number>>>(new Map());
    public solutionCache: Map<string, Record<string, number>> | null = null;
    public lastSynthesizedNetSignature: string | null = null;
    public cachedConstructionSolutionElements: LabeledNetNode[] | null = null;
    public cachedConstructionSolutionConnections: LabeledNetEdge[] | null = null;

    private readonly _fitViewRequest$ = new Subject<void>();
    public readonly fitViewRequest$ = this._fitViewRequest$.asObservable();

    requestFitView() {
        this._fitViewRequest$.next();
    }

    addDrawnElement(element: LabeledNetNode) {
        if (!this.showingSolution()) {
            this.solutionCache = null;
        }
        this.drawnElements.update((el) => [...el, element]);
    }

    addConnection(connection: LabeledNetEdge) {
        if (!this.showingSolution()) {
            this.solutionCache = null;
        }
        this.connections.update((c) => [...c, connection]);
    }

    removeDrawnElement(id: string) {
        if (!this.showingSolution()) {
            this.solutionCache = null;
        }
        this.drawnElements.update((elements) => elements.filter((e) => e.id !== id));
        this.connections.update((connections) => connections.filter((c) => c.source !== id && c.target !== id));
    }

    removeConnection(id: string) {
        if (!this.showingSolution()) {
            this.solutionCache = null;
        }
        this.connections.update((connections) => connections.filter((c) => c.id !== id));
    }

    updateDrawnElements(updater: (elements: LabeledNetNode[]) => LabeledNetNode[]) {
        if (!this.showingSolution()) {
            this.solutionCache = null;
        }
        this.drawnElements.update(updater);
    }

    updateConnections(updater: (connections: LabeledNetEdge[]) => LabeledNetEdge[]) {
        if (!this.showingSolution()) {
            this.solutionCache = null;
        }
        this.connections.update(updater);
    }

    resetCounters() {
        this.elementIdCounter = 0;
        this.connectionIdCounter = 0;
        this.conditionCounter = 0;
        this.releasedConditionNumbers.clear();
    }

    clear(clearCache = true) {
        this.drawnElements.set([]);
        this.connections.set([]);
        this.selectedPetriPlaceId.set(null);
        this.heldPetriPlaceId.set(null);
        this.resetCounters();
        this.showingSolution.set(false);
        this.solvedTokenTrails.set(new Map());
        console.trace('[StateService] clear() called');
        if (clearCache) {
            this.solutionCache = null;
            this.lastSynthesizedNetSignature = null;
            this.cachedConstructionSolutionElements = null;
            this.cachedConstructionSolutionConnections = null;
        }
    }

    setSelectedPetriPlaceId(placeId: string | null) {
        this.selectedPetriPlaceId.set(placeId);
    }

    generateElementId(prefix: string): string {
        return `${prefix}-${++this.elementIdCounter}`;
    }

    generateConnectionId(prefix: string): string {
        return `${prefix}-${++this.connectionIdCounter}`;
    }

    synchronizeCounters(): void {
        let maxConditionNum = 0;
        let maxElementNum = 0;
        let maxConnectionNum = 0;

        this.drawnElements().forEach((node) => {
            if (node instanceof Condition) {
                if (node.baseName) {
                    const matchBase = /^c(\d+)$/.exec(node.baseName.trim());
                    if (matchBase) {
                        const num = parseInt(matchBase[1], 10);
                        if (!isNaN(num)) {
                            maxConditionNum = Math.max(maxConditionNum, num);
                        }
                    }
                }
                const matchId = /^c(\d+)$/.exec(node.id.trim());
                if (matchId) {
                    const num = parseInt(matchId[1], 10);
                    if (!isNaN(num)) {
                        maxConditionNum = Math.max(maxConditionNum, num);
                    }
                }
            }

            const matchIdSuffix = /-(\d+)$/.exec(node.id.trim());
            if (matchIdSuffix) {
                const num = parseInt(matchIdSuffix[1], 10);
                if (!isNaN(num)) {
                    maxElementNum = Math.max(maxElementNum, num);
                }
            }
        });

        this.connections().forEach((conn) => {
            const matchIdSuffix = /-(\d+)$/.exec(conn.id.trim());
            if (matchIdSuffix) {
                const num = parseInt(matchIdSuffix[1], 10);
                if (!isNaN(num)) {
                    maxConnectionNum = Math.max(maxConnectionNum, num);
                }
            }
        });

        this.conditionCounter = Math.max(this.conditionCounter, maxConditionNum);
        this.elementIdCounter = Math.max(this.elementIdCounter, maxElementNum);
        this.connectionIdCounter = Math.max(this.connectionIdCounter, maxConnectionNum);
    }

    setDisplayMode(mode: LpnDisplayMode) {
        this.displayMode.set(mode);
    }

    setLpnGenerationDifficulty(difficulty: LpnGenerationDifficulty) {
        this.lpnGenerationDifficulty.set(difficulty);
    }

    generateConditionName(): string {
        const recycledNumber = this.getSmallestReleasedConditionNumber();
        if (recycledNumber !== null) {
            this.releasedConditionNumbers.delete(recycledNumber);
            return `c${recycledNumber}`;
        }
        return `c${++this.conditionCounter}`;
    }

    releaseConditionName(label: string) {
        const match = /^c(\d+)$/.exec(label.trim());
        if (!match) {
            return;
        }

        const releasedNumber = Number.parseInt(match[1], 10);
        if (!Number.isFinite(releasedNumber) || releasedNumber <= 0) {
            return;
        }

        if (releasedNumber === this.conditionCounter) {
            this.conditionCounter--;
            // Collapse contiguous released tail, e.g. c5 deleted after c6 had been released.
            while (this.releasedConditionNumbers.has(this.conditionCounter)) {
                this.releasedConditionNumbers.delete(this.conditionCounter);
                this.conditionCounter--;
            }
            return;
        }

        if (releasedNumber < this.conditionCounter) {
            this.releasedConditionNumbers.add(releasedNumber);
        }
    }

    private getSmallestReleasedConditionNumber(): number | null {
        if (this.releasedConditionNumbers.size === 0) {
            return null;
        }
        return Math.min(...this.releasedConditionNumbers);
    }

    buildCondition(
        id: string,
        label?: string,
        initialTokens = 0,
        options?: {
            hideTokens?: boolean;
            labelPlacement?: DiagramPlaceLabelPlacement;
            isStartPlace?: boolean;
            innerLabel?: string;
            baseName?: string;
        },
    ): Condition {
        const generatedBaseName = options?.baseName || this.generateConditionName();
        if (options?.baseName) {
            const match = /^c(\d+)$/.exec(options.baseName.trim());
            if (match) {
                const num = Number.parseInt(match[1], 10);
                this.releasedConditionNumbers.delete(num);
            }
        }
        const isStart = options?.isStartPlace ?? false;
        const condition = new Condition(id, isStart ? 1 : initialTokens, label || '', {
            hideTokens: options?.hideTokens ?? !isStart,
            labelPlacement: options?.labelPlacement ?? 'below',
            isStartPlace: isStart,
            innerLabel: options?.innerLabel,
        });
        condition.baseName = generatedBaseName;
        return condition;
    }

    buildEvent(id: string, label: string, transitionId: string): LabeledEvent {
        return new LabeledEvent(id, label, transitionId);
    }

    setShowingSolution(show: boolean) {
        this.showingSolution.set(show);
    }

    setSolvedTokenTrails(trails: Map<string, Record<string, number>>) {
        this.solvedTokenTrails.set(trails);
    }

    public cloneDrawnElements(elements: LabeledNetNode[]): LabeledNetNode[] {
        return elements.map((node) => {
            if (node instanceof Condition) {
                const clone = this.buildCondition(node.id, node.label ?? node.displayLabel, node.tokenCount(), {
                    hideTokens: node.hideTokens,
                    isStartPlace: node.isStartPlace,
                    baseName: node.baseName,
                });
                clone.trailMarkings = { ...node.trailMarkings };
                clone.parentId = node.parentId;
                clone.x = node.x;
                clone.y = node.y;
                return clone;
            }

            const clone = this.buildEvent(node.id, node.displayLabel, node.transitionId);
            clone.x = node.x;
            clone.y = node.y;
            return clone;
        });
    }

    public cloneConnections(connections: LabeledNetEdge[]): LabeledNetEdge[] {
        return connections.map((connection) => {
            const clone = new LabeledNetEdge(connection.id, connection.source, connection.target, connection.weight);
            clone.displayLabel = connection.displayLabel;
            clone.bendPoints = connection.bendPoints.map((point) => ({ x: point.x, y: point.y }));
            return clone;
        });
    }
}
