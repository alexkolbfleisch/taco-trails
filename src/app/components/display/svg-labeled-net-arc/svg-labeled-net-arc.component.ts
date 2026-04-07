import { Component, computed, input } from '@angular/core';
import { Coords } from '../../../classes/json-petri-net';
import { DisplayableEdge, DisplayableNode } from '../../../classes/displayable-graph.interface';
import { GeometryUtil } from '../../../utils/geometry.util';
import { computeBendPointsForArc } from '../../../services/arc-parallel-offset.util';
import { VIEW_MODES, ViewMode } from '../display.constants';

@Component({
    selector: 'g[appSvgLabeledNetArc]',
    imports: [],
    templateUrl: './svg-labeled-net-arc.component.html',
    styleUrl: './svg-labeled-net-arc.component.css',
})
export class SvgLabeledNetArcComponent {
    private readonly FALLBACK_LABEL_OFFSET_X = 10;
    private readonly FALLBACK_LABEL_OFFSET_Y = -10;
    private readonly LABEL_NORMAL_OFFSET = 15;

    readonly RADIUS = 7; // Matching SvgStateNodeComponent radius

    readonly diagramArc = input<DisplayableEdge>();
    readonly nodes = input<DisplayableNode[]>([]);
    readonly edges = input<DisplayableEdge[]>([]);
    readonly viewMode = input<ViewMode>(VIEW_MODES.SIMPLE);

    readonly sourceNode = computed(() => {
        const arc = this.diagramArc();
        const nodeList = this.nodes();
        if (!arc || !nodeList) return undefined;
        return nodeList.find((node) => node.id === arc.source);
    });

    readonly targetNode = computed(() => {
        const arc = this.diagramArc();
        const nodeList = this.nodes();
        if (!arc || !nodeList) return undefined;
        return nodeList.find((node) => node.id === arc.target);
    });

    readonly computedBendPoints = computed(() => {
        const arc = this.diagramArc();
        const edges = this.edges();
        const nodes = this.nodes();

        if (!arc || !edges || !nodes) return [];

        if (arc.bendPoints && arc.bendPoints.length > 0) {
            return arc.bendPoints;
        }

        if (arc.source === arc.target) {
            const node = nodes.find((n) => n.id === arc.source);
            if (node) {
                return [
                    { x: node.x - 20, y: node.y - 50 },
                    { x: node.x + 20, y: node.y - 50 },
                ];
            }
        }

        return computeBendPointsForArc(arc, edges, nodes);
    });

    readonly sourceConnectionPoint = computed(() => {
        const source = this.sourceNode();
        const target = this.targetNode();
        const bendPoints = this.computedBendPoints();

        if (!source || !target) return { x: 0, y: 0 };

        const targetPoint = bendPoints.length > 0 ? bendPoints[0] : { x: target.x, y: target.y };
        return this.getConnectionPoint(source, targetPoint);
    });

    readonly targetConnectionPoint = computed(() => {
        const source = this.sourceNode();
        const target = this.targetNode();
        const bendPoints = this.computedBendPoints();

        if (!source || !target) return { x: 0, y: 0 };

        const sourcePoint = bendPoints.length > 0 ? bendPoints[bendPoints.length - 1] : { x: source.x, y: source.y };
        return this.getConnectionPoint(target, sourcePoint);
    });

    readonly pathData = computed(() => {
        const sourcePoint = this.sourceConnectionPoint();
        const targetPoint = this.targetConnectionPoint();
        const bendPoints = this.computedBendPoints();

        if (!this.diagramArc()) return '';

        let path = `M ${sourcePoint.x} ${sourcePoint.y}`;

        // Add bend points if they exist
        if (bendPoints.length > 0) {
            for (const point of bendPoints) {
                path += ` L ${point.x} ${point.y}`;
            }
        }

        path += ` L ${targetPoint.x} ${targetPoint.y}`;

        return path;
    });

