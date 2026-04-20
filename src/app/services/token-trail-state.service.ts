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
    readonly validPetriPlaceIds = signal<Set<string>>(new Set<string>());

    readonly displayMode = signal<'puzzle' | 'construction'>('puzzle');

    private readonly _fitViewRequest$ = new Subject<void>();
    public readonly fitViewRequest$ = this._fitViewRequest$.asObservable();

    addDrawnElement(element: LabeledNetNode) {
        this.drawnElements.update((el) => [...el, element]);
    }

    addConnection(connection: LabeledNetEdge) {
        this.connections.update((c) => [...c, connection]);
    }

    removeDrawnElement(id: string) {
        this.drawnElements.update((elements) => elements.filter((e) => e.id !== id));
        this.connections.update((connections) => connections.filter((c) => c.source !== id && c.target !== id));
    }

    removeConnection(id: string) {
        this.connections.update((connections) => connections.filter((c) => c.id !== id));
    }

    updateDrawnElements(updater: (elements: LabeledNetNode[]) => LabeledNetNode[]) {
        this.drawnElements.update(updater);
    }

    updateConnections(updater: (connections: LabeledNetEdge[]) => LabeledNetEdge[]) {
        this.connections.update(updater);
    }

    clear() {
        this.drawnElements.set([]);
        this.connections.set([]);
        this.selectedPetriPlaceId.set(null);
        this.validPetriPlaceIds.set(new Set<string>());
        this.elementIdCounter = 0;
        this.connectionIdCounter = 0;
        this.conditionCounter = 0;
        this.releasedConditionNumbers.clear();
    }

    setSelectedPetriPlaceId(placeId: string | null) {
        this.selectedPetriPlaceId.set(placeId);
    }

    setValidPetriPlaceIds(placeIds: Set<string>) {
        this.validPetriPlaceIds.set(placeIds);
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
}
