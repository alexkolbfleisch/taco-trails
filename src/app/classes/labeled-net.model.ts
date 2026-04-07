import { DiagramPlace } from './diagram/diagram-place';
import { DiagramTransition } from './diagram/diagram-transition';
import { DisplayableEdge, DisplayableGraph, DisplayableNode } from './displayable-graph.interface';

export class Condition extends DiagramPlace {
    // We can add additional properties here if needed.
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
