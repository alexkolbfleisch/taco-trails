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

interface EventGraphNode {
    id: string;
    label: string;
    transitionId: string;
    prev: Set<string>;
    next: Set<string>;
    preWeight: number;
    postWeight: number;
}



//TODO: validation does not work as expected at the moment, need to find a way to "prefill" the LPN with actual tokens by the algorithm

export function validateTokenTrail(
    net: PetriNet,
    elements: TokenTrailElement[],
    connections: TokenTrailConnection[],
): ValidationResult {
    const errors: ValidationMessage[] = [];
    const infos: ValidationMessage[] = [];
    const globalIssues: ValidationIssue[] = [];

    const byId = new Map(elements.map((element) => [element.id, element]));
    const events = elements.filter((element) => element.type === 'Event');
    const conditions = elements.filter((element) => element.type === 'Condition');
    const incomingByEvent = new Map<string, TokenTrailConnection[]>();
    const outgoingByEvent = new Map<string, TokenTrailConnection[]>();

    for (const event of events) {
        incomingByEvent.set(event.id, []);
        outgoingByEvent.set(event.id, []);
    }

    for (const connection of connections) {
        const source = byId.get(connection.from);
        const target = byId.get(connection.to);

        if (!source || !target || source.type === target.type) {
            globalIssues.push({
                rule: 'ACTIVATION',
                messageKey: 'TOKEN_TRAIL.VALIDATION.RULE_ACTIVATION.INVALID_CONNECTION_TYPE',
                messageParams: {
                    source: connection.from,
                    target: connection.to,
                },
                connectionIds: connection.id ? [connection.id] : undefined,
                eventIds: [connection.from, connection.to].filter((id) => byId.get(id)?.type === 'Event'),
                conditionIds: [connection.from, connection.to].filter((id) => byId.get(id)?.type === 'Condition'),
            });
            continue;
        }

        if (source.type === 'Condition') {
            incomingByEvent.get(target.id)?.push(connection);
        } else {
            outgoingByEvent.get(source.id)?.push(connection);
        }
    }

    const transitionsByLabel = new Map<string, string[]>();
    for (const [transitionId, label] of Object.entries(net.labels || {})) {
        const list = transitionsByLabel.get(label) ?? [];
        list.push(transitionId);
        transitionsByLabel.set(label, list);
    }

    const eventTransitionMap = new Map<string, string>();
    for (const event of events) {
        const transitionIds = transitionsByLabel.get(event.label) ?? [];
        if (transitionIds.length === 1) {
            eventTransitionMap.set(event.id, transitionIds[0]);
            continue;
        }

        if (transitionIds.length === 0) {
            globalIssues.push({
                rule: 'ACTIVATION',
                messageKey: 'TOKEN_TRAIL.VALIDATION.RULE_ACTIVATION.EVENT_LABEL_NOT_FOUND',
                messageParams: { event: event.label },
                eventIds: [event.id],
            });
            continue;
        }

        globalIssues.push({
            rule: 'ACTIVATION',
            messageKey: 'TOKEN_TRAIL.VALIDATION.RULE_ACTIVATION.EVENT_LABEL_AMBIGUOUS',
            messageParams: { event: event.label, count: transitionIds.length },
            eventIds: [event.id],
        });
    }

    const placeScope = net.focusPlaceId ? [net.focusPlaceId] : net.places;
    const usedTransitionIds = new Set<string>(Array.from(eventTransitionMap.values()));
    if (net.focusPlaceId && !net.places.includes(net.focusPlaceId)) {
        globalIssues.push({
            rule: 'INITIALIZATION',
            messageKey: 'TOKEN_TRAIL.VALIDATION.RULE_INITIALIZATION.MISSING_START_CONDITION_FOR_MARKED_PLACE',
            messageParams: { place: net.focusPlaceId, expected: 0 },
        });
    }

    const eventPredecessors = buildEventPredecessors(events, conditions, byId, connections);
    const perPlaceResults: Record<string, PlaceValidationResult> = {};
    for (const placeId of placeScope) {
        const placeIssues: ValidationIssue[] = [];

        for (const transitionId of net.transitions) {
            const consume = net.arcs[`${placeId},${transitionId}`] ?? 0;
            const produce = net.arcs[`${transitionId},${placeId}`] ?? 0;
            const expectedRise = produce - consume;
            if (expectedRise === 0) {
                continue;
            }
            if (usedTransitionIds.has(transitionId)) {
                continue;
            }

            placeIssues.push({
                rule: 'RISE',
                messageKey: 'TOKEN_TRAIL.VALIDATION.RULE_RISE.MISSING_EVENT_FOR_TRANSITION',
                messageParams: {
                    place: placeId,
                    transition: net.labels[transitionId] || transitionId,
                },
            });
        }

        const requiredTokens = net.marking?.[placeId] ?? 0;
        if (requiredTokens > 0) {
            const placeStartConditions = conditions.filter(
                (condition) => condition.isStartCondition && condition.label === placeId,
            );

            if (placeStartConditions.length === 0) {
                placeIssues.push({
                    rule: 'INITIALIZATION',
                    messageKey: 'TOKEN_TRAIL.VALIDATION.RULE_INITIALIZATION.MISSING_START_CONDITION_FOR_MARKED_PLACE',
                    messageParams: {
                        place: placeId,
                        expected: requiredTokens,
                    },
                    conditionIds: [],
                });
            }
        }

        const placeEventGraph = buildPlaceEventGraph(placeId, events, eventTransitionMap, eventPredecessors, net.arcs);
        const placeValid = evaluatePlaceFeasibility(placeEventGraph, net.marking?.[placeId] ?? 0);
        if (!placeValid) {
            const conditionIds = conditions
                .filter((condition) => condition.label === placeId)
                .map((condition) => condition.id);
            const eventIds = placeEventGraph.map((node) => node.id);

            placeIssues.push({
                rule: 'RISE',
                messageKey: 'TOKEN_TRAIL.VALIDATION.RULE_RISE.PLACE_NOT_FEASIBLE',
                messageParams: { place: placeId },
                conditionIds,
                eventIds,
            });
        }

        const scopedGlobalIssues = globalIssues.filter((issue) => !issue.messageParams?.['place'] || issue.messageParams?.['place'] === placeId);
        const allPlaceIssues = [...scopedGlobalIssues, ...placeIssues];
        perPlaceResults[placeId] = {
            valid: allPlaceIssues.length === 0,
            issues: allPlaceIssues,
        };
    }

    const issues = Object.values(perPlaceResults).flatMap((result) => result.issues);

    if (issues.length > 0) {
        errors.push({ key: 'TOKEN_TRAIL.VALIDATION_FAILED' });
    }

    //TODO: replace heuristic checks with full Definition 6 semantics against adapted net structures.
    return {
        valid: issues.length === 0,
        errors,
        infos,
        issues,
        perPlaceResults,
    };
}

