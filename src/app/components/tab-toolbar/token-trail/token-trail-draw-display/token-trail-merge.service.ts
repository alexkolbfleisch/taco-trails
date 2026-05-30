import { effect, inject, Injectable, OnDestroy, signal } from '@angular/core';

import { Condition, LabeledNetEdge, LabeledNetNode } from '../../../../classes/labeled-net.model';
import { PLACE_RADIUS } from '../../../display/display.constants';
import { TokenTrailStateService } from '../../../../services/token-trail-state.service';

/**
 * Snapshot of a physical condition merge, used for potential undo (finalization reversal).
 * Captures the entire merge state before finalizing a group.
 */
interface LastPhysicalMergeSnapshot {
    anchorConditionId: string;
    drawnElements: LabeledNetNode[];
    connections: LabeledNetEdge[];
    mergedConditionAnchorById: Record<string, string>;
    removedConditionLabels: string[];
}

/**
 * TokenTrailMergeService manages the merging logic for Conditions in the Token Trail drawing component.
 *
 * This service encapsulates:
 * - Merge detection and visualization (anchor identification, merge groups)
 * - Merge operations (finalization, unmerge, drag-drop merging)
 * - Animated transitions and merge state tracking
 * - Connection remapping when conditions are merged/unmerged
 *
 * The service is component-scoped and relies on `TokenTrailStateService` for drawing element management.
 */
@Injectable()
export class TokenTrailMergeService implements OnDestroy {
    private readonly mergedConditionAnchorById = signal<Record<string, string>>({});
    private readonly lastPhysicalMergeSnapshot = signal<LastPhysicalMergeSnapshot | null>(null);
    readonly mergeAnimationAnchorId = signal<string | null>(null);
    private readonly conditionRadius = PLACE_RADIUS;
    private readonly mergeDropDistance = PLACE_RADIUS * 1.2;

    private mergeAnimationTimeout?: ReturnType<typeof setTimeout>;

    private readonly stateService = inject(TokenTrailStateService);

    constructor() {
        effect(() => {
            if (this.stateService.displayMode() === 'puzzle') {
                this.clearMergeState();
            }
        });
    }

    ngOnDestroy(): void {
        this.clearMergeState();
    }

    /**
     * Reset all merge state: anchors, animations, snapshots.
     * Called on component cleanup or drawing reset.
     */
    clearMergeState(): void {
        this.mergedConditionAnchorById.set({});
        this.lastPhysicalMergeSnapshot.set(null);
        this.mergeAnimationAnchorId.set(null);
        if (this.mergeAnimationTimeout) {
            clearTimeout(this.mergeAnimationTimeout);
            this.mergeAnimationTimeout = undefined;
        }
    }

    /**
     * Check if a node is a visual merge anchor (represents multiple visually merged conditions).
     */
    isMergeAnchor(node: LabeledNetNode): boolean {
        if (this.stateService.displayMode() === 'puzzle') {
            return false;
        }
        return node instanceof Condition && this.getConditionGroupSize(node.id) > 1;
    }

    /**
     * Check if a node is animating its merge (used to trigger CSS animations).
     */
    isMergeAnimating(node: LabeledNetNode): boolean {
        if (this.stateService.displayMode() === 'puzzle') {
            return false;
        }
        return node instanceof Condition && this.mergeAnimationAnchorId() === node.id;
    }

    /**
     * Get the total number of conditions in a merge group (through its anchor).
     */
    getConditionGroupSize(conditionId: string): number {
        if (this.stateService.displayMode() === 'puzzle') {
            return 1;
        }
        const anchorId = this.resolveConditionAnchorId(conditionId);
        return this.stateService
            .drawnElements()
            .filter((node) => node instanceof Condition && this.resolveConditionAnchorId(node.id) === anchorId).length;
    }

    /**
     * Get the anchor ID if this condition is merged, otherwise null.
     * Returns null if the condition is not part of a merge group.
     */
    getMergedConditionAnchorIdOrNull(conditionId: string): string | null {
        if (this.stateService.displayMode() === 'puzzle') {
            return null;
        }
        const resolvedAnchor = this.resolveConditionAnchorId(conditionId);
        return resolvedAnchor === conditionId ? null : resolvedAnchor;
    }

