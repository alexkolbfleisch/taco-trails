import { Injectable, computed, inject } from '@angular/core';
import { TranslationParams } from '../classes/toast';
import { TokenTrailStateService } from './token-trail-state.service';
import { SourcePetriNetService } from './source-petri-net.service';
import { DisplayService } from './display.service';
import { Diagram } from '../classes/diagram/diagram';
import { Condition, Event as LabeledEvent } from '../classes/labeled-net.model';
import { ToasterNotificationService } from './toaster-notification.service';

export interface PetriNet {
    places: string[];
    transitions: string[];
    arcs: Record<string, number>; // key: "source,target" -> weight
    labels: Record<string, string>; // original transition id -> label (e.g. t1 -> A)
    marking?: Record<string, number>;
    startPlaces?: string[];
    focusPlaceId?: string;
}

export interface TokenTrailElement {
    id: string;
    type: 'Condition' | 'Event';
    label: string; // places: original place id (e.g. p4), transitions: action label (e.g. A/B/C/...)
    isStartCondition?: boolean;
    marking?: number;
    trailMarkings?: Record<string, number>;
}

export interface TokenTrailConnection {
    id?: string;
    from: string; // element id
    to: string; // element id
    weight: number; // arc weight in the process net (>= 1)
}

export interface ValidationMessage {
    key: string;
    params?: TranslationParams;
}

export interface ValidationResult {
    valid: boolean;
    errors: ValidationMessage[];
    infos: ValidationMessage[];
    issues: ValidationIssue[];
    perPlaceResults?: Record<string, PlaceValidationResult>;
}

export interface PlaceValidationResult {
    valid: boolean;
    issues: ValidationIssue[];
}

export type ValidationRule = 'ACTIVATION' | 'RISE' | 'INITIALIZATION';

export interface ValidationIssue {
    rule: ValidationRule;
    messageKey: string;
    messageParams?: Record<string, string | number>;
    eventIds?: string[];
    conditionIds?: string[];
    connectionIds?: string[];
}

/**
 * Validates a Labeled Petri Net (LPN) against an original Marked Petri Net
 * to determine if the user-provided token trails satisfy the token trail semantics.
 *
 * The validation relies on three conditions for each place in the Petri net:
 * 1. INITIALIZATION: The initial marking of the LPN translates correctly to the original place's initial marking.
 * 2. ACTIVATION (Enabling): Every event in the LPN has enough tokens to be fired, according to the original place's weights.
 * 3. RISE (Flow): The token difference (in - out) for every event matches the original transition's effect on the place.
 *
 * @param net The original marked Petri net.
 * @param elements The elements (Conditions and Events) of the user-drawn LPN.
 * @param connections The arcs/connections in the user-drawn LPN.
 * @returns A ValidationResult containing detailed issues per place.
 */
