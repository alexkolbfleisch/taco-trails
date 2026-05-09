import { inject, Injectable } from '@angular/core';
import { PlayService } from './play.service';
import { PlayValidationService } from './play-validation.service';
import { PetriNetToPartialOrderTransformerService } from '../../../ilpn-components/src/lib/algorithms/pn/transformation/petri-net-to-partial-order-transformer.service';
import { Ilp2MinerService } from '../../../ilpn-components/src/lib/algorithms/pn/synthesis/ilp2-miner/ilp2-miner.service';
import { PetriNetRegionSynthesisService } from '../../../ilpn-components/src/lib/algorithms/pn/regions/petri-net-region-synthesis.service';
import { LpnGenerationDifficulty, TokenTrailStateService } from './token-trail-state.service';
import { SugiyamaService } from './sugiyama.service';
import { FiringEntry } from '../classes/firing-entry';
import { PetriNet as IlpnPetriNet } from '../../../ilpn-components/src/lib/models/pn/model/petri-net';
import { Place as IlpnPlace } from '../../../ilpn-components/src/lib/models/pn/model/place';
import { Transition as IlpnTransition } from '../../../ilpn-components/src/lib/models/pn/model/transition';
import { PartialOrder } from '../../../ilpn-components/src/lib/models/po/model/partial-order';
import { Diagram } from '../classes/diagram/diagram';
import { LabeledNetEdge } from '../classes/labeled-net.model';
import { PanningService } from './panning.service';
import { RegionsConfiguration } from '../../../ilpn-components/src/lib/utility/glpk/model/regions-configuration';
import { SynthesisConfiguration } from '../../../ilpn-components/src/lib/algorithms/pn/regions/classes/synthesis-configuration';
import { ModeService } from './mode.service';
import { Tab } from '../classes/tabs';

interface LpnGenerationConfiguration {
    splittingProbability: number;
    synthesisConfig: RegionsConfiguration & SynthesisConfiguration;
}

@Injectable({
    providedIn: 'root',
})
export class TokenTrailLpnService {
    private playService = inject(PlayService);
    private playValidationService = inject(PlayValidationService);
    private pnToPOTransformer = inject(PetriNetToPartialOrderTransformerService);
    private ilp2MinerService = inject(Ilp2MinerService);
    private regionSynthesisService = inject(PetriNetRegionSynthesisService);
    private stateService = inject(TokenTrailStateService);
    private sugiyamaService = inject(SugiyamaService);
    private panningService = inject(PanningService);
    private modeService = inject(ModeService);


    //TODO: this config is okay, but we need to limit the amount of nodes for the lpn otherwise it will go crazy pretty fast
    private readonly _difficultyConfigurations: Record<LpnGenerationDifficulty, LpnGenerationConfiguration> = {
        easy: {
            splittingProbability: 0.25,
            synthesisConfig: { noShortLoops: true, noArcWeights: true }
        },
        medium: {
            splittingProbability: 0.6,
            synthesisConfig: { noShortLoops: true }
        },
        hard: {
            splittingProbability: 0.5,
            synthesisConfig: {}
        }
    };

    public createNewLPN(sourceNet: Diagram) {
        this.playService.firingEntries.set([]);
        this.playValidationService.findSequences(sourceNet, 1, 15);

        const entries = this.playService.firingEntries();
        const validEntries = entries.filter((entry) => entry.isValid && entry.labels.length > 0);

        if (validEntries.length === 0) return;

        const shuffled = [...validEntries].sort(() => 0.5 - Math.random());
        const subsetSize = Math.max(1, Math.floor(Math.random() * shuffled.length) + 1);
        const selectedEntries = shuffled.slice(0, subsetSize);

        // 50% Chance für PO (ohne Loops) oder direktes Mining (mit Loops)
        const useLoopMiner = Math.random() < 0.5;

        if (useLoopMiner) {
            this.mineLoopNetDirectly(selectedEntries);
        } else {
            this.minePartialOrderNet(selectedEntries);
        }
    }

