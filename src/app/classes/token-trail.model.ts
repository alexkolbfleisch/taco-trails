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
    placeId?: string;
}

export interface LpnGoal {
    id: string;
    /** i18n key for the goal description (used with the translate pipe). */
    descriptionKey: string;
    /** Optional interpolation params for the translate pipe (e.g. { a: 'T1', b: 'T2' }). */
    descriptionParams?: Record<string, string>;
    completed: boolean;
}

export interface InternalGoal {
    id: string;
    descriptionKey: string;
    descriptionParams?: Record<string, string>;
    check: (elements: TokenTrailElement[], connections: TokenTrailConnection[], sourceNet: PetriNet) => boolean;
}

export interface SourceNetCapabilities {
    reachableMarkings: Record<string, number>[];
    preset: Record<string, Record<string, number>>;
    postset: Record<string, Record<string, number>>;
}

export interface CandidateGoal {
    type: 'concurrency' | 'conflict' | 'loop' | 'repeat' | 'sequence';
    value: [string, string] | string | null;
    goal: InternalGoal;
}
