import {
    AfterViewInit,
    ChangeDetectorRef,
    Component,
    computed,
    effect,
    ElementRef,
    inject,
    OnDestroy,
    OnInit,
    signal,
    untracked,
    ViewChild,
} from '@angular/core';
import { SvgNodeComponent } from '../../../display/svg-node/svg-node.component';
import { DiagramNode } from '../../../../classes/diagram/diagram-node';
import { Diagram } from '../../../../classes/diagram/diagram';
import { DiagramPlace } from '../../../../classes/diagram/diagram-place';
import { DiagramTransition } from '../../../../classes/diagram/diagram-transition';
import { DisplayService } from '../../../../services/display.service';
import {
    type PetriNet,
    type ProcessConnection,
    type ProcessElement,
    validateProcessNet,
} from '../../../../services/process-net-validation.service';
import { ToasterNotificationService } from '../../../../services/toaster-notification.service';
import { PanningService } from '../../../../services/panning.service';
import { ToastList } from '../../../../classes/toast';
import { TranslateModule } from '@ngx-translate/core';
import { GRAPH_FILENAMES, GRAPH_IDS, PLACE_RADIUS, TRANSITION_SIZE } from '../../../display/display.constants';
import { ModeService } from '../../../../services/mode.service';
import { TabStateService } from '../../../../services/tab-state.service';
import { Tab } from '../../../../classes/tabs';
import { ProcessNetFiringService } from '../../../../services/process-net-firing.service';
import { Connection, DrawnElement, ProcessNetStateService } from '../../../../services/process-net-state.service';
import { Subscription } from 'rxjs';
import {
    DrawToolbarAction,
    DrawToolbarComponent,
    DrawToolbarInstruction,
} from '../../../draw-toolbar/draw-toolbar.component';
import { ImageExportService } from '../../../../services/image-export.service';
import { SourcePetriNetService } from '../../../../services/source-petri-net.service';
import { DrawingDisplayService } from '../../../../services/drawing-display.service';

interface GlobalDragData {
    elementType: 'place' | 'transition';
    elementId: string;
    elementLabel: string;
    elementTokens?: number;
    clientX: number;
    clientY: number;
}

declare global {
    interface Window {
        __dragData?: GlobalDragData;
    }
}

@Component({
    selector: 'app-process-net-draw-display',
    standalone: true,
    imports: [SvgNodeComponent, TranslateModule, DrawToolbarComponent],
    templateUrl: './process-net-draw-display.html',
    providers: [PanningService],
    styleUrls: ['./process-net-draw-display.css'],
})
export class ProcessNetDrawDisplayComponent implements OnInit, OnDestroy, AfterViewInit {
    @ViewChild('drawingArea') drawingArea!: ElementRef<SVGGraphicsElement>;
    private firingService = inject(ProcessNetFiringService);
    private stateService = inject(ProcessNetStateService);
    private drawingDisplayService = inject(DrawingDisplayService);

    // Bind to service state
    readonly drawnElements = this.stateService.drawnElements;
    readonly connections = this.stateService.connections;
    readonly isDisabled = computed(() => this.drawnElements().length === 0);

    readonly isDragOver = signal<boolean>(false);
    readonly isFileDrag = signal<boolean>(false);
    // Derived lines with coordinates for rendering
    readonly connectionLines = computed(() => {
        return this.connections()
            .map((c) => {
                const a = this.getElementById(c.aId);
                const b = this.getElementById(c.bId);
                if (!a || !b) return null;

                // Compute trimmed endpoints so the line starts/ends at shape boundaries
                const { x1, y1, x2, y2 } = this.drawingDisplayService.computeTrimmedLine(
                    { x: a.node.x, y: a.node.y, isPlace: a.node instanceof DiagramPlace },
                    { x: b.node.x, y: b.node.y, isPlace: b.node instanceof DiagramPlace },
                );
                return { id: c.id, x1, y1, x2, y2, weight: c.weight };
            })
            .filter(
                (v): v is { id: string; x1: number; y1: number; x2: number; y2: number; weight: number } => v !== null,
            );
    });
    // Currently selected element for making a connection (highlighted)
    readonly selectedElementId = signal<string | null>(null);

