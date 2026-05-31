import { inject, Injectable } from '@angular/core';

import { Diagram } from '../classes/diagram/diagram';
import { DiagramNode } from '../classes/diagram/diagram-node';
import { DiagramArc } from '../classes/diagram/diagram-arc';
import { Coords, JsonPetriNet } from '../classes/json-petri-net';
import { DiagramPlace } from '../classes/diagram/diagram-place';
import { DiagramTransition } from '../classes/diagram/diagram-transition';
import { XMLParser } from 'fast-xml-parser';
import { Pnml, PnmlArc, PnmlNetContent, PnmlPlace, PnmlPtnet, PnmlTransition } from '../classes/pnml-petri-net';
import { PanningService } from './panning.service';

@Injectable({
    providedIn: 'root',
})
export class ParserService {
    private readonly PNML_PTNET_TYPE = 'http://www.pnml.org/version-2009/grammar/ptnet';
    private _panningService = inject(PanningService);
    /**
     * Parses the given text into a Diagram object.
     * Supports PNML (XML format) and JSON format.
     * @param text the text representing the Petri net
     */
    parse(text: string): Diagram | undefined {
        const trimmedText = text.trim();
        if (trimmedText.startsWith('<')) {
            return this.parsePnml(trimmedText);
        } else if (trimmedText.startsWith('{')) {
            return this.parseJson(trimmedText);
        } else if (trimmedText.startsWith('(')) {
            return this.parseTuple(trimmedText);
        }
        console.error('Unknown file format');
        return undefined;
    }

    /**
     * Parses the given PNML text into a Diagram object.
     * @param text the PNML text representing the Petri net
     */
    parsePnml(text: string): Diagram | undefined {
        try {
            const alwaysArray = ['place', 'transition', 'arc'];
            const parser = new XMLParser({
                ignoreAttributes: false,
                isArray: (tagName) => alwaysArray.includes(tagName),
            });
            const pnmlObject = parser.parse(text) as Pnml;

            const net = pnmlObject.pnml?.net;
            let netContent: PnmlNetContent | undefined;
            if (net?.['@_type'] === this.PNML_PTNET_TYPE) {
                netContent = (net as PnmlPtnet).page;
            } else {
                netContent = net as PnmlNetContent;
            }

            const arcs: DiagramArc[] = this.parsePnmlArcs(netContent?.arc ?? []);
            const places: DiagramPlace[] = this.parsePnmlPlaces(netContent?.place ?? []);
            const transitions: DiagramTransition[] = this.parsePnmlTransitions(
                netContent?.transition ?? [],
                arcs,
                places,
            );

            return new Diagram(places, transitions, arcs);
        } catch (e) {
            console.error('Error while parsing PNML', e, text);
            return undefined;
        }
    }

    /**
     * Parses the given JSON text into a Diagram object.
     * @param text the JSON text representing the Petri net
     */
    parseJson(text: string): Diagram | undefined {
        try {
            const rawData = JSON.parse(text) as JsonPetriNet;

            const marking = rawData.marking || {};
            const labels = rawData.labels || {};
            const lpnStartPlacesSet = rawData.lpnStartPlaces ? new Set<string>(rawData.lpnStartPlaces) : undefined;
            const places = this.parsePlaces(rawData.places, marking, labels, lpnStartPlacesSet);
            const arcs = this.parseArcs(rawData.arcs, rawData.layout);
            const transitions = this.parseTransitions(rawData.transitions, labels, places, arcs);

            const allNodes = [...places, ...transitions];
            this.setPosition(allNodes, rawData.layout);

            return new Diagram(places, transitions, arcs);
        } catch (e) {
            console.error('Error while parsing JSON', e, text);
            return undefined;
        }
    }

    private parsePlaces(
        placeIds: string[] | undefined,
        marking: Record<string, number>,
        labels: Record<string, string>,
        lpnStartPlacesSet?: Set<string>,
    ): DiagramPlace[] {
        if (!placeIds || !Array.isArray(placeIds)) {
            return [];
        }
        return placeIds.map((id) => {
            const initialTokens = marking[id] || 0;
            const label = labels[id] || id;
            const isStart = lpnStartPlacesSet?.has(id) ?? false;
            return new DiagramPlace(id, initialTokens, label, {
                isStartPlace: isStart,
            });
        });
    }

    private parseTransitions(
        transitionIds: string[] | undefined,
        labels: Record<string, string>,
        places: DiagramPlace[],
        arcs: DiagramArc[],
    ): DiagramTransition[] {
        if (!transitionIds || !Array.isArray(transitionIds)) {
            return [];
        }

        return transitionIds.map((id) => {
            const label = labels[id] || id;

            const { inputArcs, outputArcs, inputPlaces, outputPlaces } = this.findInAndOutput(arcs, id, places);

            return new DiagramTransition(id, label, inputPlaces, outputPlaces, inputArcs, outputArcs);
        });
    }