    /**
     * Attempt to merge a condition with a nearby target during drag-drop.
     * Only merges if a valid target is found within the merge drop distance.
     */
    tryMergeConditionOnDrop(condition: Condition): void {
        if (this.stateService.displayMode() === 'puzzle') {
            return;
        }
        const mergeTarget = this.findConditionMergeTarget(condition);
        if (!mergeTarget) {
            return;
        }
        this.mergeConditions(condition.id, mergeTarget.id);
    }

    /**
     * Finalize a visual merge group into a single merged condition.
     * Updates the anchor condition's label and trail markings, removes merged members, and remaps connections.
     *
     * @returns Array of removed (merged) condition IDs for cleanup/selection updates.
     */
    finalizeMergedConditionGroup(anchorConditionId: string): string[] {
        if (this.stateService.displayMode() === 'puzzle') {
            return [];
        }
        const groupMemberIds = this.getConditionGroupMembers(anchorConditionId);
        const removedConditionIds = groupMemberIds.filter((id) => id !== anchorConditionId);
        if (removedConditionIds.length === 0) {
            return [];
        }

        const allMemberNodes = groupMemberIds
            .map((id) => this.getElementById(id))
            .filter((node): node is Condition => node instanceof Condition);

        allMemberNodes.forEach((node) => {
            if (node.baseName) {
                this.stateService.releaseConditionName(node.baseName);
            }
        });
        const newMergedBaseName = this.stateService.generateConditionName();

        this.commitLastPhysicalMergeSnapshot();
        this.lastPhysicalMergeSnapshot.set({
            anchorConditionId,
            drawnElements: this.cloneDrawnElements(this.stateService.drawnElements()),
            connections: this.cloneConnections(this.stateService.connections()),
            mergedConditionAnchorById: { ...this.mergedConditionAnchorById() },
            removedConditionLabels: [],
        });

        const removedConditionIdSet = new Set(removedConditionIds);
        const mergedLabel = this.computeMergedLabel(groupMemberIds);

        const combinedTrailMarkings: Record<string, number> = {};
        for (const memberNode of allMemberNodes) {
            for (const [place, count] of Object.entries(memberNode.trailMarkings)) {
                combinedTrailMarkings[place] = (combinedTrailMarkings[place] ?? 0) + count;
            }
        }

        const isAnyMemberStartPlace = allMemberNodes.some((node) => node.isStartPlace);

        this.stateService.updateDrawnElements((elements) =>
            elements
                .map((node) => {
                    if (node.id === anchorConditionId && node instanceof Condition) {
                        const updated = this.stateService.buildCondition(node.id, mergedLabel, node.tokenCount(), {
                            hideTokens: node.hideTokens,
                            isStartPlace: isAnyMemberStartPlace,
                            labelPlacement: node.labelPlacement,
                            baseName: newMergedBaseName,
                        });
                        updated.trailMarkings = combinedTrailMarkings;
                        updated.updateDynamicLabel();
                        updated.x = node.x;
                        updated.y = node.y;
                        return updated;
                    }
                    return node;
                })
                .filter((node) => !removedConditionIdSet.has(node.id)),
        );

        this.stateService.updateConnections((connections) => {
            const remapped = connections
                .map((connection) => {
                    const mappedSource = removedConditionIdSet.has(connection.source)
                        ? anchorConditionId
                        : connection.source;
                    const mappedTarget = removedConditionIdSet.has(connection.target)
                        ? anchorConditionId
                        : connection.target;
                    return {
                        ...connection,
                        source: mappedSource,
                        target: mappedTarget,
                    };
                })
                .filter(
                    (connection) =>
                        !(connection.source === anchorConditionId && connection.target === anchorConditionId),
                );

            const uniqueByDirection = new Map<string, (typeof remapped)[number]>();
            for (const connection of remapped) {
                const key = `${connection.source}->${connection.target}`;
                if (!uniqueByDirection.has(key)) {
                    uniqueByDirection.set(key, connection);
                }
            }
            return Array.from(uniqueByDirection.values());
        });

        this.mergedConditionAnchorById.update((currentMap) => {
            const nextMap = { ...currentMap };
            for (const removedId of removedConditionIds) {
                delete nextMap[removedId];
            }
            delete nextMap[anchorConditionId];

            for (const [conditionId, mappedAnchorId] of Object.entries(nextMap)) {
                if (removedConditionIdSet.has(mappedAnchorId)) {
                    delete nextMap[conditionId];
                }
            }

            return nextMap;
        });

        this.playMergeAnimation(anchorConditionId);
        return removedConditionIds;
    }

