import { Coords } from '../json-petri-net';
import { DiagramNode } from './diagram-node';

export interface DrawnElement {
    node: DiagramNode;
    id: string;
}

export interface Connection {
    id: string;
    aId: string;
    bId: string;
    weight: number;
    bendPoints?: Coords[];
}
