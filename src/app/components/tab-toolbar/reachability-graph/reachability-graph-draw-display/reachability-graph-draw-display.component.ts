import { Component, computed, effect, inject, signal } from '@angular/core';
import { SvgStateNodeComponent } from '../../../display/svg-state-node/svg-state-node.component';
import { SvgStateArcComponent } from '../../../display/svg-state-arc/svg-state-arc.component';
import { PanningService } from 'src/app/services/panning.service';
import { DisplayComponent } from 'src/app/components/display/display.component';
import { GRAPH_IDS, VIEW_MODES, ViewMode } from '../../../display/display.constants';
import {
    DrawToolbarAction,
    DrawToolbarComponent,
    DrawToolbarInstruction,
} from '../../../draw-toolbar/draw-toolbar.component';
import { DisplayableNode } from '../../../../classes/displayable-graph.interface';
import { StateNode } from '../../../../classes/reachability-graph.model';
import { ModeService } from '../../../../services/mode.service';
import { Tab } from '../../../../classes/tabs';
import { TranslateModule } from '@ngx-translate/core';
import { ToasterNotificationService } from '../../../../services/toaster-notification.service';

@Component({
    selector: 'app-reachability-graph-draw-display',
    standalone: true,
    imports: [SvgStateNodeComponent, SvgStateArcComponent, DrawToolbarComponent, TranslateModule],
    providers: [PanningService],
    templateUrl: './reachability-graph-draw-display.component.html',
    styleUrl: './reachability-graph-draw-display.component.css',
})
export class ReachabilityGraphDrawDisplayComponent extends DisplayComponent {
    protected override graphId = GRAPH_IDS.REACHABILITY;
    private _toasterService = inject(ToasterNotificationService);