    /**
     * Reverse a finalized merge by splitting the anchor condition back into its component conditions.
     * Parses the merged label to recover the original labels, then recreates conditions in a radial layout.
     *
     * @param anchorConditionId The ID of the merged condition to unmerge.
     * @param shouldMarkAsStartCondition Callback to determine if split conditions should be marked as start nodes.
     */
    unmergeConditionGroup(
        anchorConditionId: string,
        shouldMarkAsStartCondition: (conditionId: string) => boolean,
    ): void {
        if (this.stateService.displayMode() === 'puzzle') {
            return;
        }
        const anchorNode = this.getElementById(anchorConditionId);
        if (!(anchorNode instanceof Condition)) {
            return;
        }

        const mergedLabel = anchorNode.label ?? anchorNode.displayLabel;
        const parsedLabels = this.parseMergedLabel(mergedLabel);

        if (parsedLabels.length <= 1) {
            return;
        }

        if (anchorNode.baseName) {
            this.stateService.releaseConditionName(anchorNode.baseName);
        }

        const newIds: string[] = [];

        this.stateService.updateDrawnElements((elements) => {
            const updated = elements.filter((n) => n.id !== anchorConditionId);

            const firstClone = this.stateService.buildCondition(
                anchorConditionId,
                parsedLabels[0],
                anchorNode.tokenCount(),
                {
                    hideTokens: anchorNode.hideTokens,
                    isStartPlace: shouldMarkAsStartCondition(parsedLabels[0]),
                    labelPlacement: anchorNode.labelPlacement,
                    baseName: anchorConditionId,
                },
            );
            firstClone.trailMarkings = { [parsedLabels[0]]: 1 };
            firstClone.updateDynamicLabel();
            firstClone.x = anchorNode.x;
            firstClone.y = anchorNode.y;
            updated.push(firstClone);
            newIds.push(anchorConditionId);

            const otherLabels = parsedLabels.slice(1);
            otherLabels.forEach((label, index) => {
                const angle = ((index + 1) / otherLabels.length) * 2 * Math.PI;
                const radius = 80;
                const newX = anchorNode.x + Math.cos(angle) * radius;
                const newY = anchorNode.y + Math.sin(angle) * radius;

                const conditionId = this.stateService.generateConditionName();
                const clone = this.stateService.buildCondition(conditionId, label, 0, {
                    hideTokens: anchorNode.hideTokens,
                    isStartPlace: shouldMarkAsStartCondition(label),
                    labelPlacement: anchorNode.labelPlacement,
                    baseName: conditionId,
                });
                clone.trailMarkings = { [label]: 1 };
                clone.updateDynamicLabel();
                clone.x = newX;
                clone.y = newY;
                updated.push(clone);
                newIds.push(conditionId);
            });

            return updated;
        });

        this.stateService.updateConnections((connections) => {
            const newConnections: LabeledNetEdge[] = [];

            for (const conn of connections) {
                if (conn.source === anchorConditionId) {
                    for (let i = 1; i < newIds.length; i++) {
                        const newConnId = this.stateService.generateConnectionId('conn');
                        const newConn = {
                            id: newConnId,
                            source: newIds[i],
                            target: conn.target,
                            weight: conn.weight,
                            bendPoints: [],
                            displayLabel: conn.displayLabel,
                        };
                        newConnections.push(newConn as LabeledNetEdge);
                    }
                }

                if (conn.target === anchorConditionId) {
                    for (let i = 1; i < newIds.length; i++) {
                        const newConnId = this.stateService.generateConnectionId('conn');
                        const newConn = {
                            id: newConnId,
                            source: conn.source,
                            target: newIds[i],
                            weight: conn.weight,
                            bendPoints: [],
                            displayLabel: conn.displayLabel,
                        };
                        newConnections.push(newConn as LabeledNetEdge);
                    }
                }
            }
            return [...connections, ...newConnections];
        });

        this.playMergeAnimation(anchorConditionId);
    }

    /**
     * Handle deletion of a condition: release its name, clean merge graph, and commit any pending snapshots.
     * Called from the component when a condition is deleted.
     */
    handleConditionDelete(condition: Condition): void {
        const lastSnapshot = this.lastPhysicalMergeSnapshot();
        if (lastSnapshot && lastSnapshot.anchorConditionId === condition.id) {
            this.commitLastPhysicalMergeSnapshot();
        }
        this.removeConditionFromMergeGraph(condition.id);
        this.stateService.releaseConditionName(condition.baseName ?? condition.label ?? condition.displayLabel);
    }