    public createLPNWithSynthesis(sourceNet: Diagram, overrideDifficulty?: LpnGenerationDifficulty) {
        this.playService.firingEntries.set([]);
        this.playValidationService.findSequences(sourceNet, 1, 15);

        const entries = this.playService.firingEntries();
        const validEntries = entries.filter((entry) => entry.isValid && entry.labels.length > 0);

        if (validEntries.length === 0) return;

        const shuffled = [...validEntries].sort(() => 0.5 - Math.random());
        const subsetSize = Math.max(1, Math.floor(Math.random() * shuffled.length) + 1);
        const selectedEntries = shuffled.slice(0, subsetSize);

        const inputNets: IlpnPetriNet[] = [];

        // Determine difficulty:
        // Use override if provided, else use current state difficulty (default medium),
        // or apply the learning/exam mode rules if not explicitly set
        let difficulty = overrideDifficulty;
        if (!difficulty) {
            difficulty = this.modeService.isExamMode(Tab.TOKEN_TRAIL) ? 'hard' : 'easy';
            this.stateService.setLpnGenerationDifficulty(difficulty);
        } else {
            this.stateService.setLpnGenerationDifficulty(difficulty);
        }

        const config = this._difficultyConfigurations[difficulty];
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
            this.renderMinedNet(result.result);
        });
    }

    private mineLoopNetDirectly(selectedEntries: FiringEntry[]) {
        const net = new IlpnPetriNet();

        // Wir merken uns Places basierend auf dem ZUSTAND (dem letzten Label)
        const statePlaces = new Map<string, IlpnPlace>();
        // Wir merken uns Transitionen basierend auf Start- und Zielzustand
        const stateTransitions = new Map<string, IlpnTransition>();

        const startPlace = new IlpnPlace();
        startPlace.marking = 1;
        // Setze eine ID falls dein Framework das intern braucht: startPlace.id = 'p_start';
        net.addPlace(startPlace);
        statePlaces.set('__start__', startPlace);

        for (const entry of selectedEntries) {
            let currentState = '__start__';

            for (const label of entry.labels) {
                const targetState = label;

                // 1. Ziel-Place für dieses Label anlegen (falls noch nicht existent)
                // Hierdurch entstehen die Loops, da bestehende Places wiederverwendet werden!
                if (!statePlaces.has(targetState)) {
                    const p = new IlpnPlace();
                    // p.id = `p_${targetState}`;
                    net.addPlace(p);
                    statePlaces.set(targetState, p);
                }

                // 2. Transition zwischen aktuellem State und Ziel anlegen
                const transitionKey = `${currentState}_to_${targetState}`;
                if (!stateTransitions.has(transitionKey)) {
                    // Hier geben wir das rohe Label ohne __split rein!
                    const t = new IlpnTransition(label);
                    // t.id = `t_${transitionKey}`;
                    net.addTransition(t);
                    stateTransitions.set(transitionKey, t);

                    // Arcs verbinden: currentState -> Transition -> targetState
                    net.addArc(statePlaces.get(currentState)!, t);
                    net.addArc(t, statePlaces.get(targetState)!);
                }

                // Einen Schritt weitergehen
                currentState = targetState;
            }
        }

        // Direkt ans Rendering übergeben (kein ILP Miner nötig!)
        this.renderMinedNet(net);
    }

    private minePartialOrderNet(selectedEntries: FiringEntry[]) {
        const partialOrders: PartialOrder[] = [];

        for (const entry of selectedEntries) {
            const net = new IlpnPetriNet();
            let lastPlace = new IlpnPlace();
            lastPlace.marking = 1;
            net.addPlace(lastPlace);

            const occurrenceCount = new Map<string, number>();

            for (const label of entry.labels) {
                const count = occurrenceCount.get(label) || 0;
                occurrenceCount.set(label, count + 1);

                const actualLabel = count === 0 ? label : `${label}__split${count}`;
                const t = new IlpnTransition(actualLabel);
                net.addTransition(t);
                net.addArc(lastPlace, t);

                const nextPlace = new IlpnPlace();
                net.addPlace(nextPlace);
                net.addArc(t, nextPlace);

                lastPlace = nextPlace;
            }

            try {
                const po = this.pnToPOTransformer.transform(net);
                partialOrders.push(po);
            } catch (e) {
                console.error('Failed to transform to partial order', e);
            }
        }

        if (partialOrders.length === 0) return;

        this.ilp2MinerService.mine(partialOrders).subscribe((result) => {
            this.renderMinedNet(result.net);
        });
    }

    private renderMinedNet(minedNet: IlpnPetriNet) {
        this.stateService.clear();

        const placeMap = new Map<string, string>();
        const transitionMap = new Map<string, string>();

        const getRandomPos = () => {
            const viewBox = this.panningService.viewBox();
            const width = Math.max(viewBox.width, 800);
            const height = Math.max(viewBox.height, 600);
            return {
                x: viewBox.minX + Math.random() * width,
                y: viewBox.minY + Math.random() * height,
            };
        };

        minedNet.getPlaces().forEach((p) => {
            // Falls p.id undefiniert ist (besonders wichtig für unser manuelles Netz),
            // setzen wir hier einen Fallback.
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

        minedNet.getTransitions().forEach((t) => {
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

        minedNet.getPlaces().forEach((p) => {
            const pId = placeMap.get(p.id!)!;
            p.outgoingArcs.forEach((a) => {
                const destinationId = a.destinationId || (a.destination as any).id;
                const tId = transitionMap.get(destinationId)!;
                if (!tId) return;
                this.stateService.addConnection(
                    new LabeledNetEdge(this.stateService.generateConnectionId('conn'), pId, tId, a.weight),
                );
            });
            p.ingoingArcs.forEach((a) => {
                const sourceId = a.sourceId || (a.source as any).id;
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
    }
}
