import { Injectable, computed, inject, signal } from '@angular/core';
import { Subject, Observable } from 'rxjs';
import { GLPK } from 'glpk.js';
import { TokenTrailStateService } from './token-trail-state.service';
import { SourcePetriNetService } from './source-petri-net.service';
import { DisplayService } from './display.service';
import { Diagram } from '../classes/diagram/diagram';
import { Condition, Event as LabeledEvent, LabeledNetNode } from '../classes/labeled-net.model';
import { ToasterNotificationService } from './toaster-notification.service';
import { ModeService } from './mode.service';
import { TabStateService } from './tab-state.service';
import { LoadingService } from './loading.service';
import { TokenTrailValidatorService } from '../../../ilpn-components/src/lib/algorithms/pn/validation/token-trails/token-trail-validator.service';
import { TokenTrailValidationResult } from '../../../ilpn-components/src/lib/algorithms/pn/validation/classes/validation-result';
import { CustomTokenTrailValidator } from '../classes/custom-token-trail-validator';
import { PetriNet as IlpnPetriNet } from '../../../ilpn-components/src/lib/models/pn/model/petri-net';
import { JsonPetriNetParserService } from '../../../ilpn-components/src/lib/models/pn/io/parser/json-petri-net-parser.service';
import { SerializationService } from './serialization.service';
import { convertSourceNetToIlpn, convertLpnToIlpn, mapValidatorResultsToSolvedTrails } from '../utils/lpn-convert.util';
import {
    PetriNet,
    TokenTrailElement,
    TokenTrailConnection,
    ValidationResult,
    PlaceValidationResult,
    ValidationIssue,
} from '../classes/token-trail.model';

export * from '../classes/token-trail.model';

/**
 * LPN Token Trail Validation Service
 */
@Injectable({
    providedIn: 'root',
})
export class TokenTrailValidationService {
    private stateService = inject(TokenTrailStateService);
    private sourcePetriNetService = inject(SourcePetriNetService);
    private displayService = inject(DisplayService);
    private toaster = inject(ToasterNotificationService);
    private modeService = inject(ModeService);
    private tabStateService = inject(TabStateService);
    private loadingService = inject(LoadingService);
    private tokenTrailValidatorService = inject(TokenTrailValidatorService);
    private jsonParser = inject(JsonPetriNetParserService);
    private serializationService = inject(SerializationService);

    readonly lastExplicitValidationTriggerKey = signal<string | null>(null);

    private readonly _explicitValidation$ = new Subject<{ valid: boolean }>();
    readonly explicitValidation$ = this._explicitValidation$.asObservable();

    readonly validPetriPlaceIds = computed(() => {
        const isExamMode = this.modeService.isExamMode(this.tabStateService.currentTab());
        if (isExamMode) {
            return new Set<string>();
        }
        const result = this.liveValidation();
        const validSet = new Set<string>();
        if (result && result.perPlaceResults) {
            for (const [placeId, placeResult] of Object.entries(result.perPlaceResults)) {
                if (placeResult.valid) {
                    validSet.add(placeId);
                }
            }
        }
        return validSet;
    });

    readonly invalidPetriPlaceIds = computed(() => {
        const isExamMode = this.modeService.isExamMode(this.tabStateService.currentTab());
        if (isExamMode) {
            return new Set<string>();
        }
        const result = this.liveValidation();
        const invalidSet = new Set<string>();
        if (result && result.perPlaceResults) {
            for (const [placeId, placeResult] of Object.entries(result.perPlaceResults)) {
                if (!placeResult.valid) {
                    invalidSet.add(placeId);
                }
            }
        }
        return invalidSet;
    });

    private _lastValidationTriggerKey: string | null = null;
    private _lastValidationResult: ValidationResult | null = null;

    readonly validationTriggerKey = computed(() => {
        const sourceNet = this.resolveSourceNetForValidation();
        const sourceKey = sourceNet
            ? `${sourceNet.getNodes().length}:${sourceNet.getEdges().length}:${Object.keys(sourceNet.startMarking || {}).length}`
            : 'no-source';

        const elementKey = this.stateService
            .drawnElements()
            .map((node) => {
                if (node instanceof Condition) {
                    return `C:${node.id}:${node.label ?? node.displayLabel}:${node.isStartPlace ? 1 : 0}`;
                }
                return `E:${node.id}:${node.displayLabel}:${node.transitionId}`;
            })
            .sort()
            .join('|');

        const connectionKey = this.stateService
            .connections()
            .map((connection) => `${connection.source}>${connection.target}:${connection.weight}`)
            .sort()
            .join('|');

        return `${sourceKey}::${elementKey}::${connectionKey}`;
    });

