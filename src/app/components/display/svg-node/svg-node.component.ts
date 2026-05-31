import { Component, computed, inject, input, output, signal } from '@angular/core';
import { Coords } from '../../../classes/json-petri-net';
import { SHAPE } from '../../../classes/diagram/diagram-node';
import { DisplayableNode } from '../../../classes/displayable-graph.interface';
import { ModeService } from '../../../services/mode.service';
import { TabStateService } from '../../../services/tab-state.service';
import { PlayService } from '../../../services/play.service';
import { DiagramTransition } from '../../../classes/diagram/diagram-transition';
import { DiagramPlace } from '../../../classes/diagram/diagram-place';
import { StateNode } from '../../../classes/reachability-graph.model';
import { PLACE_RADIUS, TRANSITION_SIZE } from '../display.constants';

@Component({
    selector: 'g[appSvgNode]',
    imports: [],
    templateUrl: './svg-node.component.html',
    styleUrl: './svg-node.component.css',
})
export class SvgNodeComponent {
    readonly RADIUS = PLACE_RADIUS;
    readonly TRANSITION_SIZE = TRANSITION_SIZE;
    readonly MAX_CHARS = 15;

    readonly rectWidth = computed(() => {
        return this.TRANSITION_SIZE;
    });

    readonly diagramNode = input<DisplayableNode>();
    private _modeService = inject(ModeService);
    private _tabStateService = inject(TabStateService);
    private _playService = inject(PlayService);

    readonly showInnerLabel = input<boolean>(false);
    readonly transitionLabelPlacement = input<'inside' | 'below'>('inside');
    readonly disableActiveColoring = input<boolean>(false);
    readonly fillColorOverride = input<string | null>(null);

    readonly isTransitionAndActive = computed(() => {
        if (this.disableActiveColoring()) return false;
        const node = this.diagramNode();
        if (node instanceof DiagramTransition) {
            return (
                this._playService.canBeFired(node) && !this._modeService.isExamMode(this._tabStateService.currentTab())
            );
        }
        return false;
    });

    readonly isFiring = computed(() => {
        const node = this.diagramNode();
        if (node instanceof DiagramTransition) {
            return node.isFiring();
        }
        return false;
    });

    // Mark if this node is currently selected (for connection creation)
    readonly selected = input<boolean>(false);

    clickNode = output<DisplayableNode>();

    stateNodeClick = output<StateNode>();

    readonly fillColor = signal('white');

    readonly transitionFillColor = computed(() => {
        if (this.isFiring()) {
            return 'lime';
        }
        if (this.fillColorOverride()) {
            return this.fillColorOverride()!;
        }
        return this.fillColor();
    });

    readonly transitionStrokeColor = computed(() => {
        if (this.isFiring() || this.isTransitionAndActive()) {
            return 'green';
        }
        return 'black';
    });

    readonly transitionStrokeWidth = computed(() => {
        if (this.isFiring() || this.isTransitionAndActive()) {
            return 4;
        }
        return 2;
    });

    readonly transitionCornerRadius = computed(() => {
        if (this.isFiring() || this.isTransitionAndActive()) {
            return 5;
        }
        return 0;
    });

    readonly placeFillColor = computed(() => {
        if (this.fillColorOverride()) {
            return this.fillColorOverride()!;
        }
        return this.fillColor();
    });

    readonly isTransition = computed(() => {
        return this.diagramNode()?.shape === SHAPE.RECT;
    });

    readonly isPlace = computed(() => {
        return this.diagramNode()?.shape === SHAPE.CIRCLE;
    });

    /**
     * Truncated display label for the node, adding ellipsis if it exceeds MAX_CHARS.
     */
    readonly displayLabel = computed(() => {
        const label = this.diagramNode()?.displayLabel || '';
        if (label.length > this.MAX_CHARS && !(this.diagramNode() instanceof StateNode)) {
            return label.substring(0, this.MAX_CHARS) + '...';
        }
        return label;
    });

    readonly innerLabel = computed(() => {
        const node = this.diagramNode();
        if (node instanceof DiagramPlace) {
            return node.innerLabel;
        }
        if (node instanceof DiagramTransition) {
            return node.innerLabel;
        }
        return undefined;
    });

    readonly isStartPlace = computed(() => {
        return false;
    });

    readonly shouldShowInnerLabel = computed(() => this.showInnerLabel() && !!this.innerLabel());

    readonly innerLabelClass = computed(() => (this.isTransition() ? 'transition-inner-label' : 'place-label-inside'));

    readonly transitionLabelClass = computed(() => {
        if (!this.isTransition()) {
            return 'node-label';
        }
        return this.transitionLabelPlacement() === 'inside'
            ? 'transition-label transition-label-inside'
            : 'transition-label transition-label-below';
    });

    readonly tokenCount = computed(() => {
        return this.diagramNode()?.tokenCount() || 0;
    });

    readonly circleX = computed(() => {
        const node = this.diagramNode();
        return node ? node.x : 0;
    });

    readonly circleY = computed(() => {
        const node = this.diagramNode();
        return node ? node.y : 0;
    });

    readonly labelPlacement = computed(() => {
        const node = this.diagramNode();
        if (node instanceof DiagramPlace) {
            return node.labelPlacement;
        }
        return 'below';
    });

    readonly hideTokens = computed(() => {
        const node = this.diagramNode();
        return node instanceof DiagramPlace ? node.hideTokens : false;
    });

    readonly rectX = computed(() => {
        const node = this.diagramNode();
        return node ? node.x - this.rectWidth() / 2 : 0;
    });

    readonly rectY = computed(() => {
        const node = this.diagramNode();
        return node ? node.y - this.TRANSITION_SIZE / 2 : 0;
    });

    readonly textX = computed(() => {
        const node = this.diagramNode();
        return node ? node.x : 0;
    });

    readonly textY = computed(() => {
        const node = this.diagramNode();
        if (!node) return 0;

        if (this.isTransition()) {
            return this.transitionLabelPlacement() === 'below' ? node.y + this.TRANSITION_SIZE / 2 + 15 : node.y;
        }

        if (node instanceof DiagramPlace && this.labelPlacement() === 'inside') {
            return node.y;
        }

        return node.y + this.RADIUS + 15;
    });

    readonly tokenPositions = computed(() => {
        const node = this.diagramNode();
        const tokens = this.tokenCount();

        if (!node || !this.isPlace() || tokens === 0 || this.hideTokens()) return [];

        const positions: Coords[] = [];

        if (tokens === 1) {
            // Single token in center
            positions.push({ x: node.x, y: node.y });
        } else if (tokens <= 6) {
            // Multiple tokens arranged in a circle
            const angleStep = (2 * Math.PI) / tokens;
            const tokenRadius = this.RADIUS * 0.6;

            for (let i = 0; i < tokens; i++) {
                const angle = i * angleStep;
                positions.push({
                    x: node.x + Math.cos(angle) * tokenRadius,
                    y: node.y + Math.sin(angle) * tokenRadius,
                });
            }
        } else {
            // For many tokens, just show the number
            return [];
        }

        return positions;
    });

    readonly showTokenNumber = computed(() => {
        return this.isPlace() && this.tokenCount() > 6 && !this.hideTokens();
    });

    // Computed values for selection highlighting
    readonly isSelected = computed(() => !!this.selected());
    readonly selectionStrokeColor = computed(() => (this.isSelected() ? 'orange' : 'transparent'));

    public click() {
        const node = this.diagramNode();
        if (node) this.clickNode.emit(node);
    }

    public circleClick() {
        const node = this.diagramNode();
        if (node) this.stateNodeClick.emit(node as StateNode);
    }
}