    private parseArcs(arcs: Record<string, number> | undefined, layout: JsonPetriNet['layout']): DiagramArc[] {
        if (!arcs) {
            return [];
        }
        const result: DiagramArc[] = [];
        for (const [arcId, weight] of Object.entries(arcs)) {
            const [source, target] = arcId.split(',');
            if (source && target) {
                const bendPoints = this.getBendPoints(arcId, layout);

                result.push(new DiagramArc(arcId, source, target, weight, bendPoints));
            }
        }
        return result;
    }

    private getBendPoints(arcId: string, layout: JsonPetriNet['layout']): Coords[] {
        if (!layout || !layout[arcId]) {
            return [];
        }

        const layoutData = layout[arcId];
        if (Array.isArray(layoutData)) {
            return layoutData;
        }

        return [];
    }

    private setPosition(elements: DiagramNode[], layout: JsonPetriNet['layout']) {
        if (layout === undefined) {
            return;
        }

        for (const el of elements) {
            const pos = layout[el.id] as Coords | undefined;
            if (pos !== undefined) {
                el.x = pos.x;
                el.y = pos.y;
            }
        }
    }

    private parsePnmlTransitions(transitions: PnmlTransition[], arcs: DiagramArc[], places: DiagramPlace[]) {
        return transitions.map((transition) => {
            const id = transition['@_id'];
            const label = transition.name?.text || id;

            const { inputArcs, outputArcs, inputPlaces, outputPlaces } = this.findInAndOutput(arcs, id, places);

            const diagramTransition = new DiagramTransition(
                id,
                label,
                inputPlaces,
                outputPlaces,
                inputArcs,
                outputArcs,
            );
            diagramTransition.x = Number(transition.graphics.position['@_x']);
            diagramTransition.y = Number(transition.graphics.position['@_y']);
            return diagramTransition;
        });
    }

    private findInAndOutput(arcs: DiagramArc[], id: string, places: DiagramPlace[]) {
        const inputArcs = arcs.filter((arc) => arc.target === id);
        const outputArcs = arcs.filter((arc) => arc.source === id);

        const inputPlaces = inputArcs
            .map((arc) => places.find((place) => place.id === arc.source))
            .filter((place): place is DiagramPlace => place !== undefined);
        const outputPlaces = outputArcs
            .map((arc) => places.find((place) => place.id === arc.target))
            .filter((place): place is DiagramPlace => place !== undefined);
        return { inputArcs, outputArcs, inputPlaces, outputPlaces };
    }

    private parsePnmlArcs(arcs: PnmlArc[]) {
        return arcs.map((arc) => {
            const id = arc['@_id'];
            const source = arc['@_source'];
            const target = arc['@_target'];
            const weight = arc.inscription && arc.inscription.text ? Number(arc.inscription.text) : 1;
            const position = arc.graphics.position;
            let bendPoints: Coords[] = [];
            if (position) {
                const positionArray = Array.isArray(position) ? position : [position];
                bendPoints = positionArray.map((pos) => {
                    return {
                        x: Number(pos['@_x']),
                        y: Number(pos['@_y']),
                    };
                });
            }
            return new DiagramArc(id, source, target, weight, bendPoints);
        });
    }

    private parsePnmlPlaces(places: PnmlPlace[]) {
        return places.map((place) => {
            const id = place['@_id'];
            const initialMarking = place.initialMarking ? Number(place.initialMarking.text) : 0;
            const label = place.name?.text || id;
            const diagramPlace = new DiagramPlace(id, initialMarking, label);
            diagramPlace.x = Number(place.graphics.position['@_x']);
            diagramPlace.y = Number(place.graphics.position['@_y']);
            return diagramPlace;
        });
    }

    /**
     * Parses the given Tuple text into a Diagram object.
     * @param text the Tuple text representing the Petri net
     */
    parseTuple(text: string): Diagram | undefined {
        try {
            const { placesStr, transitionsStr, arcsStr, markingStr } = this.extractTupleParts(text);

            const placeIds = this.parseSet(placesStr);
            const transitionIds = this.parseSet(transitionsStr);
            const marking = this.parseTupleMarking(markingStr);

            const diagramPlaces = this.createDiagramPlaces(placeIds, marking);
            const diagramArcs = this.parseTupleArcs(arcsStr);
            const diagramTransitions = this.createDiagramTransitions(transitionIds, diagramArcs, diagramPlaces);

            const allNodes = [...diagramPlaces, ...diagramTransitions];
            this.applyInitialLayout(allNodes);

            return new Diagram(diagramPlaces, diagramTransitions, diagramArcs);
        } catch (e) {
            console.error('Error while parsing Tuple', e, text);
            return undefined;
        }
    }

