// Service / utility for validating a drawn process net against the original Petri net
// Based on user-provided specification, with minor fixes (e.g., producer count increment).

import { TranslationParams } from '../classes/toast';

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
export function validateTokenTrail(
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
            messageKey: 'TOKEN_TRAIL.VALIDATION_INITIAL_MARKING_MISMATCH',
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
            messageKey: 'TOKEN_TRAIL.VALIDATION_ENABLING_FAILED',
            messageParams: {
                place: placeId,
                transition: transitionId,
                expected: originalPrePlaceWeight,
                actual: calculatedAvailableTokens,
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
            messageKey: 'TOKEN_TRAIL.VALIDATION_FLOW_MISMATCH',
            messageParams: {
                place: placeId,
                transition: transitionId,
                expected: expectedRise,
                actual: actualRise,
            },
            eventIds: [event.id],
        });
        return false;
    }
    return true;
}