    // Toolbar configuration
    protected readonly toolbarActions = computed<DrawToolbarAction[]>(() => [
        {
            icon: 'delete',
            tooltip: 'PROCESS_NET.BUTTON_CLEAR_DRAWING',
            color: 'warn',
            isActive: !this.isDisabled(),
            action: () => this.clearDrawing(),
        },
        {
            icon: 'checklist',
            tooltip: 'PROCESS_NET.BUTTON_VALIDATE_NET',
            color: 'primary',
            isActive: !this.isDisabled(),
            action: () => this.onValidate(),
        },
    ]);

    protected readonly toolbarInstructions = computed<DrawToolbarInstruction[]>(() => {
        return [
            { label: 'PROCESS_NET.INSTRUCTION_AUTO_FIRING', text: 'PROCESS_NET.INSTRUCTION_AUTO_FIRING_TEXT' },
            { label: 'PROCESS_NET.ACTION_DRAG_DROP', text: 'PROCESS_NET.INSTRUCTION_DRAG_DROP' },
            { label: 'PROCESS_NET.INSTRUCTION_MOVE', text: 'PROCESS_NET.INSTRUCTION_LEFT_CLICK_MOVE' },
            { label: 'PROCESS_NET.INSTRUCTION_CONNECT', text: 'PROCESS_NET.INSTRUCTION_RIGHT_CLICK_CONNECT' },
            { label: 'PROCESS_NET.INSTRUCTION_DELETE', text: 'PROCESS_NET.INSTRUCTION_MIDDLE_CLICK_DELETE' },
            { label: 'PROCESS_NET.INSTRUCTION_DELETE_CONN', text: 'PROCESS_NET.INSTRUCTION_MIDDLE_CLICK_DELETE_CONN' },
            { label: 'PROCESS_NET.INSTRUCTION_VALIDATE', text: 'PROCESS_NET.INSTRUCTION_VALIDATE_TOAST' },
        ];
    });

    private draggedElement: DrawnElement | null = null;
    private dragOffset = { x: 0, y: 0 };
    private isDraggingElement = false;
    private elementRef = inject(ElementRef);
    private cdr = inject(ChangeDetectorRef);
    private customDropListener: ((event: Event) => void) | null = null;
    private displayService = inject(DisplayService);
    private toaster = inject(ToasterNotificationService);
    private _imageExportService = inject(ImageExportService);
    private panningService = inject(PanningService);
    private modeService = inject(ModeService);
    private sourcePetriNetService = inject(SourcePetriNetService);
    private tabStateService = inject(TabStateService);
    private downloadSub?: Subscription;

    readonly viewBox = this.panningService.viewBoxAsString;
    readonly viewBoxObj = this.panningService.viewBox;

    private fitViewSubscription?: Subscription;

    private startPositionEffect = effect(() => {
        if (this.tabStateService.currentTab() !== Tab.PROCESS_NET) {
            return;
        }

        const isExamMode = this.modeService.isExamMode(Tab.PROCESS_NET);
        const elements = untracked(this.drawnElements);

        if (elements.length === 0 && !isExamMode) {
            this.onCreateStartPosition();
        }
    });

    // Dimensions consistent with SvgNodeComponent
    private readonly PLACE_RADIUS = PLACE_RADIUS;
    private readonly TRANSITION_HALF_W = TRANSITION_SIZE / 2;
    private readonly TRANSITION_HALF_H = TRANSITION_SIZE / 2;

    ngOnInit() {
        this.downloadSub = this.displayService.downloadRequest$.subscribe(({ format, target }) => {
            if (target && target !== GRAPH_IDS.PROCESS_NET) {
                return;
            }
            if (this.elementRef.nativeElement.getBoundingClientRect().height === 0) {
                return;
            }
            this._imageExportService.exportImage(
                this.drawingArea.nativeElement,
                format,
                GRAPH_FILENAMES[GRAPH_IDS.PROCESS_NET],
            );
        });

        this.fitViewSubscription = this.stateService.fitViewRequest$.subscribe(() => {
            this.panningService.fitViewToGraph({
                getNodes: () => this.drawnElements().map((e) => e.node),
                getEdges: () => [],
            });
        });
    }