    /**
     * Extracts the parts of the tuple string (places, transitions, arcs, marking).
     * @param text the tuple string
     * @returns an object containing the parts as strings
     */
    private extractTupleParts(text: string): {
        placesStr: string;
        transitionsStr: string;
        arcsStr: string;
        markingStr: string;
    } {
        const inner = text.trim().slice(1, -1);

        const placesEndIndex = inner.indexOf('},');
        if (placesEndIndex === -1) {
            throw new Error('Invalid tuple format: missing places set');
        }
        const placesStr = inner.substring(0, placesEndIndex + 1);

        const rest1 = inner.substring(placesEndIndex + 2).trim();
        const transitionsEndIndex = rest1.indexOf('},');
        if (transitionsEndIndex === -1) {
            throw new Error('Invalid tuple format: missing transitions set');
        }
        const transitionsStr = rest1.substring(0, transitionsEndIndex + 1);

        const rest2 = rest1.substring(transitionsEndIndex + 2).trim();

        let splitIndex = -1;
        let parenLevel = 0;
        for (let i = 0; i < rest2.length; i++) {
            if (rest2[i] === '(') parenLevel++;
            else if (rest2[i] === ')') parenLevel--;
            else if (rest2[i] === ',' && parenLevel === 0) {
                splitIndex = i;
                break;
            }
        }

        let arcsStr: string;
        let markingStr: string;

        if (splitIndex === -1) {
            arcsStr = rest2;
            markingStr = '';
        } else {
            arcsStr = rest2.substring(0, splitIndex).trim();
            markingStr = rest2.substring(splitIndex + 1).trim();
        }

        return { placesStr, transitionsStr, arcsStr, markingStr };
    }

    /**
     * Parses a set string like "{a, b, c}" into an array of strings.
     * @param text the set string
     * @returns an array of strings
     */
    private parseSet(text: string): string[] {
        const content = text.trim().slice(1, -1);
        return content
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
    }

    /**
     * Parses the marking string into a record of place IDs and their token counts.
     * @param markingStr the marking string
     * @returns a record of place IDs and token counts
     */
    private parseTupleMarking(markingStr: string): Record<string, number> {
        const marking: Record<string, number> = {};
        if (markingStr.trim().length > 0) {
            const markingParts = markingStr.split('+').map((s) => s.trim());
            for (const part of markingParts) {
                let count = 1;
                let placeId = part;
                if (part.includes('*')) {
                    const [c, p] = part.split('*');
                    count = parseInt(c.trim(), 10);
                    placeId = p.trim();
                } else if (part.includes('⋅')) {
                    const [c, p] = part.split('⋅');
                    count = parseInt(c.trim(), 10);
                    placeId = p.trim();
                }

                if (isNaN(count)) {
                    throw new Error(`Invalid marking weight for place '${placeId}'`);
                }

                marking[placeId] = (marking[placeId] || 0) + count;
            }
        }
        return marking;
    }

    /**
     * Creates DiagramPlace objects from place IDs and marking.
     * @param placeIds the place IDs
     * @param marking the marking record
     * @returns an array of DiagramPlace objects
     */
    private createDiagramPlaces(placeIds: string[], marking: Record<string, number>): DiagramPlace[] {
        return placeIds.map((id) => new DiagramPlace(id, marking[id] || 0, id));
    }

    /**
     * Parses the arcs string into DiagramArc objects.
     * @param arcsStr the arcs string
     * @returns an array of DiagramArc objects
     */
    private parseTupleArcs(arcsStr: string): DiagramArc[] {
        const diagramArcs: DiagramArc[] = [];
        if (arcsStr.length > 0) {
            const arcParts = arcsStr.split('+').map((s) => s.trim());
            arcParts.forEach((part, index) => {
                let weight = 1;
                let tuplePart = part;

                if (part.includes('*')) {
                    const [w, t] = part.split('*');
                    weight = parseInt(w.trim(), 10);
                    tuplePart = t.trim();
                } else if (part.includes('⋅')) {
                    const [w, t] = part.split('⋅');
                    weight = parseInt(w.trim(), 10);
                    tuplePart = t.trim();
                }

                if (isNaN(weight)) {
                    throw new Error(`Invalid arc weight in '${part}'`);
                }

                if (tuplePart.startsWith('(') && tuplePart.endsWith(')')) {
                    const content = tuplePart.slice(1, -1);
                    const [source, target] = content.split(',').map((s) => s.trim());
                    if (source && target) {
                        diagramArcs.push(new DiagramArc(`arc${index}`, source, target, weight));
                    }
                }
            });
        }
        return diagramArcs;
    }

    /**
     * Creates DiagramTransition objects from transition IDs, arcs, and places.
     * @param transitionIds the transition IDs
     * @param arcs the diagram arcs
     * @param places the diagram places
     * @returns an array of DiagramTransition objects
     */
    private createDiagramTransitions(
        transitionIds: string[],
        arcs: DiagramArc[],
        places: DiagramPlace[],
    ): DiagramTransition[] {
        return transitionIds.map((id) => {
            const { inputArcs, outputArcs, inputPlaces, outputPlaces } = this.findInAndOutput(arcs, id, places);
            return new DiagramTransition(id, id, inputPlaces, outputPlaces, inputArcs, outputArcs);
        });
    }

    private applyInitialLayout(nodes: DiagramNode[]) {
        const viewBox = this._panningService.viewBox();
        const width = Math.max(viewBox.width, 400);
        const height = Math.max(viewBox.height, 300);
        const startX = viewBox.minX;
        const startY = viewBox.minY;

        nodes.forEach((node) => {
            node.x = startX + Math.random() * width;
            node.y = startY + Math.random() * height;
        });
    }
}
