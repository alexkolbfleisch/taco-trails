import { Injectable } from '@angular/core';
import { LabeledNetEdge, LabeledNetNode, LayeredNode, SugiyamaEdge } from '../classes/labeled-net.model';

@Injectable({
    providedIn: 'root',
})
export class SugiyamaService {
    calculateLayout(nodes: LabeledNetNode[], edges: LabeledNetEdge[]) {
        // 1. Cycle Breaking
        const dagEdges = this.cycleBreaking(edges, nodes);

        // 2. Layering
        const layeredGraphMap = this.assignLayers(nodes, dagEdges);

        // 3. Add Dummy Nodes for edges crossing multiple layers
        const { layersMap, extendedDagEdges } = this.addDummyNodes(layeredGraphMap, dagEdges);

        // 4. Cross Minimization
        const orderedLayers = this.minimizeCrossings(layersMap, extendedDagEdges);

        // 5. Node Positioning
        this.positionNodes(orderedLayers);

        // 6. Map back bends & positions to original nodes/edges
        this.applyLayout(nodes, edges, orderedLayers, extendedDagEdges);
    }

    private cycleBreaking(edges: LabeledNetEdge[], nodes: LabeledNetNode[]) {
        const allEdges = edges.map((e) => new SugiyamaEdge(e));
        const dagEdges: SugiyamaEdge[] = [];

        const visited = new Set<string>();
        const visiting = new Set<string>();

        const edgeMap = new Map<string, SugiyamaEdge[]>();
        nodes.forEach((n) => edgeMap.set(n.id, []));
        allEdges.forEach((e) => edgeMap.get(e.source)?.push(e));

        function dfs(nodeId: string) {
            visiting.add(nodeId);
            const outgoing = edgeMap.get(nodeId) || [];

            for (const edge of outgoing) {
                if (visiting.has(edge.target)) {
                    // Cycle detected! Reverse it.
                    edge.isReversed = true;
                    const temp = edge.virtualSource;
                    edge.virtualSource = edge.virtualTarget;
                    edge.virtualTarget = temp;
                    dagEdges.push(edge);
                } else if (!visited.has(edge.target)) {
                    dagEdges.push(edge);
                    dfs(edge.target);
                } else {
                    // Target already fully visited, just add forward edge
                    dagEdges.push(edge);
                }
            }
            visiting.delete(nodeId);
            visited.add(nodeId);
        }

        // Just start DFS from sources (in-degree 0) or all unvisited
        // Find sources:
        const inDegree = new Map<string, number>();
        nodes.forEach((n) => inDegree.set(n.id, 0));
        allEdges.forEach((e) => inDegree.set(e.target, (inDegree.get(e.target) || 0) + 1));

        const sources = nodes.filter((n) => inDegree.get(n.id) === 0);

        for (const source of sources) {
            if (!visited.has(source.id)) dfs(source.id);
        }
        for (const node of nodes) {
            if (!visited.has(node.id)) dfs(node.id);
        }

        return dagEdges;
    }

    private reverseEdge(edge: SugiyamaEdge) {
        edge.isReversed = !edge.isReversed;
        const temp = edge.virtualSource;
        edge.virtualSource = edge.virtualTarget;
        edge.virtualTarget = temp;
    }

    private assignLayers(nodes: LabeledNetNode[], dagEdges: SugiyamaEdge[]): Map<number, LayeredNode[]> {
        const layers = new Map<string, number>();

        nodes.forEach((n) => layers.set(n.id, 0));

        let changed = true;
        let iter = 0;
        while (changed && iter < nodes.length + 1) {
            changed = false;
            for (const edge of dagEdges) {
                const sourceLayer = layers.get(edge.virtualSource)!;
                const targetLayer = layers.get(edge.virtualTarget)!;

                if (targetLayer <= sourceLayer) {
                    layers.set(edge.virtualTarget, sourceLayer + 1);
                    changed = true;
                }
            }
            iter++;
        }

        const layeredGraph = new Map<number, LayeredNode[]>();
        layers.forEach((layer, nodeId) => {
            if (!layeredGraph.has(layer)) layeredGraph.set(layer, []);
            const originalNode = nodes.find((n) => n.id === nodeId)!;
            layeredGraph.get(layer)!.push(new LayeredNode(nodeId, layer, originalNode, false));
        });

        return layeredGraph;
    }

