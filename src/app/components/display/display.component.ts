import { Component, computed, ElementRef, inject, OnDestroy, OnInit, signal, ViewChild } from '@angular/core';
import { DisplayService } from '../../services/display.service';
import { Subscription } from 'rxjs';
import { SvgNodeComponent } from './svg-node/svg-node.component';
import { SvgArcComponent } from './svg-arc/svg-arc.component';
import { TabStateService } from '../../services/tab-state.service';
import { Tab } from '../../classes/tabs';
import { PetriNetLoaderService } from '../../services/petri-net-loader.service';
import { SourcePetriNetService } from '../../services/source-petri-net.service';
import { DisplayableNode } from '../../classes/displayable-graph.interface';
import { DiagramTransition } from '../../classes/diagram/diagram-transition';
import { PlayService } from '../../services/play.service';
import { Diagram } from '../../classes/diagram/diagram';
import { PanningService } from '../../services/panning.service';
import { ImageExportService } from '../../services/image-export.service';
import { toSignal } from '@angular/core/rxjs-interop';
import { ReachabilityGraphService } from 'src/app/reachability-graph.service';
import { StateNode } from '../../classes/reachability-graph.model';
import { GRAPH_FILENAMES, GRAPH_IDS, GraphId } from './display.constants';
import { ProcessNetFiringService } from '../../services/process-net-firing.service';
import { ToasterNotificationService } from '../../services/toaster-notification.service';

@Component({
    selector: 'app-display',
    standalone: true,
    templateUrl: './display.component.html',
    imports: [SvgNodeComponent, SvgArcComponent],
    styleUrls: ['./display.component.css'],
})
export class DisplayComponent implements OnInit, OnDestroy {
    @ViewChild('drawingArea') drawingArea!: ElementRef<SVGGraphicsElement>;

    private _sub?: Subscription;
    private _displayService = inject(DisplayService);
    private _panningService = inject(PanningService);
    protected _tabStateService = inject(TabStateService);
    private _imageExportService = inject(ImageExportService);
    private _loaderService = inject(PetriNetLoaderService);
    protected _sourcePetriNetService = inject(SourcePetriNetService);
    private _playService = inject(PlayService);
    private _elementRef = inject(ElementRef);
    protected _reachabilityGraphService = inject(ReachabilityGraphService);
    protected _processNetFiringService = inject(ProcessNetFiringService);
    private _notificationService = inject(ToasterNotificationService);

    readonly isDragOver = signal<boolean>(false);

    readonly viewBox = this._panningService.viewBoxAsString;
    readonly viewBoxObj = this._panningService.viewBox;
    readonly diagram = toSignal(this._displayService.diagram$);
    readonly isDrawingEnabled = computed(() => this._tabStateService.currentTab() === Tab.DRAW);
    readonly isPlayingEnabled = computed(
        () =>
            this._tabStateService.currentTab() === Tab.PLAY ||
            this._tabStateService.currentTab() === Tab.REACHABILITY_GRAPH ||
            this._tabStateService.currentTab() === Tab.PROCESS_NET,
    );
    readonly isReachabilityGraphEnabled = computed(() => this._tabStateService.currentTab() === Tab.REACHABILITY_GRAPH);
    readonly isProcessNetEnabled = computed(() => this._tabStateService.currentTab() === Tab.PROCESS_NET);

    protected graphId: GraphId = GRAPH_IDS.PETRI_NET;

    ngOnInit(): void {
        this._sub = this._displayService.downloadRequest$.subscribe(({ format, target }) => {
            if (target && target !== this.graphId) {
                return;
            }

            if (this._elementRef.nativeElement.getBoundingClientRect().height === 0) {
                return;
            }
            const svgElement = this.drawingArea?.nativeElement;

            if (svgElement && this.diagram()) {
                const filename = GRAPH_FILENAMES[this.graphId] || 'graph';
                this._imageExportService.exportImage(svgElement, format, filename);
            }
        });
    }

    ngOnDestroy(): void {
        this._sub?.unsubscribe();
    }

    public processDropEvent(e: DragEvent) {
        e.preventDefault();
        this.isDragOver.set(false);
        if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
            this._notificationService.showWarning(
                'TOASTER.HEADER.UPLOAD_RESTRICTED',
                'TOASTER.BODY.UPLOAD_ONLY_IN_DRAW_TAB',
            );
        }
    }

    public processNodeClick(node: DisplayableNode) {
        const diagram = this.diagram();
        if (
            !this.isPlayingEnabled() ||
            !diagram ||
            !(diagram instanceof Diagram) ||
            !(node instanceof DiagramTransition)
        )
            return;
        const currentTab = this._tabStateService.currentTab();
        if (currentTab === Tab.PLAY) {
            this._playService.processTransitionClicked(diagram, node, true, true, false);
            return;
        }
        if (currentTab === Tab.PROCESS_NET) {
            this._processNetFiringService.processTransitionClicked(diagram, node);
            return;
        }
        if (currentTab === Tab.REACHABILITY_GRAPH) {
            if (node.isActivated()) {
                this._playService.fireTransition(node, diagram, true);
                this._reachabilityGraphService.convertFiringEntryLabelToReachabilityGraphID(diagram, node.label);
            } else {
                this._notificationService.showWarning(
                    'TOASTER.HEADER.TRANSITION_NOT_ACTIVATED',
                    'TOASTER.BODY.TRANSITION_NOT_ACTIVATED',
                    { messageParams: { label: node.label } },
                );
            }
        }
        this._sourcePetriNetService.updateEditedNet(diagram, { triggeredByFiring: true });
    }

    public stateNodeClicked(node: DisplayableNode) {
        if (this.isReachabilityGraphEnabled() && node instanceof StateNode) {
            console.log('StateNode clicked.' + node.id);
            this._reachabilityGraphService.switchPnStateToClickedState(node as StateNode);
        }
    }

    public onDragOver(event: DragEvent) {
        const isFileDrag = event.dataTransfer?.types.includes('Files');
        if (isFileDrag) {
            event.preventDefault();
            if (event.dataTransfer) {
                event.dataTransfer.dropEffect = 'copy';
            }
            this.isDragOver.set(true);
        }
    }

    public onDragLeave() {
        this.isDragOver.set(false);
    }

    public prevent(e: DragEvent) {
        e.preventDefault();
    }

    public startPan(event: MouseEvent): void {
        this._panningService.startPan(event, this.drawingArea);
    }

    public pan(event: MouseEvent): void {
        this._panningService.pan(event, this.drawingArea);
    }

    public endPan(): void {
        this._panningService.endPan(this.drawingArea);
    }

    public onWheel(event: WheelEvent): void {
        this._panningService.zoom(event, this.drawingArea);
    }
}