    override processDropEvent(e: DragEvent) {
        e.preventDefault();
        this.isDragOver.set(false);
        if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
            this._toasterService.showWarning('TOASTER.HEADER.UPLOAD_RESTRICTED', 'TOASTER.BODY.UPLOAD_RG_RESTRICTED');
        }
    }

    readonly userReachabilityGraphDiagram = this._reachabilityGraphService.reachabilityGraphSignal;
    readonly completeReachabilityGraphDiagram = this._reachabilityGraphService.completeReachabilityGraph;
    readonly showCompleteGraph = this._reachabilityGraphService.showingCompleteGraph;
    readonly displayDiagram = computed(() =>
        this.showCompleteGraph() ? this.completeReachabilityGraphDiagram() : this.userReachabilityGraphDiagram(),
    );
    readonly isEmpty = computed(() => this.userReachabilityGraphDiagram().nodes.length === 0);
    readonly viewMode = signal<ViewMode>(VIEW_MODES.DESCRIPTIVE);
    readonly _modeService = inject(ModeService);
    readonly _drawPanningService = inject(PanningService);

    constructor() {
        super();
        effect(() => {
            const isExamSignal = this._modeService.getIsExamModeSignal(Tab.REACHABILITY_GRAPH);
            if (isExamSignal && isExamSignal()) {
                this.viewMode.set(VIEW_MODES.SIMPLE);
            }
        });
    }

    private draggedNode: DisplayableNode | null = null;
    private dragOffset = { x: 0, y: 0 };
    private isDraggingNode = false;

    calculateWidth(node: StateNode) {
        if (this.viewMode() === VIEW_MODES.SIMPLE) {
            return 40;
        }
        return node.displayLabel.length * 8;
    }

    onNodeMouseDown(event: MouseEvent, node: DisplayableNode) {
        // Only start dragging for left mouse button
        if (event.button !== 0) {
            return;
        }

        // Stop the event from reaching other handlers
        event.stopImmediatePropagation();
        event.preventDefault();

        this.isDraggingNode = true;
        this.draggedNode = node;

        const svgPoint = this.getSvgCoordinates(event);
        if (svgPoint) {
            this.dragOffset.x = svgPoint.x - node.x;
            this.dragOffset.y = svgPoint.y - node.y;
        }
    }

    override startPan(event: MouseEvent): void {
        if (this.isDraggingNode) return;
        super.startPan(event);
    }

    override pan(event: MouseEvent): void {
        if (this.isDraggingNode) {
            // Handle node dragging
            if (!this.draggedNode) return;

            const svgPoint = this.getSvgCoordinates(event);
            if (svgPoint) {
                const newX = svgPoint.x - this.dragOffset.x;
                const newY = svgPoint.y - this.dragOffset.y;

                // Update node position using signals
                this.draggedNode.x = newX;
                this.draggedNode.y = newY;
            }
            return;
        }
        super.pan(event);
    }

    override endPan(): void {
        if (this.isDraggingNode) {
            // End node dragging
            this.draggedNode = null;
            this.isDraggingNode = false;
            return;
        }
        super.endPan();
    }

    /**
     * Converts mouse event client coordinates to SVG coordinates,
     * taking into account the viewBox transformation.
     * @param event The mouse event
     */
    private getSvgCoordinates(event: MouseEvent): { x: number; y: number } | null {
        const svg = this.drawingArea?.nativeElement;
        if (!svg) return null;

        const clientRect = svg.getBoundingClientRect();
        const viewBox = this.viewBoxObj();

        // Calculate position relative to SVG element (0-1 range)
        const relX = (event.clientX - clientRect.left) / clientRect.width;
        const relY = (event.clientY - clientRect.top) / clientRect.height;

        // Map to viewBox coordinates
        const x = viewBox.minX + relX * viewBox.width;
        const y = viewBox.minY + relY * viewBox.height;

        return { x, y };
    }

    /**
     * Toolbar actions for the reachability graph drawing display.
     * Add or modify actions as needed.
     * @protected
     */
    protected readonly toolbarActions = computed<DrawToolbarAction[]>(() => [
        {
            icon: 'delete',
            tooltip: 'PROCESS_NET.BUTTON_CLEAR_DRAWING',
            color: 'warn',
            isActive: !this.isEmpty(),
            action: () => this.clearDrawing(),
        },
        {
            icon: 'checklist',
            tooltip: 'REACHABILITY_GRAPH.BUTTON_VALIDATE_NET',
            isActive: !this.isEmpty() && !this.showCompleteGraph(),
            color: 'primary',
            action: () => this.onValidate(),
        },
        {
            icon: 'swap_horiz',
            tooltip: 'REACHABILITY_GRAPH.TOGGLE_VIEW',
            isActive: !this.isEmpty(),
            color: 'accent',
            action: () => this.toggleViewMode(),
        },
        {
            icon: this.generateIcon(),
            tooltip: this.generateTooltip(),
            isActive: this._sourcePetriNetService.getCurrentSourceNet() !== null,
            color: 'primary',
            action: () => this.onGenerate(),
        },
    ]);

    /**
     * Toolbar instructions for the reachability graph drawing display.
     * Describes how to interact with the reachability graph:
     * - Building the graph by firing transitions
     * - Moving nodes for organization
     * - Resetting states by double-clicking
     * TODO: add more instructions as needed.
     * @protected
     */
    protected readonly toolbarInstructions = computed<DrawToolbarInstruction[]>(() => [
        { label: 'REACHABILITY_GRAPH.ACTION_BUILD', text: 'REACHABILITY_GRAPH.INSTRUCTION_BUILD' },
        { label: 'REACHABILITY_GRAPH.ACTION_MOVE', text: 'REACHABILITY_GRAPH.INSTRUCTION_MOVE' },
        { label: 'REACHABILITY_GRAPH.ACTION_RESET', text: 'REACHABILITY_GRAPH.INSTRUCTION_RESET' },
        { label: 'REACHABILITY_GRAPH.ACTION_VALIDATE', text: 'REACHABILITY_GRAPH.INSTRUCTION_VALIDATE' },
        { label: 'REACHABILITY_GRAPH.ACTION_TOGGLEVIEW', text: 'REACHABILITY_GRAPH.INSTRUCTION_TOGGLEVIEW' },
        {
            label: 'REACHABILITY_GRAPH.ACTION_SHOWCOMPLETEGRAPH',
            text: 'REACHABILITY_GRAPH.INSTRUCTION_SHOWCOMPLETEGRAPH',
        },
        {
            label: 'REACHABILITY_GRAPH.ACTION_HIDECOMPLETEGRAPH',
            text: 'REACHABILITY_GRAPH.INSTRUCTION_HIDECOMPLETEGRAPH',
        },
    ]);

    private clearDrawing() {
        this._reachabilityGraphService.clear();
    }

    private onGenerate() {
        this._reachabilityGraphService.setShowingCompleteGraph(!this.showCompleteGraph());
        if (this.showCompleteGraph()) {
            this._reachabilityGraphService.generateReachabilityGraph();
            this._drawPanningService.fitViewToGraph(this.completeReachabilityGraphDiagram());
        } else {
            if (this.userReachabilityGraphDiagram().nodes.length > 1) {
                this._drawPanningService.fitViewToGraph(this.userReachabilityGraphDiagram());
            }
        }
    }

    readonly generateTooltip = computed(() =>
        this.showCompleteGraph() ? 'REACHABILITY_GRAPH.HIDE_COMPLETE_GRAPH' : 'REACHABILITY_GRAPH.SHOW_COMPLETE_GRAPH',
    );

    readonly generateIcon = computed(() => (this.showCompleteGraph() ? 'visibility_off' : 'account_tree'));

    private onValidate() {
        this._reachabilityGraphService.checkReachabilityGraphCompleteness();
    }

    private toggleViewMode() {
        this.viewMode.update((mode) => (mode === VIEW_MODES.SIMPLE ? VIEW_MODES.DESCRIPTIVE : VIEW_MODES.SIMPLE));
    }

    protected computePosition(node: StateNode) {
        return node.x - this.calculateWidth(node) / 2;
    }
}