function buildEventPredecessors(
    events: TokenTrailElement[],
    conditions: TokenTrailElement[],
    byId: Map<string, TokenTrailElement>,
    connections: TokenTrailConnection[],
): Map<string, Set<string>> {
    const predecessors = new Map<string, Set<string>>();
    for (const event of events) {
        predecessors.set(event.id, new Set<string>());
    }

    for (const condition of conditions) {
        const incomingEvents = connections
            .filter((connection) => connection.to === condition.id && byId.get(connection.from)?.type === 'Event')
            .map((connection) => connection.from);
        const outgoingEvents = connections
            .filter((connection) => connection.from === condition.id && byId.get(connection.to)?.type === 'Event')
            .map((connection) => connection.to);

        for (const srcEvent of incomingEvents) {
            for (const dstEvent of outgoingEvents) {
                if (srcEvent === dstEvent) {
                    continue;
                }
                predecessors.get(dstEvent)?.add(srcEvent);
            }
        }
    }

    return predecessors;
}

function buildPlaceEventGraph(
    placeId: string,
    events: TokenTrailElement[],
    eventTransitionMap: Map<string, string>,
    eventPredecessors: Map<string, Set<string>>,
    arcs: Record<string, number>,
): EventGraphNode[] {
    const graphNodes = events
        .map((event) => {
            const transitionId = eventTransitionMap.get(event.id);
            if (!transitionId) {
                return null;
            }

            return {
                id: event.id,
                label: event.label,
                transitionId,
                prev: new Set(eventPredecessors.get(event.id) ?? []),
                next: new Set<string>(),
                preWeight: arcs[`${placeId},${transitionId}`] ?? 0,
                postWeight: arcs[`${transitionId},${placeId}`] ?? 0,
            } as EventGraphNode;
        })
        .filter((node): node is EventGraphNode => !!node);

    const byId = new Map(graphNodes.map((node) => [node.id, node]));
    for (const node of graphNodes) {
        node.prev = new Set([...node.prev].filter((prevId) => byId.has(prevId)));
        for (const prevId of node.prev) {
            byId.get(prevId)?.next.add(node.id);
        }
    }

    return graphNodes;
}

