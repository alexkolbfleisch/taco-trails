import { inject, Injectable } from '@angular/core';
import { PlayService } from './play.service';
import { PlayValidationService } from './play-validation.service';
import { PetriNetRegionSynthesisService } from '../../../ilpn-components/src/lib/algorithms/pn/regions/petri-net-region-synthesis.service';
import { LpnGenerationDifficulty, TokenTrailStateService } from './token-trail-state.service';
import { SugiyamaService } from './sugiyama.service';
import { FiringEntry } from '../classes/firing-entry';
import { PetriNet as IlpnPetriNet } from '../../../ilpn-components/src/lib/models/pn/model/petri-net';
import { Place as IlpnPlace } from '../../../ilpn-components/src/lib/models/pn/model/place';
import { Transition as IlpnTransition } from '../../../ilpn-components/src/lib/models/pn/model/transition';
import { Diagram } from '../classes/diagram/diagram';
import { LabeledNetEdge } from '../classes/labeled-net.model';
import { PanningService } from './panning.service';
import { ModeService } from './mode.service';
import { Tab } from '../classes/tabs';
import { DIFFICULTY_CONFIGURATIONS } from './token-trail-lpn.config';

@Injectable({
    providedIn: 'root',
})
export class TokenTrailLpnService {
    private playService = inject(PlayService);
    private playValidationService = inject(PlayValidationService);
    private regionSynthesisService = inject(PetriNetRegionSynthesisService);
    private stateService = inject(TokenTrailStateService);
    private sugiyamaService = inject(SugiyamaService);
    private panningService = inject(PanningService);
    private modeService = inject(ModeService);
    private _lastSelectedEntriesHash = '';

    /**
     * Synthesizes a new Labeled Petri Net (LPN) based on traces derived from the source Petri net
     * using region synthesis algorithms. Automatically adjusts parameters based on the generation difficulty.
     *
     * @param sourceNet The original Petri net diagram to synthesize the LPN from.
     * @param overrideDifficulty Optional difficulty level to override the default setting.
     */
    public createLPNWithSynthesis(sourceNet: Diagram, overrideDifficulty?: LpnGenerationDifficulty) {
        let difficulty = overrideDifficulty;
        if (!difficulty) {
            difficulty = this.modeService.isExamMode(Tab.TOKEN_TRAIL) ? 'hard' : 'easy';
        }
        this.stateService.setLpnGenerationDifficulty(difficulty);

        const config = DIFFICULTY_CONFIGURATIONS[difficulty];
        const nodeCount = sourceNet.allNodes.length;
        const maxTraceLength = Math.max(3, Math.floor(nodeCount * config.traceLengthMultiplier));
        const maxTraces = Math.max(1, Math.floor(nodeCount * config.maxTracesMultiplier));
        const maxEdges = Math.max(5, Math.floor(nodeCount * config.maxEdgesMultiplier));

        this.playService.firingEntries.set([]);
        this.playValidationService.findSequences(sourceNet, 1, maxTraceLength);

        const entries = this.playService.firingEntries();
        const validEntries = entries.filter((entry) => entry.isValid && entry.labels.length > 0);

        if (validEntries.length === 0) return;

        const selectedEntries = this._selectEntriesWithVariation(validEntries, maxTraces);
        const inputNets: IlpnPetriNet[] = [];

        const splittingProbability = config.splittingProbability;

        for (const entry of selectedEntries) {
            const net = new IlpnPetriNet();
            let lastPlace = new IlpnPlace();
            lastPlace.marking = 1;
            net.addPlace(lastPlace);

            const labelCounts = new Map<string, number>();
            let hasDuplicates = false;
            for (const label of entry.labels) {
                const count = (labelCounts.get(label) || 0) + 1;
                labelCounts.set(label, count);
                if (count > 1) {
                    hasDuplicates = true;
                }
            }

            const applySplitting = hasDuplicates && Math.random() < splittingProbability;
            const currentOccurrence = new Map<string, number>();

            for (const label of entry.labels) {
                let finalLabel = label;
                if (applySplitting) {
                    const occ = (currentOccurrence.get(label) || 0) + 1;
                    currentOccurrence.set(label, occ);
                    if (labelCounts.get(label)! > 1) {
                        finalLabel = `${label}_instance${occ}`;
                    }
                }

                const t = new IlpnTransition(finalLabel);
                net.addTransition(t);
                net.addArc(lastPlace, t);

                const nextPlace = new IlpnPlace();
                net.addPlace(nextPlace);
                net.addArc(t, nextPlace);

                lastPlace = nextPlace;
            }
            inputNets.push(net);
        }

        this.regionSynthesisService.synthesise(inputNets, config.synthesisConfig).subscribe((result) => {
            this.renderMinedNet(result.result, maxEdges);
        });
    }

