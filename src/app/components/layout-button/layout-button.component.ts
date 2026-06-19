import { Component, computed, effect, inject, signal } from '@angular/core';
import { MatIcon } from '@angular/material/icon';
import { MatIconButton } from '@angular/material/button';
import { MatTooltip } from '@angular/material/tooltip';
import { MatMenu, MatMenuItem, MatMenuTrigger } from '@angular/material/menu';
import { SpringEmbedderService } from '../../services/spring-embedder.service';
import { SugiyamaService } from '../../services/sugiyama.service';
import { SourcePetriNetService } from '../../services/source-petri-net.service';
import { TranslateModule } from '@ngx-translate/core';
import { DisplayService } from '../../services/display.service';
import { toSignal } from '@angular/core/rxjs-interop';
import { DrawService } from '../../services/draw.service';
import { TabStateService } from '../../services/tab-state.service';
import { Tab } from '../../classes/tabs';
import { CanvasDiagram } from '../../classes/diagram/canvas-diagram';

@Component({
    selector: 'app-layout-button',
    imports: [MatIcon, MatIconButton, MatTooltip, MatMenu, MatMenuItem, MatMenuTrigger, TranslateModule],
    templateUrl: './layout-button.component.html',
    styleUrl: './layout-button.component.css',
})
export class LayoutButtonComponent {
    private _springEmbedderService = inject(SpringEmbedderService);
    private _sugiyamaService = inject(SugiyamaService);
    private _sourceNetService = inject(SourcePetriNetService);
    private _displayService = inject(DisplayService);
    private _drawService = inject(DrawService);
    private _tabStateService = inject(TabStateService);

    private _diagramSignal = toSignal(this._displayService.diagram$);
    private _isCalculating = signal(false);

    public isDisabled = computed(() => !this._diagramSignal() || this._isCalculating());

    constructor() {
        effect(() => {
            this._diagramSignal();
            this._isCalculating.set(false);
        });
    }

    calculateSpringEmbedderLayout() {
        this._isCalculating.set(true);
        let layoutPromise: Promise<void>;

        if (this._tabStateService.currentTab() === Tab.DRAW) {
            const drawnGraph = new CanvasDiagram(this._drawService.drawnElements, this._drawService.connections);
            this._displayService.display(drawnGraph);
            layoutPromise = this._springEmbedderService.calculateLayout(drawnGraph);
        } else {
            layoutPromise = this._springEmbedderService.calculateLayout();
        }

        layoutPromise
            .then(() => this._isCalculating.set(false))
            .catch((error) => {
                this._isCalculating.set(false);
                console.error('Error during layout calculation:', error);
            });
    }

    calculateSugiyamaLayout() {
        this._isCalculating.set(true);
        try {
            const currentTab = this._tabStateService.currentTab();
            if (currentTab === Tab.DRAW) {
                const drawnGraph = new CanvasDiagram(this._drawService.drawnElements, this._drawService.connections);
                this._sugiyamaService.calculateLayout(drawnGraph.getNodes(), drawnGraph.getEdges());
                this._displayService.display(drawnGraph);
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
            this._isCalculating.set(false);
        }
    }
}
