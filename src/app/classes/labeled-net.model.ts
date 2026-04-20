import { DiagramPlace } from './diagram/diagram-place';
import { DiagramTransition } from './diagram/diagram-transition';
import { DisplayableEdge, DisplayableGraph, DisplayableNode } from './displayable-graph.interface';

export class Condition extends DiagramPlace {
    // Initial name assigned to the Condition before it holds any trails (e.g. 'c1')
    baseName?: string;

    // Maps original Petri net place IDs to the number of tokens in this condition for that trail.
    trailMarkings: Record<string, number> = {};

    setTrailTokens(petriPlaceId: string, count: number): void {
        if (!this.baseName) {
            this.baseName = this.label;
        }

        if (count > 0) {
            this.trailMarkings[petriPlaceId] = count;
        } else {
            delete this.trailMarkings[petriPlaceId];
        }

        this.updateDynamicLabel();
    }

    getTrailTokens(petriPlaceId: string): number {
        return this.trailMarkings[petriPlaceId] || 0;
    }

    updateDynamicLabel(): void {
        if (!this.baseName) {
            this.baseName = this.label;
        }

        const parts: string[] = [];
        // Generate sorted array of places to ensure consistent label formatting (e.g. 'p1 + p2' instead of 'p2 + p1')
        const sortedPlaces = Object.keys(this.trailMarkings).sort((a, b) =>
            a.localeCompare(b, undefined, { numeric: true }),
        );

        for (const place of sortedPlaces) {
            const count = this.trailMarkings[place];
            if (count === 1) {
                parts.push(place);
            } else if (count > 1) {
                parts.push(`${count}*${place}`);
            }
        }

        this.label = parts.length > 0 ? parts.join(' + ') : this.baseName;
    }
}

export class Event extends DiagramTransition {
    transitionId: string;

    constructor(id: string, label: string, transitionId: string) {
        super(id, label);
        this.transitionId = transitionId;
    }
}

export type LabeledNetNode = Condition | Event;

export class LabeledNetEdge implements DisplayableEdge {
    id: string;
    source: string;
    target: string;
    weight: number;
    bendPoints: { x: number; y: number }[] = [];
    displayLabel = '';

    constructor(id: string, source: string, target: string, weight = 1) {
        this.id = id;
        this.source = source;
        this.target = target;
        this.weight = weight;
    }
}

export class LabeledNetGraph implements DisplayableGraph {
    nodes: LabeledNetNode[] = [];
    edges: LabeledNetEdge[] = [];

    getNodes(): DisplayableNode[] {
        return this.nodes;
    }

    getEdges(): DisplayableEdge[] {
        return this.edges;
    }
}
