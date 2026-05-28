import { TranslationParams } from './toast';

export interface PetriNet {
    places: string[];
    placeLabels?: Record<string, string>; // original place id -> display label
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