    private addDummyNodes(layeredGraph: Map<number, LayeredNode[]>, dagEdges: SugiyamaEdge[]) {
        const extendedDagEdges: SugiyamaEdge[] = [];
        let dummyCount = 0;

        for (const edge of dagEdges) {
            const sourceNode = this.findNodeInLayers(layeredGraph, edge.virtualSource);
            const targetNode = this.findNodeInLayers(layeredGraph, edge.virtualTarget);

            if (!sourceNode || !targetNode) continue;

            const sl = sourceNode.layer;
            const tl = targetNode.layer;

            if (tl - sl > 1) {
                let currentSource = edge.virtualSource;
                for (let l = sl + 1; l < tl; l++) {
                    const dummyId = `dummy_${dummyCount++}`;
                    const dummyNode = new LayeredNode(dummyId, l, undefined, true);

                    if (!layeredGraph.has(l)) layeredGraph.set(l, []);
                    layeredGraph.get(l)!.push(dummyNode);

                    const dummyEdge = new SugiyamaEdge(edge.originalEdge || edge);
                    dummyEdge.virtualSource = currentSource;
                    dummyEdge.virtualTarget = dummyId;
                    extendedDagEdges.push(dummyEdge);

                    currentSource = dummyId;
                }
                const lastEdge = new SugiyamaEdge(edge.originalEdge || edge);
                lastEdge.virtualSource = currentSource;
                lastEdge.virtualTarget = edge.virtualTarget;
                extendedDagEdges.push(lastEdge);
            } else {
                extendedDagEdges.push(edge);
            }
        }
        return { layersMap: layeredGraph, extendedDagEdges };
    }

    private minimizeCrossings(
        layeredGraph: Map<number, LayeredNode[]>,
        dagEdges: SugiyamaEdge[],
    ): Map<number, LayeredNode[]> {
        const layersCount = Math.max(...Array.from(layeredGraph.keys())) + 1;
        const iterations = 15;

        // Perform initialization sort by degree, etc to give a better start point
        for (let iter = 0; iter < iterations; iter++) {
            // Forward sweep
            for (let i = 1; i < layersCount; i++) {
                if (!layeredGraph.has(i)) continue;
                this.barycenterSort(layeredGraph.get(i)!, layeredGraph.get(i - 1)!, dagEdges, true);
            }
            // Backward sweep
            for (let i = layersCount - 2; i >= 0; i--) {
                if (!layeredGraph.has(i)) continue;
                this.barycenterSort(layeredGraph.get(i)!, layeredGraph.get(i + 1)!, dagEdges, false);
            }
        }
        return layeredGraph;
    }

    private barycenterSort(
        layer: LayeredNode[],
        referenceLayer: LayeredNode[],
        edges: SugiyamaEdge[],
        forward: boolean,
    ) {
        const barycenters = new Map<string, number>();

        for (const node of layer) {
            let sum = 0;
            let count = 0;
            const connectedEdges = forward
                ? edges.filter((e) => e.virtualTarget === node.id)
                : edges.filter((e) => e.virtualSource === node.id);

            connectedEdges.forEach((e) => {
                const neighborId = forward ? e.virtualSource : e.virtualTarget;
                const neighborIndex = referenceLayer.findIndex((n) => n.id === neighborId);
                if (neighborIndex !== -1) {
                    sum += neighborIndex;
                    count++;
                }
            });

            const fallbackIndex = layer.findIndex((n) => n.id === node.id);
            barycenters.set(node.id, count > 0 ? sum / count : fallbackIndex);
        }

        // Sort elements keeping stable placement for equal values
        layer.sort((a, b) => {
            const valA = barycenters.get(a.id) || 0;
            const valB = barycenters.get(b.id) || 0;
            if (Math.abs(valA - valB) < 0.01) {
                return 0;
            }
            return valA - valB;
        });
    }