function validateTokenTrail(
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

        if (!checkInitialization(placeId, net, conditions, issues)) {
            isPlaceValid = false;
        }

        for (const eventElement of events) {
            const transitionId =
                Object.keys(net.labels).find((id) => net.labels[id] === eventElement.label) || eventElement.label;

            if (!checkActivation(placeId, transitionId, eventElement, net, conditions, connections, issues)) {
                isPlaceValid = false;
            }

            if (!checkRise(placeId, transitionId, eventElement, net, conditions, connections, issues)) {
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
 *
 * @param source The ID of the source element.
 * @param target The ID of the target element.
 * @param edgeDefs A dictionary of "source,target" -> weight, or an array of TokenTrailConnection.
 * @returns The weight of the arc, or 0 if it does not exist.
 */
function getWeight(source: string, target: string, edgeDefs: Record<string, number> | TokenTrailConnection[]): number {
    if (Array.isArray(edgeDefs)) {
        const conn = edgeDefs.find((c) => c.from === source && c.to === target);
        return conn ? conn.weight : 0;
    }
    return edgeDefs[`${source},${target}`] || 0;
}

/**
 * Checks the INITIALIZATION condition: The weighted sum of initial tokens in the LPN
 * must equal the initial marking of the original Petri net place.
 *
 * @param placeId The ID of the Petri net place to check.
 * @param net The original Marked Petri Net.
 * @param conditions The LPN Condition elements.
 * @param issues Array to collect validation issues if the check fails.
 * @returns true if the initialization condition is met, false otherwise.
 */
function checkInitialization(
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
        issues.push({
            rule: 'INITIALIZATION',
            messageKey: 'TOKEN_TRAIL.VALIDATION.RULE_INITIALIZATION.INITIAL_MARKING_MISMATCH',
            messageParams: { place: placeId, expected: initialMarking, actual: calculatedInitialMarking },
            conditionIds: conditions.filter((e) => (e.trailMarkings?.[placeId] || 0) > 0).map((e) => e.id),
        });
        return false;
    }
    return true;
}

/**
 * Checks the ACTIVATION (Enabling) condition: The LPN event must have enough
 * tokens available in its pre-set according to the original place's incoming arc weight.
 *
 * @param placeId The ID of the Petri net place.
 * @param transitionId The ID of the matching Petri net transition.
 * @param event The LPN Event element firing.
 * @param net The original Marked Petri Net.
 * @param conditions The LPN Condition elements.
 * @param connections The LPN arcs.
 * @param issues Array to collect validation issues if the check fails.
 * @returns true if the enabling condition is met, false otherwise.
 */
function checkActivation(
    placeId: string,
    transitionId: string,
    event: TokenTrailElement,
    net: PetriNet,
    conditions: TokenTrailElement[],
    connections: TokenTrailConnection[],
    issues: ValidationIssue[],
): boolean {
    const originalPrePlaceWeight = getWeight(placeId, transitionId, net.arcs);
    let calculatedAvailableTokens = 0;

    for (const condition of conditions) {
        const trailMarking = condition.trailMarkings?.[placeId] || 0;
        calculatedAvailableTokens += getWeight(condition.id, event.id, connections) * trailMarking;
    }

    if (calculatedAvailableTokens < originalPrePlaceWeight) {
        issues.push({
            rule: 'ACTIVATION',
            messageKey: 'TOKEN_TRAIL.VALIDATION.RULE_ACTIVATION.NOT_ENOUGH_PRESET_WEIGHT',
            messageParams: {
                place: placeId,
                event: transitionId,
                expectedArcWeight: originalPrePlaceWeight,
                actualArcWeight: calculatedAvailableTokens,
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
 *
 * @param placeId The ID of the Petri net place.
 * @param transitionId The ID of the matching Petri net transition.
 * @param event The LPN Event element firing.
 * @param net The original Marked Petri Net.
 * @param conditions The LPN Condition elements.
 * @param connections The LPN arcs.
 * @param issues Array to collect validation issues if the check fails.
 * @returns true if the flow/rise condition is met, false otherwise.
 */
function checkRise(
    placeId: string,
    transitionId: string,
    event: TokenTrailElement,
    net: PetriNet,
    conditions: TokenTrailElement[],
    connections: TokenTrailConnection[],
    issues: ValidationIssue[],
): boolean {
    const originalPrePlaceWeight = getWeight(placeId, transitionId, net.arcs);
    const originalPostPlaceWeight = getWeight(transitionId, placeId, net.arcs);
    const expectedRise = originalPostPlaceWeight - originalPrePlaceWeight;

    let actualRise = 0;
    for (const condition of conditions) {
        const trailMarking = condition.trailMarkings?.[placeId] || 0;
        const eventToConditionWeight = getWeight(event.id, condition.id, connections);
        const conditionToEventWeight = getWeight(condition.id, event.id, connections);
        actualRise += (eventToConditionWeight - conditionToEventWeight) * trailMarking;
    }

    if (actualRise !== expectedRise) {
        issues.push({
            rule: 'RISE',
            messageKey: 'TOKEN_TRAIL.VALIDATION.RULE_RISE.RISE_MISMATCH',
            messageParams: {
                place: placeId,
                event: transitionId,
                expected: expectedRise,
                actual: actualRise,
            },
            eventIds: [event.id],
        });
        return false;
    }
    return true;
}

@Injectable({
    providedIn: 'root',
})
export class TokenTrailValidationService {
    private stateService = inject(TokenTrailStateService);
    private sourcePetriNetService = inject(SourcePetriNetService);
    private displayService = inject(DisplayService);
    private toaster = inject(ToasterNotificationService);

    private _lastValidationTriggerKey: string | null = null;
    private _lastValidationResult: ValidationResult | null = null;

    readonly validationTriggerKey = computed(() => {
        const sourceNet = this.resolveSourceNetForValidation();
        const sourceKey = sourceNet
            ? `${sourceNet.getNodes().length}:${sourceNet.getEdges().length}:${Object.keys(sourceNet.startMarking || {}).length}`
            : 'no-source';

        const elementKey = this.stateService.drawnElements()
            .map((node) => {
                if (node instanceof Condition) {
                    return `C:${node.id}:${node.label ?? node.displayLabel}:${node.isStartPlace ? 1 : 0}`;
                }
                return `E:${node.id}:${node.displayLabel}:${node.transitionId}`;
            })
            .sort()
            .join('|');

        const connectionKey = this.stateService.connections()
            .map((connection) => `${connection.source}>${connection.target}:${connection.weight}`)
            .sort()
            .join('|');

        return `${sourceKey}::${elementKey}::${connectionKey}`;
    });

    readonly liveValidation = computed<ValidationResult | null>(() => {
        const triggerKey = this.validationTriggerKey();
        if (this._lastValidationTriggerKey === triggerKey) {
            return this._lastValidationResult;
        }

        const data = this.buildValidationInput();
        this._lastValidationTriggerKey = triggerKey;
        this._lastValidationResult = data ? validateTokenTrail(data.petri, data.elements, data.connections) : null;
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

    onValidate() {
        const result = this.liveValidation();
        if (!result) {
            this.toaster.showError('TOASTER.HEADER.VALIDATION', 'TOASTER.BODY.VALIDATION_ERROR', {
                duration: 0,
            });
            return;
        }

        const validSet = new Set<string>();
        const invalidSet = new Set<string>();

        if (result.perPlaceResults) {
            for (const [placeId, placeResult] of Object.entries(result.perPlaceResults)) {
                if (placeResult.valid) {
                    validSet.add(placeId);
                } else {
                    invalidSet.add(placeId);
                }
            }
        }

        this.stateService.setValidPetriPlaceIds(validSet);
        this.stateService.setInvalidPetriPlaceIds(invalidSet);
        this.stateService.setSelectedPetriPlaceId(null);
    }

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

        const startConditions = this.stateService.drawnElements()
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
}
