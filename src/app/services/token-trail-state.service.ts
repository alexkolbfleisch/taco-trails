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

export type LpnGenerationDifficulty = 'easy' | 'medium' | 'hard';

export interface TokenTrailModeSnapshot {
    drawnElements: LabeledNetNode[];
    connections: LabeledNetEdge[];
    conditionCounter: number;
    releasedConditionNumbers: Set<number>;
    elementIdCounter: number;
    connectionIdCounter: number;
    showingSolution: boolean;
    solvedTokenTrails: Map<string, Record<string, number>>;
    solutionCache: Map<string, Record<string, number>> | null;
    selectedPetriPlaceId: string | null;
    mergeState?: {
        mergedConditionAnchorById: Record<string, string>;
        lastPhysicalMergeSnapshot: unknown;
    };
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

    readonly displayMode = signal<'puzzle' | 'construction'>('puzzle');
    readonly lpnGenerationDifficulty = signal<LpnGenerationDifficulty>('medium');
    readonly showingSolution = signal<boolean>(false);
    readonly solvedTokenTrails = signal<Map<string, Record<string, number>>>(new Map());
    public solutionCache: Map<string, Record<string, number>> | null = null;
    public lastSynthesizedNetSignature: string | null = null;
    public cachedConstructionSolutionElements: LabeledNetNode[] | null = null;
    public cachedConstructionSolutionConnections: LabeledNetEdge[] | null = null;

    private puzzleSnapshot: TokenTrailModeSnapshot | null = null;
    private constructionSnapshot: TokenTrailModeSnapshot | null = null;

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

    clear(clearCache = true) {
        this.drawnElements.set([]);
        this.connections.set([]);
        this.selectedPetriPlaceId.set(null);
        this.elementIdCounter = 0;
        this.connectionIdCounter = 0;
        this.conditionCounter = 0;
        this.releasedConditionNumbers.clear();
        this.showingSolution.set(false);
        this.solvedTokenTrails.set(new Map());
        if (clearCache) {
            this.solutionCache = null;
            this.lastSynthesizedNetSignature = null;
            this.cachedConstructionSolutionElements = null;
            this.cachedConstructionSolutionConnections = null;
            this.clearSnapshots();
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

    setDisplayMode(mode: 'puzzle' | 'construction') {
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
        const condition = new Condition(id, initialTokens, label || generatedBaseName, {
            hideTokens: options?.hideTokens ?? true,
            labelPlacement: options?.labelPlacement ?? 'below',
            isStartPlace: options?.isStartPlace ?? false,
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

    saveSnapshot(
        mode: 'puzzle' | 'construction',
        mergeState?: {
            mergedConditionAnchorById: Record<string, string>;
            lastPhysicalMergeSnapshot: unknown;
        },
    ) {
        const snapshot: TokenTrailModeSnapshot = {
            drawnElements: this.cloneDrawnElements(this.drawnElements()),
            connections: this.cloneConnections(this.connections()),
            conditionCounter: this.conditionCounter,
            releasedConditionNumbers: new Set(this.releasedConditionNumbers),
            elementIdCounter: this.elementIdCounter,
            connectionIdCounter: this.connectionIdCounter,
            showingSolution: this.showingSolution(),
            solvedTokenTrails: new Map(this.solvedTokenTrails()),
            solutionCache: this.solutionCache ? new Map(this.solutionCache) : null,
            selectedPetriPlaceId: this.selectedPetriPlaceId(),
            mergeState,
        };

        if (mode === 'puzzle') {
            this.puzzleSnapshot = snapshot;
        } else {
            this.constructionSnapshot = snapshot;
        }
    }

    hasSnapshot(mode: 'puzzle' | 'construction'): boolean {
        return (mode === 'puzzle' ? this.puzzleSnapshot : this.constructionSnapshot) !== null;
    }

    restoreSnapshot(mode: 'puzzle' | 'construction'):
        | {
              mergedConditionAnchorById: Record<string, string>;
              lastPhysicalMergeSnapshot: unknown;
          }
        | undefined {
        const snapshot = mode === 'puzzle' ? this.puzzleSnapshot : this.constructionSnapshot;
        if (!snapshot) {
            return undefined;
        }

        this.drawnElements.set(this.cloneDrawnElements(snapshot.drawnElements));
        this.connections.set(this.cloneConnections(snapshot.connections));
        this.conditionCounter = snapshot.conditionCounter;
        this.releasedConditionNumbers = new Set(snapshot.releasedConditionNumbers);
        this.elementIdCounter = snapshot.elementIdCounter;
        this.connectionIdCounter = snapshot.connectionIdCounter;
        this.showingSolution.set(snapshot.showingSolution);
        this.solvedTokenTrails.set(new Map(snapshot.solvedTokenTrails));
        this.solutionCache = snapshot.solutionCache ? new Map(snapshot.solutionCache) : null;
        this.selectedPetriPlaceId.set(snapshot.selectedPetriPlaceId);

        return snapshot.mergeState;
    }

    clearSnapshots() {
        this.puzzleSnapshot = null;
        this.constructionSnapshot = null;
    }
}
