import { Injectable, computed, inject, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { TokenTrailStateService } from './token-trail-state.service';
import { SourcePetriNetService } from './source-petri-net.service';
import { DisplayService } from './display.service';
import { Diagram } from '../classes/diagram/diagram';
import { Condition, Event as LabeledEvent } from '../classes/labeled-net.model';
import { ToasterNotificationService } from './toaster-notification.service';
import { ModeService } from './mode.service';
import { Tab } from '../classes/tabs';
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

    readonly lastExplicitValidationTriggerKey = signal<string | null>(null);

    private readonly _explicitValidation$ = new Subject<{ valid: boolean }>();
    readonly explicitValidation$ = this._explicitValidation$.asObservable();

    readonly validPetriPlaceIds = computed(() => {
        const isExamMode = this.modeService.isExamMode(Tab.TOKEN_TRAIL);
        if (isExamMode && this.validationTriggerKey() !== this.lastExplicitValidationTriggerKey()) {
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
        const isExamMode = this.modeService.isExamMode(Tab.TOKEN_TRAIL);
        if (isExamMode && this.validationTriggerKey() !== this.lastExplicitValidationTriggerKey()) {
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

    readonly liveValidation = computed<ValidationResult | null>(() => {
        const triggerKey = this.validationTriggerKey();
        if (this._lastValidationTriggerKey === triggerKey) {
            return this._lastValidationResult;
        }

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

    onValidate() {
        const result = this.liveValidation();
        if (!result) {
            this.toaster.showError('TOASTER.HEADER.VALIDATION', 'TOASTER.BODY.VALIDATION_ERROR', {
                duration: 0,
            });
            return;
        }

        this.lastExplicitValidationTriggerKey.set(this.validationTriggerKey());
        this.stateService.setSelectedPetriPlaceId(null);

        this._explicitValidation$.next({ valid: result.valid });
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
            issues.push({
                rule: 'INITIALIZATION',
                messageKey: 'TOKEN_TRAIL.VALIDATION.RULE_INITIALIZATION.INITIAL_MARKING_MISMATCH',
                placeId,
                messageParams: {
                    place: `<strong>${net.placeLabels?.[placeId] || placeId}</strong>`,
                    expected: `<strong>${initialMarking}</strong>`,
                    actual: `<strong>${calculatedInitialMarking}</strong>`,
                },
                conditionIds: conditions.filter((e) => (e.trailMarkings?.[placeId] || 0) > 0).map((e) => e.id),
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
}
