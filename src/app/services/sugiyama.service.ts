import { Injectable } from '@angular/core';
import { LayeredNode, SugiyamaEdge } from '../classes/labeled-net.model';
import { DisplayableEdge, DisplayableNode } from '../classes/displayable-graph.interface';

/**
 * Service for calculating layout positions using the Sugiyama algorithm.
 */
@Injectable({
    providedIn: 'root',
})
export class SugiyamaService {
    /**
     * Calculates the layout for a given set of nodes and edges.
     * @param nodes The nodes to space out and coordinate.
     * @param edges The edges connecting those nodes.
     */
    calculateLayout(nodes: DisplayableNode[], edges: DisplayableEdge[]) {
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

    /**
     * Finds and reverses cycles in the graph to create a Directed Acyclic Graph (DAG).
     * @param edges The edges of the graph.
     * @param nodes The nodes of the graph.
     * @returns A list of edges forming a DAG.
     */
    private cycleBreaking(edges: DisplayableEdge[], nodes: DisplayableNode[]) {
        const allEdges = edges.map((e) => new SugiyamaEdge(e));
        const dagEdges: SugiyamaEdge[] = [];

        const visited = new Set<string>();
        const visiting = new Set<string>();

        const edgeMap = new Map<string, SugiyamaEdge[]>();
        nodes.forEach((n) => edgeMap.set(n.id, []));
        allEdges.forEach((e) => edgeMap.get(e.source)?.push(e));

        const dfs = (nodeId: string) => {
            visiting.add(nodeId);
            const outgoing = edgeMap.get(nodeId) || [];

            for (const edge of outgoing) {
                if (visiting.has(edge.target)) {
                    edge.isReversed = true;
                    const temp = edge.virtualSource;
                    edge.virtualSource = edge.virtualTarget;
                    edge.virtualTarget = temp;
                    dagEdges.push(edge);
                } else if (!visited.has(edge.target)) {
                    dagEdges.push(edge);
                    dfs(edge.target);
                } else {
                    dagEdges.push(edge);
                }
            }
            visiting.delete(nodeId);
            visited.add(nodeId);
        };

        const sources = this.findGraphSources(nodes, allEdges);

        for (const source of sources) {
            if (!visited.has(source.id)) dfs(source.id);
        }
        for (const node of nodes) {
            if (!visited.has(node.id)) dfs(node.id);
        }

        return dagEdges;
    }

    /**
     * Finds the nodes that have an in-degree of 0.
     * @param nodes The graph nodes.
     * @param allEdges All edges in the graph.
     * @returns A list of source nodes.
     */
    private findGraphSources(nodes: DisplayableNode[], allEdges: SugiyamaEdge[]): DisplayableNode[] {
        const inDegree = new Map<string, number>();
        nodes.forEach((n) => inDegree.set(n.id, 0));
        allEdges.forEach((e) => inDegree.set(e.target, (inDegree.get(e.target) || 0) + 1));
        return nodes.filter((n) => inDegree.get(n.id) === 0);
    }

    /**
     * Assigns nodes to logical layers based on their dependencies.
     * @param nodes The nodes of the graph.
     * @param dagEdges The acyclic edges.
     * @returns A map representing the layers of nodes.
     */
    private assignLayers(nodes: DisplayableNode[], dagEdges: SugiyamaEdge[]): Map<number, LayeredNode[]> {
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

    /**
     * Adds dummy nodes to edges that span across multiple layers to maintain uniform connectivity.
     * @param layeredGraph The layered graph map.
     * @param dagEdges The acyclic edges.
     * @returns An object containing the extended layers map and modified edges.
     */
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

    /**
     * Minimizes edge crossings by sorting nodes within each layer iteratively.
     * @param layeredGraph Map of layer indices to arrays of layered nodes.
     * @param dagEdges Edges connected between layers.
     * @returns The optimized layered graph representation.
     */
    private minimizeCrossings(
        layeredGraph: Map<number, LayeredNode[]>,
        dagEdges: SugiyamaEdge[],
    ): Map<number, LayeredNode[]> {
        const layersCount = Math.max(...Array.from(layeredGraph.keys())) + 1;
        const iterations = 15;

        for (let iter = 0; iter < iterations; iter++) {
            for (let i = 1; i < layersCount; i++) {
                if (!layeredGraph.has(i)) continue;
                this.barycenterSort(layeredGraph.get(i)!, layeredGraph.get(i - 1)!, dagEdges, true);
            }
            for (let i = layersCount - 2; i >= 0; i--) {
                if (!layeredGraph.has(i)) continue;
                this.barycenterSort(layeredGraph.get(i)!, layeredGraph.get(i + 1)!, dagEdges, false);
            }
        }
        return layeredGraph;
    }

    /**
     * Sorts the nodes in a layer using the barycenter heuristic to reduce edge crossings.
     * @param layer The layer of nodes to sort.
     * @param referenceLayer The neighboring layer to act as the positional reference.
     * @param edges Connectivity between layers.
     * @param forward Determines the orientation to analyze adjacent connections.
     */
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

        layer.sort((a, b) => {
            const valA = barycenters.get(a.id) || 0;
            const valB = barycenters.get(b.id) || 0;
            if (Math.abs(valA - valB) < 0.01) {
                return 0;
            }
            return valA - valB;
        });
    }

    /**
     * Computes final coordinate positions for all configured layered nodes.
     * @param layeredGraph Structured node layout by tiers.
     */
    private positionNodes(layeredGraph: Map<number, LayeredNode[]>) {
        const layerWidth = 150;
        const nodeSpacing = 100;

        const layers = Array.from(layeredGraph.keys()).sort((a, b) => a - b);

        const layerHeights = this.calculateLayerHeights(layers, layeredGraph, nodeSpacing);
        const maxHeight = Math.max(...Array.from(layerHeights.values()));

        this.applyLeftToRightPositions(layers, layeredGraph, layerHeights, maxHeight, layerWidth, nodeSpacing);
    }

    /**
     * Computes the vertical heights populated per layer based on node spacing.
     * @param layers Array of layer ids in order.
     * @param layeredGraph Mapped association of layers and their nodes.
     * @param nodeSpacing Physical vertical separation gap.
     * @returns A map representing computed vertical height requirement offsets.
     */
    private calculateLayerHeights(
        layers: number[],
        layeredGraph: Map<number, LayeredNode[]>,
        nodeSpacing: number,
    ): Map<number, number> {
        const layerHeights = new Map<number, number>();
        for (const layerIdx of layers) {
            const nodes = layeredGraph.get(layerIdx)!;
            const height = (nodes.length - 1) * nodeSpacing;
            layerHeights.set(layerIdx, height);
        }
        return layerHeights;
    }

    /**
     * Applies standard coordinates to physical layered node spaces processing layers linearly left to right.
     * @param layers Array of layer ids sequentially.
     * @param layeredGraph Mapping representing nodes logically partitioned by tiers.
     * @param layerHeights Evaluated coordinate heights offset by tier mapping.
     * @param maxHeight Maximum required height alignment constraint limits.
     * @param layerWidth Structural uniform separation.
     * @param nodeSpacing Height offset unit scale per element node spacing step.
     */
    private applyLeftToRightPositions(
        layers: number[],
        layeredGraph: Map<number, LayeredNode[]>,
        layerHeights: Map<number, number>,
        maxHeight: number,
        layerWidth: number,
        nodeSpacing: number,
    ) {
        for (const layerIdx of layers) {
            const nodes = layeredGraph.get(layerIdx)!;
            const layerX = layerIdx * layerWidth;
            const layerHeight = layerHeights.get(layerIdx)!;
            let currentY = (maxHeight - layerHeight) / 2;

            for (const node of nodes) {
                node.x = layerX + 50;
                node.y = currentY + 50;
                currentY += nodeSpacing;
            }
        }
    }

    /**
     * Propagates layout positions from graph structures directly to user node rendering elements.
     * @param nodes Global base array representing visual models.
     * @param edges Original connector dependencies.
     * @param layeredGraph Analyzed layered configurations determining x and y bounds.
     * @param extendedDagEdges Intermediate connectivity processing details utilized for rendering line adjustments.
     */
    private applyLayout(
        nodes: DisplayableNode[],
        edges: DisplayableEdge[],
        layeredGraph: Map<number, LayeredNode[]>,
        extendedDagEdges: SugiyamaEdge[],
    ) {
        this.applyNodeCoordinates(nodes, layeredGraph);
        this.applyBendpoints(edges, layeredGraph, extendedDagEdges);
    }

    /**
     * Translates coordinates from internal layering calculation graph items directly onto final user structure representations.
     * @param nodes Output layout destinations nodes representations structure array references.
     * @param layeredGraph Analyzed layered properties bounds objects definitions constraints structure tree details source limits structures parameters setup.
     */
    private applyNodeCoordinates(nodes: DisplayableNode[], layeredGraph: Map<number, LayeredNode[]>) {
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
    }

    /**
     * Distributes structured bendpoint positions derived from hidden logical structures along their respective graph display lines connections geometries mapping.
     * @param edges Connective models bounds visual structures arrays mappings configuration details bindings.
     * @param layeredGraph Analyzed layout elements mapping representation reference source details tree definitions bounds object limitations limitations structures layouts.
     * @param extendedDagEdges Logical intermediate configuration mappings setup representing logical line route segments restrictions settings.
     */
    private applyBendpoints(
        edges: DisplayableEdge[],
        layeredGraph: Map<number, LayeredNode[]>,
        extendedDagEdges: SugiyamaEdge[],
    ) {
        for (const edge of edges) {
            edge.bendPoints = [];

            const paths = extendedDagEdges.filter((e) => e.originalEdge?.id === edge.id);
            if (paths.length > 1) {
                this.traceDummyPath(edge, paths, layeredGraph);
            }
        }
    }

    /**
     * Detects mapped connector locations matching paths logical points setup.
     * @param edge Single connective line instance bounds limits details limits limits layouts formats setups limitations representations.
     * @param paths Multiple sequential sub components connecting logically structures boundaries elements references setups implementations.
     * @param layeredGraph Analyzed layered properties representations definitions constraints limits dependencies configuration restrictions mappings.
     */
    private traceDummyPath(edge: DisplayableEdge, paths: SugiyamaEdge[], layeredGraph: Map<number, LayeredNode[]>) {
        const dummies = paths
            .map((p) => p.virtualTarget)
            .map((id) => this.findNodeInLayers(layeredGraph, id))
            .filter((n) => n?.isDummy) as LayeredNode[];

        const sourceNode = this.findNodeInLayers(layeredGraph, edge.source);
        const targetNode = this.findNodeInLayers(layeredGraph, edge.target);

        if (sourceNode && targetNode) {
            if (sourceNode.layer < targetNode.layer) {
                dummies.sort((a, b) => a.layer - b.layer);
            } else {
                dummies.sort((a, b) => b.layer - a.layer);
            }
        }

        edge.bendPoints = dummies.map((d) => ({ x: d.x, y: d.y }));
    }

    /**
     * Finds a single node reference in the layered graph by matching ID key identifier strings names texts patterns bounds definitions.
     * @param layeredGraph Analyzed layered configurations reference mapped arrays properties keys.
     * @param id Identifier keys limits constants bindings values descriptions setups properties setups mappings parameters variables limits boundaries string.
     * @returns The corresponding LayeredNode elements object instance representations definitions constraints reference formats dependencies definitions implementations layouts parameters interfaces maps limits values references setups implementations variables parameters setups items models mappings layouts setups representations string mappings layouts mappings bindings configurations definitions mappings bindings models restrictions setups mappings layouts interfaces limits properties setups mappings configurations mappings specifications implementations keys components text constants representations values layouts definitions implementations arrays implementations structures representations elements structures components elements representations constraints definitions items.
     */
    private findNodeInLayers(layeredGraph: Map<number, LayeredNode[]>, id: string): LayeredNode | undefined {
        for (const layer of layeredGraph.values()) {
            const found = layer.find((n) => n.id === id);
            if (found) return found;
        }
        return undefined;
    }
}