    private getElementById(id: string): LabeledNetNode | undefined {
        return this.stateService.drawnElements().find((e) => e.id === id);
    }

    private parseMergedLabel(label: string): string[] {
        const result: string[] = [];
        const parts = label.split(' + ').map((p) => p.trim());

        for (const part of parts) {
            const match = part.match(/^(\d+)\*(.+)$|^(.+)$/);
            if (match) {
                const multiplier = match[1] ? Number.parseInt(match[1], 10) : 1;
                const singleLabel = match[2] || match[3];
                for (let i = 0; i < multiplier; i++) {
                    result.push(singleLabel);
                }
            }
        }

        return result;
    }

    private findConditionMergeTarget(movingCondition: Condition): Condition | null {
        const movingAnchorId = this.resolveConditionAnchorId(movingCondition.id);
        let nearest: { node: Condition; distance: number } | null = null;

        for (const node of this.stateService.drawnElements()) {
            if (!(node instanceof Condition) || node.id === movingCondition.id) {
                continue;
            }

            if (this.resolveConditionAnchorId(node.id) === movingAnchorId) {
                continue;
            }

            const distance = Math.hypot(movingCondition.x - node.x, movingCondition.y - node.y);
            if (distance > this.mergeDropDistance) {
                continue;
            }

            if (!nearest || distance < nearest.distance) {
                nearest = { node, distance };
            }
        }

        return nearest?.node ?? null;
    }

    private mergeConditions(sourceConditionId: string, targetConditionId: string): void {
        const sourceAnchorId = this.resolveConditionAnchorId(sourceConditionId);
        const targetAnchorId = this.resolveConditionAnchorId(targetConditionId);
        if (sourceAnchorId === targetAnchorId) {
            return;
        }

        const sourceGroupMembers = this.getConditionGroupMembers(sourceAnchorId);
        this.mergedConditionAnchorById.update((currentMap) => {
            const nextMap = { ...currentMap };
            for (const memberId of sourceGroupMembers) {
                if (memberId !== targetAnchorId) {
                    nextMap[memberId] = targetAnchorId;
                }
            }
            delete nextMap[targetAnchorId];
            return nextMap;
        });

        this.animateMergedConditionsTowardsAnchor(targetAnchorId);
        this.playMergeAnimation(targetAnchorId);
    }

    unmergeCondition(conditionId: string): void {
        if (this.stateService.displayMode() === 'puzzle') {
            return;
        }
        this.mergedConditionAnchorById.update((currentMap) => {
            if (!currentMap[conditionId]) {
                return currentMap;
            }
            const nextMap = { ...currentMap };
            delete nextMap[conditionId];
            return nextMap;
        });
    }

    private removeConditionFromMergeGraph(conditionId: string): void {
        this.mergedConditionAnchorById.update((currentMap) => {
            const nextMap = { ...currentMap };

            if (nextMap[conditionId]) {
                delete nextMap[conditionId];
                return nextMap;
            }

            const mergedChildren = Object.entries(nextMap)
                .filter(([, anchorId]) => anchorId === conditionId)
                .map(([id]) => id);

            if (mergedChildren.length === 0) {
                return nextMap;
            }

            const [newAnchorId, ...otherChildren] = mergedChildren;
            delete nextMap[newAnchorId];
            for (const childId of otherChildren) {
                nextMap[childId] = newAnchorId;
            }

            return nextMap;
        });
    }

    private animateMergedConditionsTowardsAnchor(anchorConditionId: string): void {
        const anchorNode = this.getElementById(anchorConditionId);
        if (!(anchorNode instanceof Condition)) {
            return;
        }

        const members = this.getConditionGroupMembers(anchorConditionId).filter((id) => id !== anchorConditionId);
        if (members.length === 0) {
            return;
        }

        const placementRadius = Math.max(12, this.conditionRadius * 0.9);
        members.forEach((memberId, index) => {
            const angle = (index / members.length) * 2 * Math.PI;
            const targetX = anchorNode.x + Math.cos(angle) * placementRadius;
            const targetY = anchorNode.y + Math.sin(angle) * placementRadius;
            this.animateConditionPosition(memberId, targetX, targetY, 180);
        });
    }