    readonly liveValidation = computed(() => {
        const triggerKey = this.validationTriggerKey();
        const data = this.buildValidationInput();
        this._lastValidationTriggerKey = triggerKey;
        this._lastValidationResult = data ? this.validateTokenTrail(data.petri, data.elements, data.connections) : null;
        return this._lastValidationResult;
    });

    readonly invalidNodeIds = computed<Set<string>>(() => {
        const result = this.liveValidation();
        if (!result) {
            return new Set<string>();
        }
        const ids = new Set<string>();
        for (const issue of result.issues) {
            for (const eventId of issue.eventIds ?? []) ids.add(eventId);
            for (const conditionId of issue.conditionIds ?? []) ids.add(conditionId);
        }
        return ids;
    });

    readonly invalidConnectionIds = computed<Set<string>>(() => {
        const result = this.liveValidation();
        if (!result) {
            return new Set<string>();
        }
        const ids = new Set<string>();
        for (const issue of result.issues) {
            for (const connectionId of issue.connectionIds ?? []) ids.add(connectionId);
        }
        return ids;
    });

    resolveSourceNetForValidation(): Diagram | null {
        const sourceNet = this.sourcePetriNetService.getCurrentSourceNet();
        if (sourceNet instanceof Diagram) {
            return sourceNet;
        }

        const displayed = this.displayService.diagram;
        return displayed instanceof Diagram ? displayed : null;
    }

    buildValidationInput(): {
        petri: PetriNet;
        elements: TokenTrailElement[];
        connections: TokenTrailConnection[];
    } | null {
        const base = this.resolveSourceNetForValidation() ?? undefined;
        if (!base) {
            return null;
        }

        const nodes = base.getNodes();
        const edges = base.getEdges();
        const startMarkingEntries = Object.entries(base.startMarking || {}).filter(([, tokens]) => (tokens ?? 0) > 0);
        const petri: PetriNet = {
            places: nodes.filter((n) => n.shape === 'circle').map((n) => n.id),
            placeLabels: Object.fromEntries(
                nodes.filter((n) => n.shape === 'circle').map((n) => [n.id, n.displayLabel]),
            ),
            transitions: nodes.filter((n) => n.shape === 'rect').map((n) => n.id),
            arcs: Object.fromEntries(
                edges.map((e) => [
                    `${e.source},${e.target}`,
                    ((e as unknown as { weight?: number }).weight ?? 1) as number,
                ]),
            ),
            labels: Object.fromEntries(nodes.filter((n) => n.shape === 'rect').map((n) => [n.id, n.displayLabel])),
            marking: Object.fromEntries(startMarkingEntries),
        };

        const elements: TokenTrailElement[] = this.stateService.drawnElements().map((el) => {
            const isCondition = el instanceof Condition;
            const isEvent = el instanceof LabeledEvent;
            return {
                id: el.id,
                type: isCondition ? 'Condition' : isEvent ? 'Event' : 'Condition',
                label: isCondition ? (el.innerLabel ?? el.displayLabel) : el.displayLabel,
                isStartCondition: isCondition ? el.isStartPlace : undefined,
                marking: isCondition ? el.tokenCount() : undefined,
                trailMarkings: isCondition ? { ...el.trailMarkings } : undefined,
            };
        });

        const connections: TokenTrailConnection[] = this.stateService.connections().map((c) => ({
            id: c.id,
            from: c.source,
            to: c.target,
            weight: c.weight,
        }));

        const startConditions = this.stateService
            .drawnElements()
            .filter((el): el is Condition => el instanceof Condition && el.isStartPlace)
            .map((el) => el.label ?? el.displayLabel);

        return {
            petri: {
                ...petri,
                startPlaces: startConditions,
                focusPlaceId: this.stateService.selectedPetriPlaceId() ?? undefined,
            },
            elements,
            connections,
        };
    }

    // --- Private Helper Methods for LPN Token Trail Validation ---

