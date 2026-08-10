import { inject, Injectable, signal } from '@angular/core';
import { SpringEmbedderService } from './spring-embedder.service';
import { SugiyamaService } from './sugiyama.service';
import { SourcePetriNetService } from './source-petri-net.service';
import { DisplayService } from './display.service';
import { DrawService } from './draw.service';
import { TabStateService } from './tab-state.service';
import { TokenTrailStateService } from './token-trail-state.service';
import { Tab } from '../classes/tabs';
import { CanvasDiagram } from '../classes/diagram/canvas-diagram';
import { LabeledNetGraph } from '../classes/labeled-net.model';

@Injectable({
    providedIn: 'root',
})
export class LayoutCalculationService {
    private _springEmbedderService = inject(SpringEmbedderService);
    private _sugiyamaService = inject(SugiyamaService);
    private _sourceNetService = inject(SourcePetriNetService);
    private _displayService = inject(DisplayService);
    private _drawService = inject(DrawService);
    private _tabStateService = inject(TabStateService);
    private _tokenTrailStateService = inject(TokenTrailStateService);

    public readonly isCalculating = signal(false);

    public calculateSpringEmbedderLayout(): Promise<void> {
        this.isCalculating.set(true);
        let layoutPromise: Promise<void>;
        const currentTab = this._tabStateService.currentTab();
        const stateService = this._tabStateService.activeTokenTrailStateService || this._tokenTrailStateService;

        if (currentTab === Tab.DRAW) {
            const drawnGraph = new CanvasDiagram(this._drawService.drawnElements, this._drawService.connections);
            this._displayService.display(drawnGraph);
            layoutPromise = this._springEmbedderService.calculateLayout(drawnGraph);
        } else if (currentTab === Tab.TOKEN_TRAIL) {
            const lpnGraph = new LabeledNetGraph();
            lpnGraph.nodes = stateService.drawnElements();
            lpnGraph.edges = stateService.connections();
            layoutPromise = this._springEmbedderService.calculateLayout(lpnGraph);
        } else {
            layoutPromise = this._springEmbedderService.calculateLayout();
        }

        return layoutPromise
            .then(() => {
                if (currentTab === Tab.TOKEN_TRAIL) {
                    stateService.drawnElements.set([...stateService.drawnElements()]);
                    stateService.connections.set([...stateService.connections()]);
                } else if (currentTab === Tab.DRAW) {
                    this._drawService.drawnElements.set([...this._drawService.drawnElements()]);
                    this._drawService.connections.set([...this._drawService.connections()]);
                }
                this.isCalculating.set(false);
            })
            .catch((error) => {
                this.isCalculating.set(false);
                console.error('Error during layout calculation:', error);
            });
    }

    public async calculateSugiyamaLayout(): Promise<void> {
        this.isCalculating.set(true);
        // Yield execution to allow Angular change detection to update the DOM and disable UI buttons
        await new Promise((resolve) => setTimeout(resolve, 0));
        try {
            const currentTab = this._tabStateService.currentTab();
            const stateService = this._tabStateService.activeTokenTrailStateService || this._tokenTrailStateService;

            if (currentTab === Tab.DRAW) {
                const drawnGraph = new CanvasDiagram(this._drawService.drawnElements, this._drawService.connections);
                this._sugiyamaService.calculateLayout(drawnGraph.getNodes(), drawnGraph.getEdges());
                this._displayService.display(drawnGraph);
                this._drawService.drawnElements.set([...this._drawService.drawnElements()]);
                this._drawService.connections.set([...this._drawService.connections()]);
            } else if (currentTab === Tab.TOKEN_TRAIL) {
                const nodes = stateService.drawnElements();
                const edges = stateService.connections();
                this._sugiyamaService.calculateLayout(nodes, edges);
                stateService.drawnElements.set([...nodes]);
                stateService.connections.set([...edges]);
            } else {
                const diagram = this._sourceNetService.getCurrentSourceNet();
                if (diagram) {
                    this._sugiyamaService.calculateLayout(diagram.allNodes, diagram.arcs);
                    this._sourceNetService.updateEditedNet(diagram);
                }
            }
        } catch (error) {
            console.error('Error during Sugiyama layout calculation:', error);
        } finally {
            this.isCalculating.set(false);
        }
    }
}
