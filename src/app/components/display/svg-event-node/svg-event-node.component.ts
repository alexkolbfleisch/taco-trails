import { Component, computed, inject, input, output, signal } from '@angular/core';
import { Coords } from '../../../classes/json-petri-net';
import { SHAPE } from '../../../classes/diagram/diagram-node';
import { DisplayableNode } from '../../../classes/displayable-graph.interface';
import { Condition } from '../../../classes/labeled-net.model';
import { PLACE_RADIUS, TRANSITION_SIZE } from '../display.constants';
import { LpnDisplayMode } from '../../../services/token-trail-state.service';
import { TabStateService } from '../../../services/tab-state.service';

@Component({
    selector: 'g[appSvgEventNode]',
    imports: [],
    templateUrl: './svg-event-node.component.html',
    styleUrl: './svg-event-node.component.css',
})
export class SvgEventNodeComponent {
    private readonly _tabStateService = inject(TabStateService);

    readonly RADIUS = PLACE_RADIUS;
    readonly EVENT_SIZE = TRANSITION_SIZE;
    readonly MAX_CHARS = 15;

    readonly rectWidth = computed(() => {
        return this.EVENT_SIZE;
    });

    readonly diagramNode = input<DisplayableNode>();

    readonly displayMode = input<LpnDisplayMode>(LpnDisplayMode.Puzzle);
    readonly selected = input<boolean>(false);

    clickNode = output<DisplayableNode>();

    readonly fillColor = signal('white');

    readonly eventFillColor = computed(() => {
        return this.fillColor();
    });

    readonly eventStrokeColor = computed(() => {
        return 'black';
    });

    readonly eventStrokeWidth = computed(() => {
        return 2;
    });

    readonly eventCornerRadius = computed(() => {
        return 0;
    });

    readonly conditionFillColor = computed(() => {
        const node = this.diagramNode();
        if (node instanceof Condition && node.highlightColor()) {
            return node.highlightColor()!;
        }
        return this.fillColor();
    });

    readonly isEvent = computed(() => {
        return this.diagramNode()?.shape === SHAPE.RECT;
    });

    readonly isCondition = computed(() => {
        return this.diagramNode()?.shape === SHAPE.CIRCLE;
    });

    /**
     * Truncated display label for the node, adding ellipsis if it exceeds MAX_CHARS.
     */
    readonly displayLabel = computed(() => {
        const n = this.diagramNode();
        let label = n?.displayLabel || '';

        if (n instanceof Condition && this.displayMode() === LpnDisplayMode.Puzzle) {
            label = n.baseName || n.displayLabel || '';
        }

        if (label.length > this.MAX_CHARS) {
            return label.substring(0, this.MAX_CHARS) + '...';
        }
        return label;
    });

    /**
     * Untruncated full display label for the node, used for hover tooltips.
     */
    readonly fullLabel = computed(() => {
        const n = this.diagramNode();
        if (n instanceof Condition && this.displayMode() === LpnDisplayMode.Puzzle) {
            return n.baseName || n.displayLabel || '';
        }
        return n?.displayLabel || '';
    });

    readonly conditionLabelClass = computed(() => 'node-label');
    readonly eventLabelClass = computed(() => 'event-label event-label-inside');

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

    readonly hideTokens = computed(() => {
        const node = this.diagramNode();
        return node instanceof Condition ? node.hideTokens : false;
    });

    readonly rectX = computed(() => {
        const node = this.diagramNode();
        return node ? node.x - this.rectWidth() / 2 : 0;
    });

    readonly rectY = computed(() => {
        const node = this.diagramNode();
        return node ? node.y - this.EVENT_SIZE / 2 : 0;
    });

    readonly textX = computed(() => {
        const node = this.diagramNode();
        return node ? node.x : 0;
    });

    readonly textY = computed(() => {
        const node = this.diagramNode();
        if (!node) return 0;
        return this.isEvent() ? node.y : node.y + this.RADIUS + 15;
    });

    readonly tokenPositions = computed(() => {
        const node = this.diagramNode();
        const tokens = this.tokenCount();

        if (!node || !this.isCondition() || tokens === 0 || this.hideTokens()) return [];

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
        return this.isCondition() && this.tokenCount() > 6 && !this.hideTokens();
    });

    // Computed values for selection highlighting
    readonly isSelected = computed(() => this.selected());
    readonly selectionStrokeColor = computed(() => (this.isSelected() ? 'orange' : 'transparent'));

    readonly isStartPlace = computed(() => {
        const node = this.diagramNode();
        return node instanceof Condition ? node.isStartPlace : false;
    });
}