    /**
     * Validates a Labeled Petri Net (LPN) against an original Marked Petri Net
     * to determine if the user-provided token trails satisfy the token trail semantics.
     */
    public validateTokenTrail(
        net: PetriNet,
        elements: TokenTrailElement[],
        connections: TokenTrailConnection[],
    ): ValidationResult {
        const result: ValidationResult = {
            valid: true,
            errors: [],
            infos: [],
            issues: [],
            perPlaceResults: {},
        };

        const perPlaceResults: Record<string, PlaceValidationResult> = {};
        const conditions = elements.filter((e) => e.type === 'Condition');
        const events = elements.filter((e) => e.type === 'Event');

        for (const placeId of net.places) {
            const issues: ValidationIssue[] = [];
            let isPlaceValid = true;

            if (!this.checkInitialization(placeId, net, conditions, issues)) {
                isPlaceValid = false;
            }

            for (const eventElement of events) {
                const transitionId =
                    Object.keys(net.labels).find((id) => net.labels[id] === eventElement.label) || eventElement.label;

                if (!this.checkActivation(placeId, transitionId, eventElement, net, conditions, connections, issues)) {
                    isPlaceValid = false;
                }

                if (!this.checkRise(placeId, transitionId, eventElement, net, conditions, connections, issues)) {
                    isPlaceValid = false;
                }
            }

            perPlaceResults[placeId] = { valid: isPlaceValid, issues };
            if (!isPlaceValid) {
                result.valid = false;
                result.issues.push(...issues);
            }
        }

        result.perPlaceResults = perPlaceResults;
        return result;
    }

    /**
     * Retrieves the weight of an arc from source to target.
     */
    private getWeight(
        source: string,
        target: string,
        edgeDefs: Record<string, number> | TokenTrailConnection[],
    ): number {
        if (Array.isArray(edgeDefs)) {
            const conn = edgeDefs.find((c) => c.from === source && c.to === target);
            return conn ? conn.weight : 0;
        }
        return edgeDefs[`${source},${target}`] || 0;
    }

    /**
     * Checks the INITIALIZATION condition: The weighted sum of initial tokens in the LPN
     * must equal the initial marking of the original Petri net place.
     */
    private checkInitialization(
        placeId: string,
        net: PetriNet,
        conditions: TokenTrailElement[],
        issues: ValidationIssue[],
    ): boolean {
        const initialMarking = net.marking?.[placeId] || 0;
        let calculatedInitialMarking = 0;

        for (const condition of conditions) {
            const trailMarking = condition.trailMarkings?.[placeId] || 0;
            const conditionInitialMarking = condition.isStartCondition ? 1 : 0;
            calculatedInitialMarking += conditionInitialMarking * trailMarking;
        }

        if (calculatedInitialMarking !== initialMarking) {
            const conditionIds = conditions.filter((e) => (e.trailMarkings?.[placeId] || 0) > 0).map((e) => e.id);
            if (initialMarking > 0 && calculatedInitialMarking < initialMarking) {
                for (const condition of conditions) {
                    if (condition.isStartCondition && !conditionIds.includes(condition.id)) {
                        conditionIds.push(condition.id);
                    }
                }
            }

            const messageKey =
                calculatedInitialMarking === 0 && initialMarking > 0
                    ? 'TOKEN_TRAIL.VALIDATION.RULE_INITIALIZATION.MISSING_START_CONDITION_FOR_MARKED_PLACE'
                    : 'TOKEN_TRAIL.VALIDATION.RULE_INITIALIZATION.INITIAL_MARKING_MISMATCH';

            issues.push({
                rule: 'INITIALIZATION',
                messageKey,
                placeId,
                messageParams: {
                    place: `<strong>${net.placeLabels?.[placeId] || placeId}</strong>`,
                    expected: `<strong>${initialMarking}</strong>`,
                    actual: `<strong>${calculatedInitialMarking}</strong>`,
                },
                conditionIds,
            });
            return false;
        }
        return true;
    }

    /**
     * Checks the ACTIVATION (Enabling) condition: The LPN event must have enough
     * tokens available in its pre-set according to the original place's incoming arc weight.
     */
    private checkActivation(
        placeId: string,
        transitionId: string,
        event: TokenTrailElement,
        net: PetriNet,
        conditions: TokenTrailElement[],
        connections: TokenTrailConnection[],
        issues: ValidationIssue[],
    ): boolean {
        const originalPrePlaceWeight = this.getWeight(placeId, transitionId, net.arcs);
        let calculatedAvailableTokens = 0;

        for (const condition of conditions) {
            const trailMarking = condition.trailMarkings?.[placeId] || 0;
            calculatedAvailableTokens += this.getWeight(condition.id, event.id, connections) * trailMarking;
        }

        if (calculatedAvailableTokens < originalPrePlaceWeight) {
            issues.push({
                rule: 'ACTIVATION',
                messageKey: 'TOKEN_TRAIL.VALIDATION.RULE_ACTIVATION.NOT_ENOUGH_PRESET_WEIGHT',
                placeId,
                messageParams: {
                    place: `<strong>${net.placeLabels?.[placeId] || placeId}</strong>`,
                    event: `<strong>${net.labels[transitionId] || transitionId}</strong>`,
                    expectedArcWeight: `<strong>${originalPrePlaceWeight}</strong>`,
                    actualArcWeight: `<strong>${calculatedAvailableTokens}</strong>`,
                },
                eventIds: [event.id],
            });
            return false;
        }
        return true;
    }