function evaluatePlaceFeasibility(graphNodes: EventGraphNode[], initialTokens: number): boolean {
    if (graphNodes.length === 0) {
        return initialTokens === 0;
    }

    const topoOrder = topologicalOrder(graphNodes);
    if (topoOrder.length !== graphNodes.length) {
        return false;
    }

    const byId = new Map(graphNodes.map((node) => [node.id, node]));
    const indegreeZero = graphNodes.filter((node) => node.prev.size === 0);

    const forwardMarking = new Map<string, number>(graphNodes.map((node) => [node.id, 0]));
    if (indegreeZero.length > 0) {
        forwardMarking.set(indegreeZero[0].id, initialTokens);
    }

    let forwardValid = true;
    let complex = false;
    for (const eventId of topoOrder) {
        const node = byId.get(eventId);
        if (!node) {
            continue;
        }
        let marking = forwardMarking.get(eventId) ?? 0;
        marking -= node.preWeight;
        if (marking < 0) {
            forwardValid = false;
        }
        marking += node.postWeight;

        const nextIds = [...node.next];
        if (nextIds.length > 1 && marking > 0) {
            complex = true;
        }
        if (nextIds.length > 0) {
            const firstNext = nextIds[0];
            forwardMarking.set(firstNext, (forwardMarking.get(firstNext) ?? 0) + marking);
        }
    }

    const finalEvent = [...topoOrder].reverse().find((id) => (byId.get(id)?.next.size ?? 0) === 0) ?? topoOrder[topoOrder.length - 1];
    const finalMarking = forwardMarking.get(finalEvent) ?? 0;
    const notValid = finalMarking < 0;

    const backwardMarking = new Map<string, number>(graphNodes.map((node) => [node.id, 0]));
    backwardMarking.set(finalEvent, Math.max(0, finalMarking));

    let backwardValid = !notValid;
    for (const eventId of [...topoOrder].reverse()) {
        const node = byId.get(eventId);
        if (!node) {
            continue;
        }
        let marking = backwardMarking.get(eventId) ?? 0;
        marking -= node.postWeight;
        if (marking < 0) {
            backwardValid = false;
        }
        marking += node.preWeight;

        const prevIds = [...node.prev];
        if (prevIds.length > 1 && marking > 0) {
            complex = true;
        }
        if (prevIds.length > 0) {
            const firstPrev = prevIds[0];
            backwardMarking.set(firstPrev, (backwardMarking.get(firstPrev) ?? 0) + marking);
        }
    }

    if (forwardValid || backwardValid) {
        return true;
    }
    if (!complex || notValid) {
        return false;
    }

    return flowFeasible(graphNodes, topoOrder, initialTokens);
}