    /**
     * Selects a subset of unique firing entries, shuffling and using a hash check to ensure variation
     * in the synthesized traces compared to the last selection.
     *
     * @param validEntries The list of valid firing sequences.
     * @param maxTraces The maximum number of traces to select.
     * @returns A subset of firing entries.
     */
    private _selectEntriesWithVariation(validEntries: FiringEntry[], maxTraces: number): FiringEntry[] {
        let selectedEntries: FiringEntry[];
        let hash: string;
        let retries = 0;

        do {
            const shuffled = [...validEntries].sort(() => 0.5 - Math.random());
            const subsetSize = Math.min(maxTraces, Math.max(1, Math.floor(Math.random() * shuffled.length) + 1));
            selectedEntries = shuffled.slice(0, subsetSize);

            hash = selectedEntries
                .map((e) => e.labels.join('-'))
                .sort()
                .join('|');

            retries++;
        } while (hash === this._lastSelectedEntriesHash && retries < 15 && validEntries.length > 1);

        this._lastSelectedEntriesHash = hash;
        return selectedEntries;
    }

    /**
     * Renders a synthesized/mined Petri net by mapping its places and transitions to condition
     * and event nodes, calculating their layout using Sugiyama layout, and adding them to the state service.
     *
     * @param minedNet The synthesized Petri net from the region synthesis step.
     * @param maxEdges The maximum allowed edge count before pruning complex places.
     */
    private renderMinedNet(minedNet: IlpnPetriNet, maxEdges: number) {
        this.stateService.clear();

        const placeMap = new Map<string, string>();
        const transitionMap = new Map<string, string>();

        let places = minedNet.getPlaces();

        const currentEdgeCount = places.reduce((acc, p) => acc + p.ingoingArcs.length + p.outgoingArcs.length, 0);

        if (currentEdgeCount > maxEdges && places.length > 1) {
            const shuffledPlaces = [...places].sort(() => 0.5 - Math.random());
            const filteredPlaces: typeof places = [];
            let newEdgeCount = 0;

            for (const p of shuffledPlaces) {
                const pEdges = p.ingoingArcs.length + p.outgoingArcs.length;
                if (filteredPlaces.length === 0 || newEdgeCount + pEdges <= maxEdges) {
                    filteredPlaces.push(p);
                    newEdgeCount += pEdges;
                }
            }

            if (filteredPlaces.length === 0 && shuffledPlaces.length > 0) {
                filteredPlaces.push(shuffledPlaces[0]);
            }
            places = filteredPlaces;
        }

        const connectedTransitionIds = new Set<string>();
        places.forEach((p) => {
            p.ingoingArcs.forEach((a) => {
                const sourceId = a.sourceId || (a.source as { id: string }).id;
                if (sourceId) connectedTransitionIds.add(sourceId);
            });
            p.outgoingArcs.forEach((a) => {
                const destinationId = a.destinationId || (a.destination as { id: string }).id;
                if (destinationId) connectedTransitionIds.add(destinationId);
            });
        });

        const transitions = minedNet.getTransitions().filter((t) => {
            const tId = t.id;
            return tId && connectedTransitionIds.has(tId);
        });

        const getRandomPos = () => {
            const viewBox = this.panningService.viewBox();
            const width = Math.max(viewBox.width, 800);
            const height = Math.max(viewBox.height, 600);
            return {
                x: viewBox.minX + Math.random() * width,
                y: viewBox.minY + Math.random() * height,
            };
        };

        places.forEach((p) => {
            const pId = p.id || this.stateService.generateElementId('p');
            p.id = pId;

            const uniqueId = this.stateService.generateElementId(`drawn-place`);
            placeMap.set(pId, uniqueId);

            const condition = this.stateService.buildCondition(uniqueId, pId, p.marking, {
                isStartPlace: p.marking > 0,
            });
            const pos = getRandomPos();
            condition.x = pos.x;
            condition.y = pos.y;
            this.stateService.addDrawnElement(condition);
        });

        transitions.forEach((t) => {
            const tId = t.id || this.stateService.generateElementId('t');
            t.id = tId;

            const uniqueId = this.stateService.generateElementId(`drawn-trans`);
            transitionMap.set(tId, uniqueId);

            const rawLabel = t.label ?? tId;
            const cleanLabel = rawLabel.split('__split')[0].split('_instance')[0];

            const eventNode = this.stateService.buildEvent(uniqueId, cleanLabel, cleanLabel);
            const pos = getRandomPos();
            eventNode.x = pos.x;
            eventNode.y = pos.y;
            this.stateService.addDrawnElement(eventNode);
        });

        places.forEach((p) => {
            const pId = placeMap.get(p.id!)!;
            p.outgoingArcs.forEach((a) => {
                const destinationId = a.destinationId || (a.destination as { id: string }).id;
                const tId = transitionMap.get(destinationId)!;
                if (!tId) return;
                this.stateService.addConnection(
                    new LabeledNetEdge(this.stateService.generateConnectionId('conn'), pId, tId, a.weight),
                );
            });
            p.ingoingArcs.forEach((a) => {
                const sourceId = a.sourceId || (a.source as { id: string }).id;
                const tId = transitionMap.get(sourceId)!;
                if (!tId) return;
                this.stateService.addConnection(
                    new LabeledNetEdge(this.stateService.generateConnectionId('conn'), tId, pId, a.weight),
                );
            });
        });

        this.sugiyamaService.calculateLayout(this.stateService.drawnElements(), this.stateService.connections());
        this.stateService.updateDrawnElements((e) => [...e]);
        this.stateService.updateConnections((c) => [...c]);
        this.stateService.requestFitView();
    }
}