    /**
     * Checks the RISE (Flow) condition: The token difference (flow in - flow out) for the event
     * must match the original transition's token flow for the place.
     */
    private checkRise(
        placeId: string,
        transitionId: string,
        event: TokenTrailElement,
        net: PetriNet,
        conditions: TokenTrailElement[],
        connections: TokenTrailConnection[],
        issues: ValidationIssue[],
    ): boolean {
        const originalPrePlaceWeight = this.getWeight(placeId, transitionId, net.arcs);
        const originalPostPlaceWeight = this.getWeight(transitionId, placeId, net.arcs);
        const expectedRise = originalPostPlaceWeight - originalPrePlaceWeight;

        let actualRise = 0;
        for (const condition of conditions) {
            const trailMarking = condition.trailMarkings?.[placeId] || 0;
            const eventToConditionWeight = this.getWeight(event.id, condition.id, connections);
            const conditionToEventWeight = this.getWeight(condition.id, event.id, connections);
            actualRise += (eventToConditionWeight - conditionToEventWeight) * trailMarking;
        }

        if (actualRise !== expectedRise) {
            issues.push({
                rule: 'RISE',
                messageKey: 'TOKEN_TRAIL.VALIDATION.RULE_RISE.RISE_MISMATCH',
                placeId,
                messageParams: {
                    place: `<strong>${net.placeLabels?.[placeId] || placeId}</strong>`,
                    event: `<strong>${net.labels[transitionId] || transitionId}</strong>`,
                    expected: `<strong>${expectedRise}</strong>`,
                    actual: `<strong>${actualRise}</strong>`,
                },
                eventIds: [event.id],
            });
            return false;
        }
        return true;
    }

    public solveEmptyConditions(): void {
        const sourceNet = this.resolveSourceNetForValidation();
        if (!sourceNet || !(sourceNet instanceof Diagram)) {
            this.toaster.showWarning('TOKEN_TRAIL.NO_SOURCE_NET_TITLE', 'TOKEN_TRAIL.NO_SOURCE_NET_BODY');
            return;
        }

        const drawnElements = this.stateService.drawnElements();
        const connections = this.stateService.connections();

        // Clear any previous highlights
        this.clearHighlights(drawnElements);

        // Check if at least one start condition exists
        const hasStartPlace = drawnElements.some((el) => el instanceof Condition && el.isStartPlace);
        if (!hasStartPlace) {
            this.toaster.showWarning(
                'TOKEN_TRAIL.SOLVER.NO_START_PLACE_TITLE',
                'TOKEN_TRAIL.SOLVER.NO_START_PLACE_BODY',
            );
            return;
        }

        // 1. Convert drawn LPN and source net to ILPN representations
        const ilpnSource = convertSourceNetToIlpn(sourceNet, this.serializationService, this.jsonParser);
        const ilpnSpec = convertLpnToIlpn(drawnElements, connections, this.serializationService, this.jsonParser);
        const solver$ = (this.tokenTrailValidatorService as unknown as { _solver$: Observable<GLPK> })._solver$;

        // If there are no empty conditions, bypass Phase 1 and directly try Phase 2 (rearrangement)
        const hasEmptyCondition = drawnElements.some(
            (el) => el instanceof Condition && Object.keys(el.trailMarkings).length === 0,
        );
        if (!hasEmptyCondition) {
            this.runPhase2Solver(ilpnSource, ilpnSpec, solver$, drawnElements);
            return;
        }

        // 2. Identify fixed markings (conditions that are already filled/have markings)
        const fixedMarkings: Record<string, Record<string, number>> = {};
        for (const el of drawnElements) {
            if (el instanceof Condition && Object.keys(el.trailMarkings).length > 0) {
                fixedMarkings[el.id] = { ...el.trailMarkings };
            }
        }

        // 3. Instantiate and run our custom validator with locked markings
        const validator = new CustomTokenTrailValidator(ilpnSource, ilpnSpec, solver$, fixedMarkings);

        this.loadingService.show();
        validator.validate().subscribe({
            next: (results: TokenTrailValidationResult[]) => {
                this.loadingService.hide();

                // Check if a solution exists for all places
                const allValid = results.length > 0 && results.every((r) => r.valid);
                if (!allValid) {
                    // Phase 2: Try another solver without place constraints (empty fixedMarkings)
                    this.runPhase2Solver(ilpnSource, ilpnSpec, solver$, drawnElements);
                    return;
                }

                // Map results to condition-specific markings
                const solvedTrailsMap = mapValidatorResultsToSolvedTrails(results);

                // Apply markings directly to empty conditions only
                this.applyPhase1Solution(solvedTrailsMap);
            },
            error: (err) => {
                this.loadingService.hide();
                console.error('Error in solveEmptyConditions:', err);
                this.toaster.showError('TOKEN_TRAIL.SOLUTION_ERROR_TITLE', 'TOKEN_TRAIL.SOLUTION_ERROR_BODY');
            },
        });
    }