function topologicalOrder(graphNodes: EventGraphNode[]): string[] {
    const indegree = new Map<string, number>(graphNodes.map((node) => [node.id, node.prev.size]));
    const queue = graphNodes.filter((node) => node.prev.size === 0).map((node) => node.id);
    const byId = new Map(graphNodes.map((node) => [node.id, node]));
    const order: string[] = [];

    while (queue.length > 0) {
        const id = queue.shift()!;
        order.push(id);
        for (const nextId of byId.get(id)?.next ?? []) {
            const nextIn = (indegree.get(nextId) ?? 0) - 1;
            indegree.set(nextId, nextIn);
            if (nextIn === 0) {
                queue.push(nextId);
            }
        }
    }

    return order;
}

function flowFeasible(graphNodes: EventGraphNode[], topoOrder: string[], initialTokens: number): boolean {
    if (graphNodes.length === 0) {
        return initialTokens === 0;
    }

    const nodeCount = graphNodes.length;
    const SOURCE = 0;
    const INITIAL = 1;
    const eventStart = (index: number) => 2 + index * 2;
    const eventEnd = (index: number) => 3 + index * 2;
    const SINK = 2 + nodeCount * 2;
    const n = SINK + 1;
    const INF = Number.MAX_SAFE_INTEGER / 8;

    const capacity = Array.from({ length: n }, () => Array<number>(n).fill(0));
    const byId = new Map(graphNodes.map((node) => [node.id, node]));
    const indexById = new Map(topoOrder.map((id, index) => [id, index]));

    const addCap = (u: number, v: number, c: number) => {
        capacity[u][v] += c;
    };

    addCap(SOURCE, INITIAL, Math.max(0, initialTokens));

    for (const eventId of topoOrder) {
        const index = indexById.get(eventId)!;
        const node = byId.get(eventId)!;
        addCap(eventStart(index), eventEnd(index), INF);
        if (node.postWeight > 0) {
            addCap(SOURCE, eventEnd(index), node.postWeight);
        }
        if (node.preWeight > 0) {
            addCap(eventStart(index), SINK, node.preWeight);
        }
        if (node.prev.size === 0) {
            addCap(INITIAL, eventStart(index), INF);
        }
        for (const nextId of node.next) {
            const nextIndex = indexById.get(nextId);
            if (nextIndex !== undefined) {
                addCap(eventEnd(index), eventStart(nextIndex), INF);
            }
        }
    }

    const requiredFlow = capacity.reduce((sum, row) => sum + row[SINK], 0);
    return maxFlow(capacity, SOURCE, SINK) === requiredFlow;
}

function maxFlow(capacity: number[][], source: number, sink: number): number {
    const n = capacity.length;
    const residual = capacity.map((row) => [...row]);
    let total = 0;

    while (true) {
        const parent = new Array<number>(n).fill(-1);
        parent[source] = source;
        const queue: number[] = [source];

        while (queue.length > 0 && parent[sink] === -1) {
            const u = queue.shift()!;
            for (let v = 0; v < n; v++) {
                if (parent[v] === -1 && residual[u][v] > 0) {
                    parent[v] = u;
                    queue.push(v);
                }
            }
        }

        if (parent[sink] === -1) {
            break;
        }

        let pathFlow = Number.MAX_SAFE_INTEGER;
        for (let v = sink; v !== source; v = parent[v]) {
            const u = parent[v];
            pathFlow = Math.min(pathFlow, residual[u][v]);
        }

        for (let v = sink; v !== source; v = parent[v]) {
            const u = parent[v];
            residual[u][v] -= pathFlow;
            residual[v][u] += pathFlow;
        }
        total += pathFlow;
    }

    return total;
}