    private animateConditionPosition(conditionId: string, targetX: number, targetY: number, durationMs: number): void {
        const conditionNode = this.getElementById(conditionId);
        if (!(conditionNode instanceof Condition)) {
            return;
        }

        const startX = conditionNode.x;
        const startY = conditionNode.y;
        const startTime = performance.now();

        const step = (now: number) => {
            const progress = Math.min(1, (now - startTime) / durationMs);
            const eased = 1 - Math.pow(1 - progress, 3);
            const nextX = startX + (targetX - startX) * eased;
            const nextY = startY + (targetY - startY) * eased;

            this.stateService.updateDrawnElements((elements) =>
                elements.map((node) => {
                    if (node.id !== conditionId || !(node instanceof Condition)) {
                        return node;
                    }

                    node.x = nextX;
                    node.y = nextY;
                    return node;
                }),
            );

            if (progress < 1) {
                requestAnimationFrame(step);
            }
        };

        requestAnimationFrame(step);
    }

    private playMergeAnimation(anchorConditionId: string): void {
        this.mergeAnimationAnchorId.set(anchorConditionId);
        if (this.mergeAnimationTimeout) {
            clearTimeout(this.mergeAnimationTimeout);
        }
        this.mergeAnimationTimeout = setTimeout(() => {
            if (this.mergeAnimationAnchorId() === anchorConditionId) {
                this.mergeAnimationAnchorId.set(null);
            }
        }, 220);
    }

    private getConditionGroupMembers(anchorId: string): string[] {
        return this.stateService
            .drawnElements()
            .filter((node): node is Condition => node instanceof Condition)
            .filter((condition) => this.resolveConditionAnchorId(condition.id) === anchorId)
            .map((condition) => condition.id);
    }

    private computeMergedLabel(groupMemberIds: string[]): string {
        const labelCounts = new Map<string, number>();

        for (const id of groupMemberIds) {
            const node = this.getElementById(id);
            if (!(node instanceof Condition)) continue;

            for (const [place, count] of Object.entries(node.trailMarkings)) {
                labelCounts.set(place, (labelCounts.get(place) ?? 0) + count);
            }
        }

        const parts: string[] = [];
        const sortedPlaces = Array.from(labelCounts.keys()).sort((a, b) =>
            a.localeCompare(b, undefined, { numeric: true }),
        );

        for (const label of sortedPlaces) {
            const count = labelCounts.get(label)!;
            if (count > 1) {
                parts.push(`${count}*${label}`);
            } else {
                parts.push(label);
            }
        }

        return parts.length > 0 ? parts.join(' + ') : 'c...';
    }

    private resolveConditionAnchorId(conditionId: string): string {
        const anchorMap = this.mergedConditionAnchorById();
        let anchorId = conditionId;
        const visited = new Set<string>();

        while (anchorMap[anchorId] && !visited.has(anchorId)) {
            visited.add(anchorId);
            anchorId = anchorMap[anchorId];
        }

        return anchorId;
    }

    private commitLastPhysicalMergeSnapshot(): void {
        const lastSnapshot = this.lastPhysicalMergeSnapshot();
        if (!lastSnapshot) {
            return;
        }

        for (const conditionLabel of lastSnapshot.removedConditionLabels) {
            this.stateService.releaseConditionName(conditionLabel);
        }
        this.lastPhysicalMergeSnapshot.set(null);
    }

    private cloneDrawnElements(elements: LabeledNetNode[]): LabeledNetNode[] {
        return elements.map((node) => {
            if (node instanceof Condition) {
                const clone = this.stateService.buildCondition(
                    node.id,
                    node.label ?? node.displayLabel,
                    node.tokenCount(),
                    {
                        hideTokens: node.hideTokens,
                        isStartPlace: node.isStartPlace,
                        baseName: node.baseName,
                    },
                );
                clone.trailMarkings = { ...node.trailMarkings };
                clone.x = node.x;
                clone.y = node.y;
                return clone;
            }

            const clone = this.stateService.buildEvent(node.id, node.displayLabel, node.transitionId);
            clone.x = node.x;
            clone.y = node.y;
            return clone;
        });
    }

    private cloneConnections(connections: LabeledNetEdge[]): LabeledNetEdge[] {
        return connections.map((connection) => {
            const clone = new LabeledNetEdge(connection.id, connection.source, connection.target, connection.weight);
            clone.displayLabel = connection.displayLabel;
            clone.bendPoints = connection.bendPoints.map((point) => ({ x: point.x, y: point.y }));
            return clone;
        });
    }
}