    private clearHighlights(drawnElements: LabeledNetNode[]): void {
        for (const el of drawnElements) {
            if (el instanceof Condition) {
                el.highlightColor.set(null);
            }
        }
    }

    private applyPhase1Solution(solvedTrailsMap: Map<string, Record<string, number>>): void {
        const filledConditionIds = new Set<string>();

        this.stateService.updateDrawnElements((elements) => {
            return elements.map((node) => {
                if (node instanceof Condition) {
                    const isEmpty = Object.keys(node.trailMarkings).length === 0;
                    if (isEmpty) {
                        const newMarkings: Record<string, number> = {};
                        for (const [placeId, markingRecord] of solvedTrailsMap.entries()) {
                            const val = markingRecord[node.id] ?? 0;
                            if (val > 0) {
                                newMarkings[placeId] = val;
                            }
                        }
                        if (Object.keys(newMarkings).length > 0) {
                            node.trailMarkings = newMarkings;
                            node.updateDynamicLabel();
                            node.highlightColor.set('#c8e6c9'); // Soft green highlight
                            filledConditionIds.add(node.id);
                        }
                    }
                }
                return node;
            });
        });

        if (filledConditionIds.size > 0) {
            setTimeout(() => {
                this.stateService.updateDrawnElements((elements) => {
                    return elements.map((node) => {
                        if (node instanceof Condition && filledConditionIds.has(node.id)) {
                            if (node.highlightColor() === '#c8e6c9') {
                                node.highlightColor.set(null);
                            }
                        }
                        return node;
                    });
                });
            }, 3000);
        }

        const stillHasEmpty = this.stateService
            .drawnElements()
            .some((el) => el instanceof Condition && Object.keys(el.trailMarkings).length === 0);

        if (stillHasEmpty) {
            this.toaster.showInfo('TOKEN_TRAIL.SOLVER.MINIMAL_TRAIL_TITLE', 'TOKEN_TRAIL.SOLVER.MINIMAL_TRAIL_BODY');
        } else {
            this.toaster.showSuccess('TOKEN_TRAIL.SOLVER.SUCCESS_TITLE', 'TOKEN_TRAIL.SOLVER.SUCCESS_BODY');
        }
    }

    private runPhase2Solver(
        ilpnSource: IlpnPetriNet,
        ilpnSpec: IlpnPetriNet,
        solver$: Observable<GLPK>,
        drawnElements: LabeledNetNode[],
    ): void {
        const valData = this.buildValidationInput();
        const wasAlreadyValid =
            !!valData && this.validateTokenTrail(valData.petri, valData.elements, valData.connections).valid;

        const secondValidator = new CustomTokenTrailValidator(ilpnSource, ilpnSpec, solver$, {});
        this.loadingService.show();
        secondValidator.validate().subscribe({
            next: (secondResults: TokenTrailValidationResult[]) => {
                this.loadingService.hide();
                const secondAllValid = secondResults.length > 0 && secondResults.every((r) => r.valid);
                if (!secondAllValid) {
                    this.toaster.showWarning(
                        'TOKEN_TRAIL.SOLVER.NO_SOLUTION_TITLE',
                        'TOKEN_TRAIL.SOLVER.NO_SOLUTION_BODY',
                    );
                    return;
                }

                // Rearranged solution found!
                const solvedTrailsMap = mapValidatorResultsToSolvedTrails(secondResults);

                // Store original markings so we can revert if dismissed
                const originalMarkings: Record<string, Record<string, number>> = {};
                for (const el of drawnElements) {
                    if (el instanceof Condition) {
                        originalMarkings[el.id] = { ...el.trailMarkings };
                    }
                }

                this.applyRearrangedSolution(solvedTrailsMap, originalMarkings, wasAlreadyValid);
            },
            error: (err) => {
                this.loadingService.hide();
                console.error('Error in second solver:', err);
                this.toaster.showError('TOKEN_TRAIL.SOLUTION_ERROR_TITLE', 'TOKEN_TRAIL.SOLUTION_ERROR_BODY');
            },
        });
    }