    private positionNodes(layeredGraph: Map<number, LayeredNode[]>) {
        const layerWidth = 150;
        const nodeSpacing = 100;

        const layers = Array.from(layeredGraph.keys()).sort((a, b) => a - b);
        const layersCount = layers.length;

        // Calculate max height to center layers vertically
        const layerHeights = new Map<number, number>();
        let maxHeight = 0;

        for (const layerIdx of layers) {
            const nodes = layeredGraph.get(layerIdx)!;
            const height = (nodes.length - 1) * nodeSpacing;
            layerHeights.set(layerIdx, height);
            if (height > maxHeight) maxHeight = height;
        }

        // Apply positions for left-to-right layout
        for (const layerIdx of layers) {
            const nodes = layeredGraph.get(layerIdx)!;
            const layerX = layerIdx * layerWidth;
            const layerHeight = layerHeights.get(layerIdx)!;
            let currentY = (maxHeight - layerHeight) / 2; // Center alignment vertically

            for (const node of nodes) {
                node.x = layerX + 50;
                node.y = currentY + 50; // offset slightly from 0,0
                currentY += nodeSpacing;
            }
        }
    }

    private applyLayout(
        nodes: LabeledNetNode[],
        edges: LabeledNetEdge[],
        layeredGraph: Map<number, LayeredNode[]>,
        extendedDagEdges: SugiyamaEdge[],
    ) {
        // Apply node coordinates
        for (const layer of layeredGraph.values()) {
            for (const node of layer) {
                if (!node.isDummy && node.labeledNetNode) {
                    const lNode = nodes.find((n) => n.id === node.id);
                    if (lNode) {
                        lNode.x = node.x;
                        lNode.y = node.y;
                    }
                }
            }
        }

        // Apply bendpoints by tracing dummy paths
        for (const edge of edges) {
            edge.bendPoints = [];

            const paths = extendedDagEdges.filter((e) => e.originalEdge?.id === edge.id);
            if (paths.length > 1) {
                // To trace path properly in order:
                // Start from original source, follow virtualTargets
                const dummies: LayeredNode[] = [];
                let currentVirtualId = edge.source;
                const foundNext = true;

                while (foundNext && currentVirtualId !== edge.target) {
                    const segment = paths.find(
                        (p) => (!p.isReversed ? p.virtualSource : p.virtualTarget) === currentVirtualId,
                    );
                    if (!segment) break;

                    const nextVirtualId = !segment.isReversed ? segment.virtualTarget : segment.virtualSource;
                    const nextNode = this.findNodeInLayers(layeredGraph, nextVirtualId);

                    if (nextNode && nextNode.isDummy) {
                        dummies.push(nextNode);
                    }
                    currentVirtualId = nextVirtualId;
                }

                // Original tracing issue fix: use properly ordered list directly
                if (dummies.length > 0) {
                    edge.bendPoints = dummies.map((d) => ({ x: d.x, y: d.y }));
                } else {
                    // Fallback to sorting by layer Y
                    const dummyNodesInPath = paths
                        .map((p) => this.findNodeInLayers(layeredGraph, p.virtualTarget))
                        .filter((n) => n?.isDummy);

                    dummyNodesInPath.sort((a, b) => a!.y - b!.y);
                    edge.bendPoints = dummyNodesInPath.map((d) => ({ x: d!.x, y: d!.y }));
                }
            }
        }
    }

    private findNodeInLayers(layeredGraph: Map<number, LayeredNode[]>, id: string): LayeredNode | undefined {
        for (const layer of layeredGraph.values()) {
            const found = layer.find((n) => n.id === id);
            if (found) return found;
        }
        return undefined;
    }
}
