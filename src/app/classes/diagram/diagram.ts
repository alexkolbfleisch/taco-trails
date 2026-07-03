import { DiagramArc } from './diagram-arc';
import { DiagramPlace } from './diagram-place';
import { DiagramTransition } from './diagram-transition';
import { DisplayableEdge, DisplayableGraph, DisplayableNode } from '../displayable-graph.interface';
import { BehaviorSubject } from 'rxjs';

export class Diagram implements DisplayableGraph {
    private readonly _places: DiagramPlace[];
    private readonly _transitions: DiagramTransition[];
    private readonly _arcs: DiagramArc[];
    private readonly _startMarking: Record<string, number>;

    private _markingChanged$ = new BehaviorSubject<Record<string, number>>({});

    /**
     * Observable that emits the current marking of the diagram whenever it changes.
     */
    public currentMarking$ = this._markingChanged$.asObservable();

    constructor(places: DiagramPlace[] = [], transitions: DiagramTransition[] = [], arcs: DiagramArc[] = []) {
        this._places = places;
        this._transitions = transitions;
        this._arcs = arcs;
        this._startMarking = this.marking;
        this.updateMarking();
    }

    get places(): DiagramPlace[] {
        return this._places;
    }

    get arcs(): DiagramArc[] {
        return this._arcs;
    }

    get transitions(): DiagramTransition[] {
        return this._transitions;
    }

    get allNodes(): (DiagramPlace | DiagramTransition)[] {
        return [...this._places, ...this._transitions];
    }

    /**
     * Returns the current marking of the diagram as a mapping from place IDs to token counts.
     */
    get marking(): Record<string, number> {
        const marking: Record<string, number> = {};
        this._places.forEach((place) => {
            marking[place.id] = place.tokenCount();
        });
        return marking;
    }

    /**
     * Sets the marking of the diagram based on the provided mapping from place IDs to token counts.
     * @param marking
     *          The new marking to be set.
     */
    set marking(marking: Record<string, number>) {
        this._places.forEach((place) => {
            place.tokens = marking[place.id] || 0;
        });
        this.updateMarking();
    }

    get startMarking(): Record<string, number> {
        return this._startMarking;
    }

    /**
     * Updates the current marking and notifies subscribers.
     */
    updateMarking(): void {
        const newMarking = this.marking;
        this._markingChanged$.next(newMarking);
    }

    /**
     * Resets the marking of the diagram to the start marking.
     */
    resetMarking(): void {
        this._places.forEach((place) => {
            const startTokens = this._startMarking[place.id] || 0;
            place.tokens = startTokens;
        });
        this.updateMarking();
    }

    getNodes(): DisplayableNode[] {
        return this.allNodes;
    }

    getEdges(): DisplayableEdge[] {
        return this._arcs;
    }

    getTransitionByLabel(label: string): DiagramTransition | undefined {
        return this._transitions.find((t) => t.label === label || t.id === label);
    }

    getTransitionLabels(): string[] {
        return this._transitions.map((t) => t.label || t.id) || [];
    }

    public static getSignature(net: Diagram | null): string {
        if (!net) return '';
        const nodes = net.allNodes
            .map((n) => `${n.id}:${n.label ?? n.displayLabel ?? n.id}`)
            .sort()
            .join('|');
        const markings = Object.entries(net.startMarking ?? {})
            .map(([placeId, tokenCount]) => `${placeId}:${tokenCount}`)
            .sort()
            .join('|');
        const edges = net.arcs
            .map((a) => `${a.source}->${a.target}:${a.weight || 1}`)
            .sort()
            .join('|');
        return `${nodes}::${markings}::${edges}`;
    }
}