    ngAfterViewInit() {
        const canvas = this.elementRef.nativeElement.querySelector('.drawing-canvas');
        if (canvas) {
            this.customDropListener = (event: Event) => {
                this.handleCustomDrop(event as CustomEvent);
            };
            canvas.addEventListener('customDrop', this.customDropListener);

            // Add mousedown listener with capture phase to intercept before child elements
            canvas.addEventListener('mousedown', this.handleCanvasMouseDown, true);
        }
    }

    ngOnDestroy() {
        // Clean up event listener
        const canvas = this.elementRef.nativeElement.querySelector('.drawing-canvas');
        if (canvas && this.customDropListener) {
            canvas.removeEventListener('customDrop', this.customDropListener);
            canvas.removeEventListener('mousedown', this.handleCanvasMouseDown, true);
        }
        this.downloadSub?.unsubscribe();
        this.fitViewSubscription?.unsubscribe();
    }

    private handleCanvasMouseDown = (event: MouseEvent) => {
        this.drawingDisplayService.handleCanvasMouseDown(event, this.drawnElements(), (evt, el) =>
            this.onElementMouseDown(evt, el),
        );
    };

    private handleCustomDrop(event: CustomEvent) {
        const detail = event.detail;
        if (!detail) {
            return;
        }

        const svgPoint = this.drawingDisplayService.getSvgCoordinatesFromClient(
            detail.clientX,
            detail.clientY,
            this.drawingArea.nativeElement as SVGSVGElement,
        );
        if (!svgPoint) {
            return;
        }

        let newNode: DiagramNode;
        // Always create a unique ID for the drawing area, based on the source element
        // Use service to generate ID
        const uniqueId = this.stateService.generateElementId(`drawn-${detail.elementId}`);
        const elementLabel = detail.elementLabel || detail.elementId;
        const elementTokens = detail.elementTokens ?? 0;

        if (detail.elementType === 'place') {
            newNode = this.stateService.buildPlace(uniqueId, detail.elementId, elementTokens, {
                isStartPlace: this.shouldMarkAsStart(detail.elementId),
            });
        } else if (detail.elementType === 'transition') {
            newNode = this.stateService.buildTransition(uniqueId, elementLabel);
        } else {
            return;
        }

        newNode.x = svgPoint.x;
        newNode.y = svgPoint.y;

        const newElement: DrawnElement = {
            node: newNode,
            id: uniqueId,
        };

        this.stateService.addDrawnElement(newElement);
    }

    onDragOver(event: DragEvent) {
        event.preventDefault();
        const isFile = event.dataTransfer?.types.includes('Files') ?? false;
        this.isFileDrag.set(isFile);
        if (event.dataTransfer) {
            event.dataTransfer.dropEffect = isFile ? 'none' : 'copy';
        }
        this.isDragOver.set(true);
    }

    onDragLeave(_event: DragEvent) {
        this.isDragOver.set(false);
        this.isFileDrag.set(false);
    }

    onDrop(event: DragEvent) {
        event.preventDefault();
        this.isDragOver.set(false);
        this.isFileDrag.set(false);

        if (event.dataTransfer?.files && event.dataTransfer.files.length > 0) {
            this.toaster.showWarning('TOASTER.HEADER.UPLOAD_RESTRICTED', 'TOASTER.BODY.UPLOAD_ONLY_IN_DRAW_TAB');
            return;
        }

        // Check for drag data from the global window object (custom drag)
        const dragData = window.__dragData;
        if (dragData) {
            const svgPoint = this.drawingDisplayService.getSvgCoordinates(
                event,
                this.drawingArea.nativeElement as SVGSVGElement,
            );
            if (!svgPoint) {
                return;
            }

            let newNode: DiagramNode;
            // Always create a unique ID for the drawing area
            const uniqueId = this.stateService.generateElementId(`drawn-${dragData.elementId || 'element'}`);
            const elementLabel = dragData.elementLabel || dragData.elementId;
            const elementTokens = dragData.elementTokens ?? 0;

            if (dragData.elementType === 'place') {
                newNode = this.stateService.buildPlace(uniqueId, dragData.elementId, elementTokens, {
                    isStartPlace: this.shouldMarkAsStart(dragData.elementId),
                });
            } else if (dragData.elementType === 'transition') {
                newNode = this.stateService.buildTransition(uniqueId, elementLabel);
            } else {
                return;
            }

            newNode.x = svgPoint.x;
            newNode.y = svgPoint.y;

            const newElement: DrawnElement = {
                node: newNode,
                id: uniqueId,
            };

            this.stateService.addDrawnElement(newElement);

            // Clear the global drag data
            delete window.__dragData;
            return;
        }

        // Fallback to standard drag and drop (for files, etc.)
        const elementType = event.dataTransfer?.getData('element-type');
        if (!elementType) {
            return;
        }

        const svgPoint = this.drawingDisplayService.getSvgCoordinates(
            event,
            this.drawingArea.nativeElement as SVGSVGElement,
        );
        if (!svgPoint) {
            return;
        }

        let newNode: DiagramNode;
        const uniqueId = this.stateService.generateElementId('drawn-element');

        if (elementType === 'place') {
            newNode = this.stateService.buildPlace(uniqueId, undefined, 0);
        } else if (elementType === 'transition') {
            newNode = this.stateService.buildTransition(uniqueId, uniqueId);
        } else {
            return;
        }

        newNode.x = svgPoint.x;
        newNode.y = svgPoint.y;

        const newElement: DrawnElement = {
            node: newNode,
            id: uniqueId,
        };

        this.stateService.addDrawnElement(newElement);
    }