    private applyRearrangedSolution(
        solvedTrailsMap: Map<string, Record<string, number>>,
        originalMarkings: Record<string, Record<string, number>>,
        wasAlreadyValid: boolean,
    ): void {
        // Apply markings to ALL conditions and set highlight color if changed
        this.stateService.updateDrawnElements((elements) => {
            return elements.map((node) => {
                if (node instanceof Condition) {
                    const oldMarkings = originalMarkings[node.id] || {};
                    const newMarkings: Record<string, number> = {};
                    for (const [placeId, markingRecord] of solvedTrailsMap.entries()) {
                        const val = markingRecord[node.id] ?? 0;
                        if (val > 0) {
                            newMarkings[placeId] = val;
                        }
                    }

                    const isDiff = areMarkingsDifferent(oldMarkings, newMarkings);
                    node.trailMarkings = newMarkings;
                    node.updateDynamicLabel();

                    const wasEmpty = Object.keys(oldMarkings).length === 0;
                    const isFilled = Object.keys(newMarkings).length > 0;

                    if (wasEmpty) {
                        if (isFilled) {
                            node.highlightColor.set('#c8e6c9'); // Soft green highlight
                        } else {
                            node.highlightColor.set(null);
                        }
                    } else {
                        if (isDiff) {
                            node.highlightColor.set('#ffe0b2'); // Soft yellow highlight
                        } else {
                            node.highlightColor.set(null);
                        }
                    }
                }
                return node;
            });
        });

        const titleKey = wasAlreadyValid
            ? 'TOKEN_TRAIL.SOLVER.MINIMAL_SOLUTION_TITLE'
            : 'TOKEN_TRAIL.SOLVER.REARRANGED_TITLE';
        const bodyKey = wasAlreadyValid
            ? 'TOKEN_TRAIL.SOLVER.MINIMAL_SOLUTION_BODY'
            : 'TOKEN_TRAIL.SOLVER.REARRANGED_BODY';

        // Show toast with Accept and Dismiss buttons
        this.toaster.showInfo(titleKey, bodyKey, {
            duration: undefined,
            actions: {
                accept: {
                    label: 'TOKEN_TRAIL.SOLVER.ACCEPT',
                    action: () => {
                        // Clear highlight colors
                        this.stateService.updateDrawnElements((elements) => {
                            return elements.map((node) => {
                                if (node instanceof Condition) {
                                    node.highlightColor.set(null);
                                }
                                return node;
                            });
                        });
                        this.toaster.showSuccess(
                            'TOKEN_TRAIL.SOLVER.REARRANGED_ACCEPTED_TITLE',
                            'TOKEN_TRAIL.SOLVER.REARRANGED_ACCEPTED_BODY',
                        );
                    },
                },
                dismiss: {
                    label: 'TOKEN_TRAIL.SOLVER.DISMISS',
                    action: () => {
                        // Revert to original markings and clear highlights
                        this.stateService.updateDrawnElements((elements) => {
                            return elements.map((node) => {
                                if (node instanceof Condition) {
                                    node.trailMarkings = originalMarkings[node.id] || {};
                                    node.updateDynamicLabel();
                                    node.highlightColor.set(null);
                                }
                                return node;
                            });
                        });
                        this.toaster.showInfo(
                            'TOKEN_TRAIL.SOLVER.REARRANGED_DISMISSED_TITLE',
                            'TOKEN_TRAIL.SOLVER.REARRANGED_DISMISSED_BODY',
                        );
                    },
                },
            },
        });
    }
}

function areMarkingsDifferent(m1: Record<string, number>, m2: Record<string, number>): boolean {
    const keys = new Set([...Object.keys(m1), ...Object.keys(m2)]);
    for (const key of keys) {
        if ((m1[key] ?? 0) !== (m2[key] ?? 0)) {
            return true;
        }
    }
    return false;
}
