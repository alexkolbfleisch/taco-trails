import { Injectable } from '@angular/core';
import { Diagram } from '../classes/diagram/diagram';
import { JsonPetriNet } from '../classes/json-petri-net';
import { DiagramPlace } from '../classes/diagram/diagram-place';
import { DiagramTransition } from '../classes/diagram/diagram-transition';
import { DiagramArc } from '../classes/diagram/diagram-arc';
import { XMLBuilder } from 'fast-xml-parser';
import { PnmlArc, PnmlPlace, PnmlPosition, PnmlTransition } from '../classes/pnml-petri-net';

import { Condition, Event as LabeledEvent, LabeledNetEdge, LabeledNetNode } from '../classes/labeled-net.model';

export type SUPPORTED_FORMAT = 'pnml' | 'json';

const formatTupleSet = (items: string[]) => `{${items.join(', ')}}`;

@Injectable({
    providedIn: 'root',
})
export class SerializationService {
    public serialize(diagram: Diagram, format: SUPPORTED_FORMAT): string {
        switch (format) {
            case 'json':
                return this.serializeJson(diagram);
            case 'pnml':
                return this._serializePnml(diagram);
            default:
                throw new Error(`Unsupported format: ${format}`);
        }
    }

    public serializeLpn(
        drawnElements: LabeledNetNode[],
        connections: LabeledNetEdge[],
        format: SUPPORTED_FORMAT,
    ): string {
        const places = drawnElements.filter((el): el is Condition => el instanceof Condition);
        const transitions = drawnElements.filter((el): el is LabeledEvent => el instanceof LabeledEvent);
        const arcs = connections.map((c) => new DiagramArc(c.id, c.source, c.target, c.weight, c.bendPoints));

        const diagram = new Diagram(places, transitions, arcs);
        return this.serialize(diagram, format);
    }

    public serializeTuple(diagram: Diagram): string {
        const placeLabelMap = new Map(diagram.places.map((p) => [p.id, p.label ?? p.displayLabel ?? p.id]));
        const transitionLabelMap = new Map(diagram.transitions.map((t) => [t.id, t.label ?? t.displayLabel ?? t.id]));

        const placeLabels = formatTupleSet(Array.from(placeLabelMap.values()));
        const transitionLabels = formatTupleSet(Array.from(transitionLabelMap.values()));

        const arcs = diagram.arcs
            .map((arc) => {
                const src = placeLabelMap.get(arc.source) ?? transitionLabelMap.get(arc.source) ?? arc.source;
                const tgt = placeLabelMap.get(arc.target) ?? transitionLabelMap.get(arc.target) ?? arc.target;
                const weightPart = arc.weight !== 1 ? `${arc.weight}*` : '';
                return `${weightPart}(${src}, ${tgt})`;
            })
            .join(' + ');

        const markingParts = diagram.places
            .map((p) => {
                const label = placeLabelMap.get(p.id) ?? p.id;
                const tokens = p.tokenCount();
                if (!tokens) return '';
                return tokens === 1 ? label : `${tokens}*${label}`;
            })
            .filter((m) => m.length > 0);
        const marking = markingParts.join(' + ');

        return `(${placeLabels}, ${transitionLabels}, ${arcs}, ${marking})`;
    }

    /**
     * Serializes a 'Diagram'-object back into a JSON-string
     * compatible with the 'JsonPetriNet'-format.
     */
    public serializeJson(diagram: Diagram): string {
        const rawNet: JsonPetriNet = {
            places: [],
            transitions: [],
            arcs: {},
            actions: [],
            marking: {},
            labels: {},
            layout: {},
        };

        this._serializePlaces(diagram.places, rawNet);
        this._serializeTransitions(diagram.transitions, rawNet);
        this._serializeArcs(diagram.arcs, rawNet);

        return JSON.stringify(rawNet, null, 2);
    }