    onElementMouseDown(event: MouseEvent, element: DrawnElement) {
        // Middle click (button 1) deletes the element and its connections
        if (event.button === 1) {
            event.stopImmediatePropagation();
            event.preventDefault();
            this.deleteElement(element);
            return;
        }

        // Only start dragging for left mouse button
        if (event.button !== 0) {
            return;
        }

        // Stop the event from reaching svg-node component's handlers
        event.stopImmediatePropagation();
        event.preventDefault();

        this.isDraggingElement = true;
        this.draggedElement = element;

        const svgPoint = this.drawingDisplayService.getSvgCoordinates(
            event,
            this.drawingArea.nativeElement as SVGSVGElement,
        );
        if (svgPoint) {
            this.dragOffset.x = svgPoint.x - element.node.x;
            this.dragOffset.y = svgPoint.y - element.node.y;
        }

        document.addEventListener('mousemove', this.onDocumentMouseMove, true);
        document.addEventListener('mouseup', this.onDocumentMouseUp, true);
    }

    onElementRightClick(event: MouseEvent, element: DrawnElement) {
        // Right-click selection and connection logic
        event.preventDefault();
        event.stopImmediatePropagation();

        const currentSelectedId = this.selectedElementId();
        if (!currentSelectedId) {
            // Nothing selected yet -> select this one
            this.selectedElementId.set(element.id);
            return;
        }

        if (currentSelectedId === element.id) {
            // Toggle off selection if clicking the same element
            this.selectedElementId.set(null);
            return;
        }

        const first = this.drawnElements().find((e) => e.id === currentSelectedId);
        const second = element;
        if (!first) {
            // Safety: reset selection
            this.selectedElementId.set(null);
            return;
        }

        // Only connect if exactly one is place and one is transition
        if (
            this.drawingDisplayService.isValidConnectionPair(
                first.node instanceof DiagramPlace,
                second.node instanceof DiagramPlace,
            )
        ) {
            // Remove any existing connection between these two nodes (either direction)
            this.stateService.updateConnections((cs) =>
                cs.filter(
                    (c) =>
                        !((c.aId === first.id && c.bId === second.id) || (c.aId === second.id && c.bId === first.id)),
                ),
            );
            // Add new directed connection first -> second
            const newConn: Connection = {
                id: this.stateService.generateConnectionId('conn'),
                aId: first.id,
                bId: second.id,
                weight: 1,
            };
            this.stateService.addConnection(newConn);
            // Clear selection after connecting
            this.selectedElementId.set(null);
        } else {
            // If types don't match, replace selection with the newly clicked element
            this.selectedElementId.set(element.id);
        }
    }

    // Increment connection weight (used by left click)
    onConnectionMouseDown(event: MouseEvent, connectionId: string) {
        // Middle click deletes connection
        if (event.button === 1) {
            event.stopImmediatePropagation();
            event.preventDefault();
            this.deleteConnection(connectionId);
            return;
        }
    }