    /**
     * Calculates the position for the label.
     * It finds the middle point of the arc path and applies an offset.
     */
    readonly labelPosition = computed(() => {
        const source = this.sourceNode();
        const target = this.targetNode();
        const arc = this.diagramArc();

        if (!source || !target || !arc) return { x: 0, y: 0 };

        const points = this.getArcPathPoints(source, target);
        const midpointData = this.findPathMidpoint(points);

        if (!midpointData) {
            return { x: source.x + this.FALLBACK_LABEL_OFFSET_X, y: source.y + this.FALLBACK_LABEL_OFFSET_Y };
        }

        return this.applyNormalOffset(midpointData.point, midpointData.vector);
    });

    readonly hasLabel = computed(() => {
        const arc = this.diagramArc();
        return arc?.displayLabel && arc.displayLabel.length > 0;
    });

    readonly displayText = computed(() => {
        const arc = this.diagramArc();
        return arc?.displayLabel || '';
    });

    private getConnectionPoint(node: DisplayableNode, targetPoint: Coords): Coords {
        if (this.viewMode() === VIEW_MODES.DESCRIPTIVE) {
            return GeometryUtil.getLabelBoundingBoxIntersection(
                { x: node.x, y: node.y },
                targetPoint,
                node.displayLabel,
            );
        }

        const dx = targetPoint.x - node.x;
        const dy = targetPoint.y - node.y;
        const distance = Math.sqrt(dx * dx + dy * dy);

        if (distance === 0) return { x: node.x, y: node.y };

        const normalizedX = dx / distance;
        const normalizedY = dy / distance;

        // Reachability graph nodes are always circles (StateNodes)
        const radius = this.RADIUS;
        return {
            x: node.x + normalizedX * radius,
            y: node.y + normalizedY * radius,
        };
    }

    /**
     * Constructs the array of points forming the arc geometry.
     * @param source The source node.
     * @param target The target node.
     * @returns Array of coordinates including source, bends, and target.
     */
    private getArcPathPoints(source: DisplayableNode, target: DisplayableNode): Coords[] {
        return [{ x: source.x, y: source.y }, ...this.computedBendPoints(), { x: target.x, y: target.y }];
    }

    /**
     * Finds the geometric midpoint of the path defined by the given points.
     * @param points The points defining the path segments.
     * @returns The midpoint coordinate and the direction vector of the segment containing it, or null if path length is zero.
     */
    private findPathMidpoint(points: Coords[]): { point: Coords; vector: Coords } | null {
        let totalLength = 0;
        // First pass: calculate total length
        for (let i = 0; i < points.length - 1; i++) {
            const dx = points[i + 1].x - points[i].x;
            const dy = points[i + 1].y - points[i].y;
            totalLength += Math.sqrt(dx * dx + dy * dy);
        }

        if (totalLength === 0) return null;

        let targetDistance = totalLength / 2;

        // Second pass: find segment
        for (let i = 0; i < points.length - 1; i++) {
            const p1 = points[i];
            const p2 = points[i + 1];
            const dx = p2.x - p1.x;
            const dy = p2.y - p1.y;
            const len = Math.sqrt(dx * dx + dy * dy);

            if (targetDistance <= len) {
                const t = targetDistance / len;
                return {
                    point: { x: p1.x + dx * t, y: p1.y + dy * t },
                    vector: { x: dx, y: dy },
                };
            }
            targetDistance -= len;
        }

        // Fallback to last segment end
        const p1 = points[points.length - 2];
        const p2 = points[points.length - 1];
        return {
            point: p2,
            vector: { x: p2.x - p1.x, y: p2.y - p1.y },
        };
    }

    /**
     * Calculates the final position by offsetting the point perpendicular to the vector.
     * @param point The base point on the line.
     * @param vector The direction vector of the line.
     * @returns The new coordinate with offset applied.
     */
    private applyNormalOffset(point: Coords, vector: Coords): Coords {
        const len = Math.sqrt(vector.x * vector.x + vector.y * vector.y);
        if (len === 0) return point;

        // Normal vector (-dy, dx)
        const nx = -vector.y / len;
        const ny = vector.x / len;

        const offset = this.LABEL_NORMAL_OFFSET;

        return {
            x: point.x + nx * offset,
            y: point.y + ny * offset,
        };
    }
}