    /**
     * Populates places, marking, and layout data for places.
     */
    private _serializePlaces(places: DiagramPlace[], rawNet: JsonPetriNet): void {
        for (const place of places) {
            rawNet.places.push(place.id);
            rawNet.labels = rawNet.labels ?? {};
            if (place.label !== place.id) {
                rawNet.labels[place.id] = place.label || place.id;
            }
            rawNet.layout = rawNet.layout ?? {};
            rawNet.layout[place.id] = { x: place.x, y: place.y };

            if (place.tokenCount() > 0) {
                rawNet.marking = rawNet.marking ?? {};
                rawNet.marking[place.id] = place.tokenCount();
            }
        }
    }

    /**
     * Populates transitions, labels, and layout data for transitions.
     */
    private _serializeTransitions(transitions: DiagramTransition[], rawNet: JsonPetriNet): void {
        for (const transition of transitions) {
            rawNet.transitions.push(transition.id);
            rawNet.layout = rawNet.layout ?? {};
            rawNet.layout[transition.id] = { x: transition.x, y: transition.y };

            if (transition.label !== transition.id) {
                rawNet.labels = rawNet.labels ?? {};
                rawNet.labels[transition.id] = transition.label;
                rawNet.actions = rawNet.actions ?? [];
                rawNet.actions.push(transition.label);
            }
        }
    }

    /**
     * Populates arcs and layout data for arc bend points.
     */
    private _serializeArcs(arcs: DiagramArc[], rawNet: JsonPetriNet): void {
        if (arcs.length === 0) return;

        if (!rawNet.arcs) {
            rawNet.arcs = {};
        }

        for (const arc of arcs) {
            const id = `${arc.source},${arc.target}`;
            rawNet.arcs[id] = arc.weight;

            if (arc.bendPoints && arc.bendPoints.length > 0) {
                rawNet.layout = rawNet.layout ?? {};
                rawNet.layout[id] = arc.bendPoints;
            }
        }
    }

    private _serializePnml(diagram: Diagram): string {
        const builder = new XMLBuilder({
            ignoreAttributes: false,
            format: true,
            suppressEmptyNode: true,
        });

        const pnmlObj = {
            pnml: {
                net: {
                    '@_id': `noID-${Date.now()}`,
                    '@_type': 'http://www.informatik.hu-berlin.de/top/pntd/ptNetb',
                    place: diagram.places.map((p) => this._mapPlaceToPnml(p)),
                    transition: diagram.transitions.map((t) => this._mapTransitionToPnml(t)),
                    arc: diagram.arcs.map((a) => this._mapArcToPnml(a)),
                },
            },
        };

        return '<?xml version="1.0" encoding="UTF-8"?>\n' + builder.build(pnmlObj);
    }

    private _mapPlaceToPnml(place: DiagramPlace): PnmlPlace {
        return {
            '@_id': place.id,
            name: {
                text: place.label || place.id,
            },
            graphics: {
                position: {
                    '@_x': place.x,
                    '@_y': place.y,
                },
            },
            initialMarking: {
                text: place.tokenCount(),
            },
        };
    }

    private _mapTransitionToPnml(transition: DiagramTransition): PnmlTransition {
        return {
            '@_id': transition.id,
            graphics: {
                position: {
                    '@_x': transition.x,
                    '@_y': transition.y,
                },
            },
            name: {
                text: transition.label,
            },
        };
    }

    private _mapArcToPnml(arc: DiagramArc): PnmlArc {
        const arcObj: PnmlArc = {
            '@_id': arc.id,
            '@_source': arc.source,
            '@_target': arc.target,
            inscription: {
                text: arc.weight,
            },
            graphics: {},
        };

        if (arc.bendPoints && arc.bendPoints.length > 0) {
            arcObj.graphics.position = arc.bendPoints.map(
                (bp): PnmlPosition => ({
                    '@_x': bp.x,
                    '@_y': bp.y,
                }),
            );
        }

        return arcObj;
    }
}