    onCanvasPanStart(event: MouseEvent) {
        this.drawingDisplayService.handleCanvasPanStart(
            event,
            this.isDraggingElement,
            this.drawingArea,
            this.panningService,
        );
    }

    onCanvasPan(event: MouseEvent) {
        this.drawingDisplayService.handleCanvasPan(
            event,
            this.isDraggingElement,
            this.drawingArea,
            this.panningService,
        );
    }

    onCanvasPanEnd() {
        this.drawingDisplayService.handleCanvasPanEnd(this.drawingArea, this.panningService);
    }

    onCanvasWheel(event: WheelEvent) {
        this.drawingDisplayService.handleCanvasWheel(event, this.drawingArea, this.panningService);
    }

    private onDocumentMouseMove = (event: MouseEvent) => {
        if (!this.draggedElement || !this.isDraggingElement) {
            return;
        }

        event.preventDefault();
        event.stopImmediatePropagation();

        const svgPoint = this.drawingDisplayService.getSvgCoordinates(
            event,
            this.drawingArea.nativeElement as SVGSVGElement,
        );
        if (svgPoint) {
            const newX = svgPoint.x - this.dragOffset.x;
            const newY = svgPoint.y - this.dragOffset.y;

            let updatedElement: DrawnElement | null = null;
            this.stateService.updateDrawnElements((elements) =>
                elements.map((el) => {
                    if (el.id !== this.draggedElement?.id) return el;

                    // Recreate node instance to trigger SvgNodeComponent re-render
                    let newNode: DiagramNode;
                    if (el.node instanceof DiagramPlace) {
                        const tokens = (el.node as DiagramPlace).tokenCount() ?? 0;
                        const originalLabel = el.node.label ?? el.node.displayLabel;
                        newNode = this.stateService.buildPlace(el.node.id, originalLabel, tokens, {
                            innerLabel: el.node.innerLabel,
                            hideTokens: el.node.hideTokens,
                            isStartPlace: el.node.isStartPlace,
                        });
                    } else if (el.node instanceof DiagramTransition) {
                        newNode = this.stateService.buildTransition(
                            el.node.id,
                            el.node.displayLabel,
                            el.node.innerLabel,
                        );
                    } else {
                        // Fallback: keep same reference (should not happen)
                        newNode = el.node;
                    }
                    newNode.x = newX;
                    newNode.y = newY;

                    const newEl: DrawnElement = { ...el, node: newNode };
                    updatedElement = newEl;
                    return newEl;
                }),
            );

            if (updatedElement) {
                this.draggedElement = updatedElement;
            }

            // Force Angular to detect the changes just in case
            this.cdr.detectChanges();
        }
    };

    private onDocumentMouseUp = (event: MouseEvent) => {
        if (this.isDraggingElement) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }

        this.draggedElement = null;
        this.isDraggingElement = false;
        document.removeEventListener('mousemove', this.onDocumentMouseMove, true);
        document.removeEventListener('mouseup', this.onDocumentMouseUp, true);
    };

    clearDrawing() {
        this.selectedElementId.set(null);

        this.drawingDisplayService.resetDiagramMarking();

        this.firingService.clear();

        if (!this.modeService.isExamMode(Tab.PROCESS_NET)) {
            this.onCreateStartPosition();
        }
    }

    deleteElement(element: DrawnElement) {
        this.stateService.removeDrawnElement(element.id);

        // Clear selection if it was this element
        if (this.selectedElementId() === element.id) {
            this.selectedElementId.set(null);
        }
    }

    private deleteConnection(connectionId: string) {
        this.stateService.removeConnection(connectionId);
    }

    // Suppress browser context menu on the drawing canvas (right click still used for interactions)
    preventContext(event: MouseEvent) {
        event.preventDefault();
    }

    // Trigger validation of the drawn process net against the loaded Petri net
    onValidate() {
        const base = this.sourcePetriNetService.getCurrentSourceNet() as Diagram | undefined;
        if (!base) {
            this.toaster.showError('TOASTER.HEADER.VALIDATION', 'TOASTER.BODY.VALIDATION_ERROR', {
                duration: 0,
            });

            return;
        }
        const nodes = base.getNodes();
        const edges = base.getEdges();
        const startMarkingEntries = Object.entries(base.startMarking || {}).filter(([, tokens]) => (tokens ?? 0) > 0);
        const petri: PetriNet = {
            places: nodes.filter((n) => n.shape === 'circle').map((n) => n.id),
            transitions: nodes.filter((n) => n.shape === 'rect').map((n) => n.id),
            arcs: Object.fromEntries(
                edges.map((e) => [
                    `${e.source},${e.target}`,
                    ((e as unknown as { weight?: number }).weight ?? 1) as number,
                ]),
            ),
            labels: Object.fromEntries(nodes.filter((n) => n.shape === 'rect').map((n) => [n.id, n.displayLabel])),
            marking: Object.fromEntries(startMarkingEntries),
        };
        const elements: ProcessElement[] = this.drawnElements().map((el) => {
            const isPlace = el.node instanceof DiagramPlace;
            const isTrans = el.node instanceof DiagramTransition;
            return {
                id: el.id,
                type: isPlace ? 'Place' : isTrans ? 'Transition' : 'Place',
                label: el.node.displayLabel,
                isStartPlace: isPlace ? (el.node as DiagramPlace).isStartPlace : undefined,
            };
        });
        const connections: ProcessConnection[] = this.connections().map((c) => ({
            from: c.aId,
            to: c.bId,
            weight: c.weight,
        }));
        const startPlaces = this.drawnElements()
            .filter(
                (el): el is DrawnElement & { node: DiagramPlace } =>
                    el.node instanceof DiagramPlace && el.node.isStartPlace,
            )
            .map((el) => el.node.label ?? el.node.displayLabel);
        const result = validateProcessNet({ ...petri, startPlaces }, elements, connections);
        // result contains success flag and could contain error and info messages. If success and no messages, show a generic success message.
        if (result.valid && result.infos.length == 0) {
            this.toaster.showSuccess('TOASTER.HEADER.VALIDATION', 'TOASTER.BODY.VALIDATION_VALID_MAXIMAL', {
                duration: 0,
            });
        } else if (result.valid && result.infos.length > 0) {
            const infos = result.infos.map((info): ToastList => ({ message: info.key, messageParams: info.params }));
            this.toaster.showInfo('TOASTER.HEADER.VALIDATION', 'TOASTER.BODY.VALIDATION_VALID_WITH_INFOS', {
                duration: 0,
                list: infos,
            });
        } else {
            const errors = result.errors.map(
                (error): ToastList => ({ message: error.key, messageParams: error.params }),
            );
            this.toaster.showError('TOASTER.HEADER.VALIDATION', 'TOASTER.BODY.VALIDATION_INVALID', {
                duration: 0,
                list: errors,
            });
        }
    }

    // Helpers for template
    getElementById(id: string): DrawnElement | undefined {
        return this.drawnElements().find((e) => e.id === id);
    }

    onCreateStartPosition() {
        const diagram = this.displayService.diagram;
        if (!diagram || !(diagram instanceof Diagram)) {
            return;
        }

        this.panningService.resetViewBox(this.drawingArea);

        const count = this.stateService.createStartPositions(diagram, this.panningService.INITIAL_VIEWBOX);

        if (count === 0) {
            const nodes = diagram.getNodes();
            const markedPlaces = nodes.filter((node) => node.shape.toLowerCase() === 'circle' && node.tokenCount() > 0);
            if (markedPlaces.length === 0) {
                this.toaster.showInfo('TOASTER.HEADER.START_POSITION', 'TOASTER.BODY.NO_MARKED_PLACES_FOUND', {
                    duration: 0,
                });
            }
            return;
        }

        this.toaster.showSuccess('TOASTER.HEADER.START_POSITION', 'TOASTER.BODY.START_PLACES_CREATED', {
            messageParams: { count },
        });
    }

    private getCurrentStartPlaceCount(placeId: string): number {
        return this.drawnElements().filter((el) => {
            if (!(el.node instanceof DiagramPlace) || !el.node.isStartPlace) {
                return false;
            }
            const label = el.node.label ?? el.node.displayLabel;
            return label === placeId;
        }).length;
    }

    private shouldMarkAsStart(placeId: string): boolean {
        if (!this.drawingDisplayService.isMarkedId(placeId)) {
            return false;
        }
        return this.getCurrentStartPlaceCount(placeId) < this.drawingDisplayService.getRequiredStartCount(placeId);
    }
}
