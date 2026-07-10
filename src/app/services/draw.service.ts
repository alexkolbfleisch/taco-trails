import { computed, effect, ElementRef, inject, Injectable, OnDestroy, signal } from '@angular/core';
import { DiagramNode } from '../classes/diagram/diagram-node';
import { DiagramPlace, DiagramPlaceLabelPlacement } from '../classes/diagram/diagram-place';
import { DiagramTransition, DiagramTransitionOptions } from '../classes/diagram/diagram-transition';
import { DiagramArc } from '../classes/diagram/diagram-arc';
import { CanvasDiagram } from '../classes/diagram/canvas-diagram';
import { Connection, DrawnElement } from '../classes/diagram/drawn-element';
import { PanningService } from './panning.service';
import { ParserService } from './parser.service';
import { SourcePetriNetService } from './source-petri-net.service';
import { SpringEmbedderService } from './spring-embedder.service';
import { DisplayService } from './display.service';
import { ToasterNotificationService } from './toaster-notification.service';
import { Diagram } from '../classes/diagram/diagram';
import { firstValueFrom, Subscription } from 'rxjs';
import { SerializationService } from './serialization.service';
import { ModeService } from './mode.service';
import { TranslateService } from '@ngx-translate/core';
import { TOAST_POSITIONS, ToastList } from '../classes/toast';
import { applyParallelOffsetsToArcs, DEFAULT_PARALLEL_OFFSET } from './arc-parallel-offset.util';
import { MatDialog } from '@angular/material/dialog';
import { LabelEditDialogComponent } from '../components/shared/label-edit-dialog/label-edit-dialog.component';
import { PLACE_RADIUS as DISPLAY_PLACE_RADIUS, TRANSITION_SIZE } from '../components/display/display.constants';
import { TabStateService } from './tab-state.service';
import { PetriNetLoaderService } from './petri-net-loader.service';

interface GlobalDragData {
    elementType: 'place' | 'transition';
    elementId: string;
    elementLabel: string;
    elementTokens?: number;
    clientX: number;
    clientY: number;
}

export interface TuplePreview {
    places: string[];
    transitions: string[];
    arcs: { raw: string; source: string; target: string }[];
    marking: { raw: string; label: string }[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const window: any;

/**
 * DrawService
 *
 * Core service for managing the interactive Petri Net drawing interface. This service handles all
 * drawing operations, user interactions, and state management for the visual editor where users
 * create and manipulate Petri Net diagrams.
 *
 * Key responsibilities:
 * - Manages drawn elements (places and transitions) and their connections (arcs)
 * - Handles user interactions: drag-drop, click, right-click, double-click, scroll events
 * - Coordinates element creation, modification, and deletion operations
 * - Maintains visual state (selection, hover, drag-over feedback)
 * - Synchronizes canvas state with the source Petri Net across tabs
 * - Provides tuple notation parsing and validation
 * - Manages exam mode restrictions and validation
 * - Handles coordinate transformations between screen and SVG space
 * - Calculates arc offsets to prevent visual overlap
 *
 * Drawing Operations:
 * - Drag-drop elements from toolbar palette to canvas
 * - Left-click and drag to move elements
 * - Right-click to select elements and create connections (arcs)
 * - Middle-click to delete elements or connections
 * - Double-click to edit element labels
 * - Scroll wheel to adjust token counts (places) or arc weights
 * - Automatic layout using spring embedder algorithm
 *
 * Exam Mode Features:
 * - Displays tuple specification without the solution diagram
 * - Validates student's drawn net against the specification
 * - Prevents synchronization with other tabs to protect student work
 * - Provides detailed feedback on correctness (places, transitions, arcs, tokens)
 *
 * State Synchronization:
 * - Syncs with SourcePetriNetService for cross-tab communication
 * - Updates DisplayService for visualization in other tabs
 * - Maintains TabStateService for marking history
 * - Generates tuple notation for text representation
 *
 * @implements {OnDestroy} For proper cleanup of subscriptions and event listeners
 */
@Injectable({
    providedIn: 'root',
})
export class DrawService implements OnDestroy {
    drawnElements = signal<DrawnElement[]>([]);
    connections = signal<Connection[]>([]);
    isDragOver = signal(false);
    selectedElementId = signal<string | null>(null);
    hoveredElementId = signal<string | null>(null);
    hoveredConnectionId = signal<string | null>(null);
    showTuplePreviewOnly = signal(false);

    private _tabStateService = inject(TabStateService);

    readonly connectionLines = computed(() => {
        const nodeMap = new Map<string, DrawnElement>();
        this.drawnElements().forEach((el) => nodeMap.set(el.id, el));

        const groups = new Map<string, Connection[]>();
        this.connections().forEach((conn) => {
            if (!nodeMap.has(conn.aId) || !nodeMap.has(conn.bId)) return;
            const key = conn.aId < conn.bId ? `${conn.aId}~${conn.bId}` : `${conn.bId}~${conn.aId}`;
            const list = groups.get(key) || [];
            list.push(conn);
            groups.set(key, list);
        });

        const lines: { id: string; x1: number; y1: number; x2: number; y2: number; weight: number }[] = [];

        groups.forEach((group, key) => {
            const [aId, bId] = key.split('~');
            const nodeA = nodeMap.get(aId);
            const nodeB = nodeMap.get(bId);
            if (!nodeA || !nodeB) return;

            const baseDx = nodeB.node.x - nodeA.node.x;
            const baseDy = nodeB.node.y - nodeA.node.y;
            const baseLen = Math.hypot(baseDx, baseDy) || 1;
            const basePerpX = -baseDy / baseLen;
            const basePerpY = baseDx / baseLen;

            const forward = group
                .filter((c) => c.aId === aId && c.bId === bId)
                .sort((c1, c2) => c1.id.localeCompare(c2.id));
            const backward = group
                .filter((c) => c.aId === bId && c.bId === aId)
                .sort((c1, c2) => c1.id.localeCompare(c2.id));

            const addLines = (list: Connection[], baseShiftSign: -1 | 0 | 1, pairedExists: boolean) => {
                const centerIndex = (list.length - 1) / 2;
                list.forEach((conn, idx) => {
                    const a = nodeMap.get(conn.aId);
                    const b = nodeMap.get(conn.bId);
                    if (!a || !b) return;
                    let offset = (idx - centerIndex) * this.CONNECTION_PARALLEL_OFFSET;
                    if (baseShiftSign !== 0) {
                        offset += baseShiftSign * (this.CONNECTION_PARALLEL_OFFSET / 2);
                    }
                    if (Math.abs(offset) < 0.01 && pairedExists) {
                        offset = this.CONNECTION_PARALLEL_OFFSET / 2;
                    }
                    const { x1, y1, x2, y2 } = this.computeOffsetTrimmedLine(a, b, offset, basePerpX, basePerpY);
                    lines.push({ id: conn.id, x1, y1, x2, y2, weight: conn.weight });
                });
            };

            if (group.length === 1) {
                addLines(group, 0, false);
                return;
            }
            addLines(forward, 0, backward.length > 0);
            addLines(backward, -1, forward.length > 0);
        });

        return lines;
    });

    tupleString = signal('');
    readonly tuplePreview = computed(() => this.parseTuplePreview(this.tupleString()));

    /** Signal to control whether the drawing should be loaded and displayed */
    showDrawing = signal(true);

    setTupleString(value: string) {
        this.tupleString.set(value);
    }

    setShowDrawing(value: boolean) {
        this.showDrawing.set(value);
        // The toggle only controls whether incoming nets are drawn
        // It does not retroactively load or clear existing drawings
    }

    showTupleInline() {
        this.showTuplePreviewOnly.set(false);
    }

    showTuplePreviewIfAvailable() {
        if (this.isExamMode) return;
        const preview = this.tuplePreview();
        if (preview) {
            this.showTuplePreviewOnly.set(true);
        }
    }

    // ===== Subscriptions and State Flags =====
    /** Subscription to source Petri net changes from other tabs */
    private sourceNetSub?: Subscription;
    /** Subscription to source text changes for tuple synchronization */
    private sourceTextSub?: Subscription;
    /** Flag to prevent loading changes from source when we just updated it */
    private suppressNextSourceLoad = false;
    /** Flag indicating if a clear operation is in progress */
    private isClearing = false;
    /** Flag indicating if user has made changes in exam mode (prevents tuple updates from external sources) */
    private hasUserDrawnInExamMode = false;

    // ===== Drawing State =====
    /** Reference to the SVG drawing area element */
    private drawingArea?: ElementRef<SVGGraphicsElement>;
    /** Counter for generating unique element IDs */
    private elementIdCounter = 0;
    /** Counter for generating unique connection IDs */
    private connectionIdCounter = 0;
    /** Counter for generating default place labels (p1, p2, etc.) */
    private placeLabelCounter = 0;
    /** Counter for generating default transition labels (t1, t2, etc.) */
    private transitionLabelCounter = 0;
    /** Currently dragged element, or null if none */
    private draggedElement: DrawnElement | null = null;
    /** Offset between mouse position and element center during drag */
    private dragOffset = { x: 0, y: 0 };
    /** Reference to the SVG element for coordinate transformations */
    private svgElement: SVGSVGElement | null = null;
    /** Flag indicating if an element is currently being dragged */
    private isDraggingElement = false;

    // ===== Display Constants =====
    /** Radius of place circles in SVG units */
    private readonly PLACE_RADIUS = DISPLAY_PLACE_RADIUS;
    /** Half-width of transition rectangles in SVG units */
    private readonly TRANSITION_HALF_W = TRANSITION_SIZE / 2;
    /** Half-height of transition rectangles in SVG units */
    private readonly TRANSITION_HALF_H = TRANSITION_SIZE / 2;
    /** Distance between parallel arcs in SVG units */
    private readonly CONNECTION_PARALLEL_OFFSET = DEFAULT_PARALLEL_OFFSET;

    // ===== Injected Services =====
    /** Service for parsing tuple notation into Petri net diagrams */
    private _parserService = inject(ParserService);
    /** Service for serializing Petri nets to various formats */
    private readonly _serializationService = inject(SerializationService);
    /** Service maintaining the source Petri net state across tabs */
    private _sourceNetService = inject(SourcePetriNetService);
    /** Service for automatic layout using spring embedder algorithm */
    private _springEmbedderService = inject(SpringEmbedderService);
    /** Service for managing display state across different views */
    private _displayService = inject(DisplayService);
    /** Service for showing toast notifications to the user */
    private _toaster = inject(ToasterNotificationService);
    /** Service for managing application modes (normal/exam) */
    private _modeService = inject(ModeService);
    /** Service for internationalization/translation */
    private _translate = inject(TranslateService);
    /** Service for handling pan and zoom operations */
    private panning = inject(PanningService);
    /** Angular Material dialog service for modals */
    private _dialog = inject(MatDialog);
    /** Service for loading Petri nets from files */
    private _petriNetLoaderService = inject(PetriNetLoaderService);

    readonly isExamMode = false;

    /**
     * Gets the current viewBox as a string for the SVG element.
     * @returns {string} ViewBox string (e.g., "0 0 1000 1000")
     */
    get viewBox() {
        return this.panning.viewBoxAsString;
    }

    /**
     * Gets the current viewBox as an object with x, y, width, height properties.
     * @returns {object} ViewBox object
     */
    get viewBoxObj() {
        return this.panning.viewBox;
    }

    /** Effect for ensuring tuple preview is shown inline when entering exam mode */
    private readonly _examModePreviewEffect = effect(() => {
        if (this.isExamMode) {
            this.showTupleInline();
        }
    });

    /**
     * Initializes the DrawService by setting up subscriptions.
     *
     * Subscribes to:
     * - Source net changes from other tabs (to sync the drawing)
     * - Source text changes (for tuple synchronization in exam mode)
     *
     * In exam mode, drawing changes from other tabs are ignored to prevent
     * overwriting the student's work.
     */
    init(): void {
        if (this.sourceNetSub || this.sourceTextSub) return;

        // Subscribe to sourceText$ to detect new net uploads (loadNewNet calls)
        // This updates the tuple even in exam mode when a new net is uploaded
        this.sourceTextSub = this._sourceNetService.sourceText$.subscribe((text: string) => {
            if (text && this.isExamMode) {
                // A new net was loaded via loadNewNet, update the tuple string
                const diagram = this._sourceNetService.getCurrentSourceNet();
                if (diagram) {
                    const tuple = this._serializationService.serializeTuple(diagram);
                    if (tuple) {
                        this.tupleString.set(tuple);
                    }
                }
            }
        });

        this.sourceNetSub = this._sourceNetService.sourceNet$.subscribe((diagram: Diagram | null) => {
            if (this.suppressNextSourceLoad) {
                this.suppressNextSourceLoad = false;
                return;
            }
            if (diagram) {
                // Check if the incoming diagram matches what's currently on the canvas
                // This prevents clearing when the diagram is just the user's own work coming back (e.g., tab switches)
                const currentDiagram = this.buildDiagramFromCanvas();
                const isSameDiagram = this.diagramsMatch(currentDiagram, diagram);

                // If only positions changed, update positions in place for smooth animation
                if (isSameDiagram && this.showDrawing()) {
                    this.updateCanvasPositionsFromDiagram(diagram);
                } else if (!isSameDiagram || this.drawnElements().length === 0) {
                    // Always clear old drawing when a new net arrives
                    this.drawnElements.set([]);
                    this.connections.set([]);
                    this.selectedElementId.set(null);

                    // Only load the new drawing if showDrawing is true
                    if (this.showDrawing()) {
                        this.loadDiagramIntoCanvas(diagram);
                    }
                }

                // In exam mode, preserve the original tuple string (don't update from edited diagrams)
                // The sourceText$ subscription above handles new uploads
                if (!this.isExamMode) {
                    const tuple = this._serializationService.serializeTuple(diagram);
                    if (tuple) {
                        this.tupleString.set(tuple);
                    }
                }
                this.showTuplePreviewIfAvailable();
            } else {
                this.clearCanvas(true);
            }
        });
    }

    /**
     * Sets the reference to the SVG drawing area element.
     * This must be called after the view is initialized to enable drawing operations.
     *
     * @param {ElementRef<SVGGraphicsElement> | undefined | null} drawingArea - Reference to the SVG drawing area
     */
    setDrawingArea(drawingArea: ElementRef<SVGGraphicsElement> | undefined | null): void {
        if (!drawingArea) return;
        this.drawingArea = drawingArea;
        this.svgElement = (this.drawingArea?.nativeElement as SVGSVGElement) ?? null;
    }

    /**
     * Angular lifecycle hook: OnDestroy
     * Delegates to the destroy() method for cleanup.
     */
    ngOnDestroy(): void {
        this.destroy();
    }

    /**
     * Cleans up resources and removes event listeners.
     *
     * Performs cleanup:
     * - Removes document-level mouse event listeners
     * - Unsubscribes from observables
     * - Destroys Angular effects
     */
    destroy(): void {
        document.removeEventListener('mousemove', this.onDocumentMouseMove, true);
        document.removeEventListener('mouseup', this.onDocumentMouseUp, true);
        this.sourceNetSub?.unsubscribe();
        this.sourceTextSub?.unsubscribe();
        this._examModePreviewEffect?.destroy?.();
    }

    /**
     * Initiates a drag operation for a palette element (place or transition).
     *
     * Creates a custom SVG drag image and stores drag data in the global window object.
     * Automatically generates a label for the new element based on existing elements.
     *
     * @param {DragEvent} event - The drag start event
     * @param {'place' | 'transition'} type - The type of element being dragged
     */
    startPaletteDrag(event: DragEvent, type: 'place' | 'transition') {
        const label = type === 'place' ? this.getNextPlaceLabel() : this.getNextTransitionLabel();
        const id = `${type}-${Date.now()}`;
        if (event.dataTransfer) {
            event.dataTransfer.setData('element-type', type);
            event.dataTransfer.effectAllowed = 'copy';

            // Create a custom SVG drag image
            const svgNS = 'http://www.w3.org/2000/svg';
            const size = 56;
            const svg = document.createElementNS(svgNS, 'svg');
            svg.setAttribute('width', size.toString());
            svg.setAttribute('height', size.toString());
            svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
            svg.style.background = 'none';

            if (type === 'place') {
                const circle = document.createElementNS(svgNS, 'circle');
                circle.setAttribute('cx', '28');
                circle.setAttribute('cy', '28');
                circle.setAttribute('r', '22');
                circle.setAttribute('fill', '#fff');
                circle.setAttribute('stroke', '#222');
                circle.setAttribute('stroke-width', '2.5');
                svg.appendChild(circle);
            } else {
                const rect = document.createElementNS(svgNS, 'rect');
                rect.setAttribute('x', '6');
                rect.setAttribute('y', '6');
                rect.setAttribute('width', '44');
                rect.setAttribute('height', '44');
                rect.setAttribute('fill', '#fff');
                rect.setAttribute('stroke', '#222');
                rect.setAttribute('stroke-width', '2.5');
                rect.setAttribute('rx', '3');
                svg.appendChild(rect);
            }

            // Add to DOM off-screen to render
            svg.style.position = 'absolute';
            svg.style.left = '-9999px';
            document.body.appendChild(svg);

            // Use the SVG as drag image
            event.dataTransfer.setDragImage(svg, size / 2, size / 2);

            // Remove after a short delay to ensure drag image is set
            setTimeout(() => document.body.removeChild(svg), 0);
        }
        window.__dragData = {
            elementType: type,
            elementId: id,
            elementLabel: label,
            clientX: 0,
            clientY: 0,
        } as GlobalDragData;
    }

    /**
     * Ends a palette drag operation by cleaning up the global drag data.
     */
    endPaletteDrag() {
        delete window.__dragData;
    }

    /**
     * Handles the dragover event on the canvas.
     *
     * Prevents default behavior to allow dropping and updates visual feedback
     * to indicate that the canvas is a valid drop target.
     *
     * @param {DragEvent} event - The dragover event
     */
    onDragOver(event: DragEvent) {
        event.preventDefault();
        if (event.dataTransfer) {
            event.dataTransfer.dropEffect = 'copy';
        }
        this.isDragOver.set(true);
    }

    /**
     * Handles the dragleave event on the canvas.
     * Removes the visual feedback when the dragged element leaves the canvas area.
     */
    onDragLeave() {
        this.isDragOver.set(false);
    }

    /**
     * Handles the drop event on the canvas.
     *
     * Creates a new element (place or transition) at the drop location,
     * or loads a file if a file is dropped onto the canvas.
     *
     * @param {DragEvent} event - The drop event
     */
    onDrop(event: DragEvent) {
        event.preventDefault();
        this.isDragOver.set(false);

        // Check for file drops first
        if (event.dataTransfer?.files && event.dataTransfer.files.length > 0) {
            const file = event.dataTransfer.files[0];
            this._petriNetLoaderService.loadFile(file);
            return;
        }

        // Handle palette element drops
        const dragData = window.__dragData as GlobalDragData | undefined;
        if (dragData) {
            this.placeElementAtClient(dragData.elementType, dragData.elementLabel, event.clientX, event.clientY);
            delete window.__dragData;
            return;
        }

        const elementType = event.dataTransfer?.getData('element-type');
        if (elementType === 'place' || elementType === 'transition') {
            const label = elementType === 'place' ? this.getNextPlaceLabel() : this.getNextTransitionLabel();
            this.placeElement(event, elementType, label);
        }
    }

    /**
     * Starts a pan operation on the canvas.
     *
     * Prevents panning if an element is being dragged or if the mouse is over an element.
     * Delegates to the PanningService for the actual pan operation.
     *
     * @param {MouseEvent} event - The mouse down event
     */
    onCanvasPanStart(event: MouseEvent) {
        if (this.isDraggingElement || !this.drawingArea) return;
        const target = event.target as Element | null;
        const isOnElement = target?.closest('.element-wrapper') || target?.classList.contains('drag-overlay');
        if (isOnElement) return;
        this.panning.startPan(event, this.drawingArea);
    }

    /**
     * Handles continuous panning of the canvas during a pan operation.
     * Updates the viewBox to reflect the pan motion.
     *
     * @param {MouseEvent} event - The mouse move event
     */
    onCanvasPan(event: MouseEvent) {
        if (this.isDraggingElement || !this.drawingArea) return;
        this.panning.pan(event, this.drawingArea);
    }

    /**
     * Ends a pan operation on the canvas.
     * Called when the user releases the pan control (e.g., mouse button).
     */
    onCanvasPanEnd() {
        if (!this.drawingArea) return;
        this.panning.endPan(this.drawingArea);
    }

    /**
     * Handles mouse wheel events on the canvas for zooming.
     * Delegates to the PanningService to perform zoom operations.
     *
     * @param {WheelEvent} event - The wheel event
     */
    onCanvasWheel(event: WheelEvent) {
        if (!this.drawingArea) return;
        this.panning.zoom(event, this.drawingArea);
    }

    /**
     * Prevents the default context menu from appearing on the canvas.
     * Allows the application to use right-click for custom operations (e.g., creating connections).
     *
     * @param {MouseEvent} event - The context menu event
     */
    preventContext(event: MouseEvent) {
        event.preventDefault();
    }

    /**
     * Clears the drawing canvas.
     *
     * Performs a complete reset:
     * - Removes all drawn elements and connections
     * - Resets ID counters
     * - Clears selection
     * - Resets the viewBox to default
     * - Clears the source net (unless triggered by the source service)
     * - Optionally preserves the tuple string
     *
     * @param {boolean} triggeredByService - If true, skips clearing the source net to avoid circular updates
     * @param {boolean} preserveTuple - If true, keeps the tuple string unchanged
     */
    clearCanvas(triggeredByService = false, preserveTuple = false) {
        if (this.isClearing) return;
        this.isClearing = true;
        this.drawnElements.set([]);
        this.connections.set([]);
        this.selectedElementId.set(null);
        if (!preserveTuple) {
            this.tupleString.set('');
        }
        this.showTupleInline();
        this.elementIdCounter = 0;
        this.connectionIdCounter = 0;
        this.placeLabelCounter = 0;
        this.transitionLabelCounter = 0;
        this.hasUserDrawnInExamMode = false;
        if (this.drawingArea) {
            this.panning.resetViewBox(this.drawingArea);
        }
        // In exam mode, don't clear the source net when clearing canvas locally
        // This allows the sidebar delete button to remain functional
        if (!triggeredByService && !this.isExamMode) {
            this._sourceNetService.clear();
        }
        this._displayService.clear();
        this.isClearing = false;
    }

    /**
     * Deletes the currently selected element from the canvas without updating the tuple.
     *
     * This method removes the selected element and its connected arcs from the drawing,
     * but preserves the tuple string. This is useful in exam mode where the tuple
     * specification should remain unchanged while the student modifies their drawing.
     *
     * If an element is selected, this method:
     * - Removes the element from the canvas
     * - Removes all arcs connected to the element
     * - Clears the selection
     * - Does NOT update the tuple string
     * - Does NOT sync to source net (in exam mode)
     *
     * Does nothing if no element is currently selected.
     */
    deleteSelectedElement() {
        const selectedId = this.selectedElementId();
        if (!selectedId) return;

        const element = this.drawnElements().find((e) => e.id === selectedId);
        if (element) {
            // Delete the element without syncing/updating tuple
            this.drawnElements.update((els) => els.filter((e) => e.id !== element.id));
            this.connections.update((cs) => cs.filter((c) => c.aId !== element.id && c.bId !== element.id));
            if (this.selectedElementId() === element.id) {
                this.selectedElementId.set(null);
            }
        }
    }

    /**
     * Generates a Petri net from the tuple input string.
     *
     * Workflow:
     * 1. Parses the tuple string using ParserService
     * 2. If successful, loads the diagram into the canvas
     * 3. Applies spring embedder layout algorithm
     * 4. Applies parallel offsets to arcs
     * 5. Shows success toast and tuple preview
     * 6. If parsing fails, shows error toast
     */
    generateNetFromInput() {
        const input = this.tupleString().trim();
        if (!input) return;

        const diagram = this._parserService.parse(input);
        if (diagram) {
            this._sourceNetService.loadNewNet(diagram, input);
            this.loadDiagramIntoCanvas(diagram);
            const drawnGraph = new CanvasDiagram(this.drawnElements, this.connections);
            this._displayService.display(drawnGraph);
            this._springEmbedderService.calculateLayout(drawnGraph).catch((error) => console.error(error));
            this._toaster.showSuccess('TUPLE_INPUT.TOAST_SUCCESS_HEADER', 'TUPLE_INPUT.TOAST_SUCCESS_BODY');
            this.showTuplePreviewIfAvailable();

            // Build node map and apply parallel offsets to arcs
            const nodeMap = new Map<string, DiagramNode>();
            diagram.allNodes.forEach((node: DiagramNode) => nodeMap.set(node.id, node));
            this.applyParallelOffsetsToArcs(diagram.arcs, nodeMap);
        } else {
            this._toaster.showError('TUPLE_INPUT.TOAST_ERROR_HEADER', 'TUPLE_INPUT.TOAST_ERROR_BODY');
        }
    }

    /**
     * Handles the tuple button click event.
     *
     * Behavior depends on the current mode:
     * - In exam mode: Validates the drawn net against the tuple specification
     * - In normal mode: Generates a net from the tuple input
     */
    onTupleButtonClick(): void {
        if (this.isExamMode) {
            this.validateDrawnNetAgainstTuple();
            return;
        }
        this.generateNetFromInput();
    }

    /**
     * Handles mouse down events on drawn elements.
     *
     * Button behaviors:
     * - Left button (0): Initiates element dragging
     * - Middle button (1): Deletes the element
     * - Right button: Ignored (handled by onElementRightClick)
     *
     * Sets up document-level mouse listeners to track dragging across the entire page.
     *
     * @param {MouseEvent} event - The mouse down event
     * @param {DrawnElement} element - The element that was clicked
     */
    onElementMouseDown(event: MouseEvent, element: DrawnElement) {
        if (event.button === 1) {
            event.stopImmediatePropagation();
            event.preventDefault();
            this.deleteElement(element);
            return;
        }
        if (event.button !== 0) return;

        event.stopImmediatePropagation();
        event.preventDefault();
        this.isDraggingElement = true;
        this.draggedElement = element;

        const svgPoint = this.getSvgCoordinates(event);
        if (svgPoint) {
            this.dragOffset.x = svgPoint.x - element.node.x;
            this.dragOffset.y = svgPoint.y - element.node.y;
        }

        document.addEventListener('mousemove', this.onDocumentMouseMove, true);
        document.addEventListener('mouseup', this.onDocumentMouseUp, true);
    }

    /**
     * Handles right-click events on drawn elements to create connections (arcs).
     *
     * Connection creation workflow:
     * 1. First right-click selects the source element
     * 2. Second right-click on a different element:
     *    - If types are compatible (place→transition or transition→place), creates an arc
     *    - If types are incompatible, updates selection to the new element
     * 3. Right-click on the same element deselects it
     *
     * Arcs can only connect places to transitions or transitions to places.
     * Removes any existing arc in the same direction before creating a new one.
     *
     * @param {MouseEvent} event - The context menu event
     * @param {DrawnElement} element - The element that was right-clicked
     */
    onElementRightClick(event: MouseEvent, element: DrawnElement) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const currentSelected = this.selectedElementId();
        if (!currentSelected) {
            this.selectedElementId.set(element.id);
            return;
        }
        if (currentSelected === element.id) {
            this.selectedElementId.set(null);
            return;
        }
        const first = this.getElementById(currentSelected);
        const second = element;
        if (!first) {
            this.selectedElementId.set(null);
            return;
        }
        const firstIsPlace = first.node instanceof DiagramPlace;
        const firstIsTransition = first.node instanceof DiagramTransition;
        const secondIsPlace = second.node instanceof DiagramPlace;
        const secondIsTransition = second.node instanceof DiagramTransition;

        if ((firstIsPlace && secondIsTransition) || (firstIsTransition && secondIsPlace)) {
            this.connections.update((cs) => cs.filter((c) => !(c.aId === first.id && c.bId === second.id)));
            const newConn: Connection = {
                id: `conn-${++this.connectionIdCounter}`,
                aId: first.id,
                bId: second.id,
                weight: 1,
            };
            this.connections.update((cs) => [...cs, newConn]);
            this.selectedElementId.set(null);
            if (this.isExamMode) {
                this.hasUserDrawnInExamMode = true;
            }
            this.syncSourceNetFromCanvas();
        } else {
            this.selectedElementId.set(element.id);
        }
    }

    /**
     * Handles mouse down events on connections (arcs).
     *
     * Middle button click (button 1) deletes the connection.
     *
     * @param {MouseEvent} event - The mouse down event
     * @param {string} connectionId - The ID of the connection that was clicked
     */
    onConnectionMouseDown(event: MouseEvent, connectionId: string) {
        if (event.button === 1) {
            event.stopImmediatePropagation();
            event.preventDefault();
            this.deleteConnection(connectionId);
        }
    }

    /**
     * Handles mouse wheel events on connections to adjust arc weights.
     *
     * Scrolling up decreases weight, scrolling down increases weight.
     * Minimum weight is 1 (arc cannot have zero weight).
     *
     * @param {WheelEvent} event - The wheel event
     * @param {string} connectionId - The ID of the connection
     */
    onConnectionWheel(event: WheelEvent, connectionId: string) {
        event.preventDefault();
        event.stopPropagation();
        const delta = Math.sign(event.deltaY) || 0;
        if (delta === 0) return;
        this.connections.update((cs) =>
            cs.map((c) => {
                if (c.id !== connectionId) return c;
                const newWeight = Math.max(1, c.weight - delta);
                return { ...c, weight: newWeight };
            }),
        );
        if (this.isExamMode) {
            this.hasUserDrawnInExamMode = true;
        }
        this.syncSourceNetFromCanvas();
    }

    /**
     * Handles mouse wheel events on elements to adjust token counts (for places only).
     *
     * Scrolling up decreases tokens, scrolling down increases tokens.
     * Minimum token count is 0. Only works on DiagramPlace elements.
     *
     * @param {WheelEvent} event - The wheel event
     * @param {DrawnElement} element - The element being scrolled over
     */
    onElementWheel(event: WheelEvent, element: DrawnElement) {
        event.preventDefault();
        event.stopPropagation();
        if (!(element.node instanceof DiagramPlace)) return;
        const delta = Math.sign(event.deltaY) || 0;
        if (delta === 0) return;
        const current = element.node.tokenCount();
        element.node.tokens = Math.max(0, current - delta);
        if (this.isExamMode) {
            this.hasUserDrawnInExamMode = true;
        }
        this.syncSourceNetFromCanvas();
    }

    /**
     * Handles double-click events on elements to edit their labels.
     *
     * Opens a dialog for label editing. After successful edit:
     * - Validates that the new label is not a duplicate
     * - Updates the element with the new label
     * - Updates all connections referencing the old ID
     * - Updates selection if the element was selected
     * - Syncs changes to the source net
     *
     * The element's ID is changed to match the new label.
     *
     * @param {MouseEvent} event - The double-click event
     * @param {DrawnElement} element - The element that was double-clicked
     */
    onElementDoubleClick(event: MouseEvent, element: DrawnElement) {
        event.stopImmediatePropagation();
        event.preventDefault();
        if (element.node instanceof DiagramTransition) {
            const currentLabel = element.node.displayLabel ?? element.node.id;
            this.promptForLabel('DRAW.PROMPT_EDIT_TRANSITION_TITLE', currentLabel).then((newLabel) => {
                if (!newLabel || newLabel === currentLabel) return;
                if (this.isLabelTaken(newLabel, element.id)) {
                    this.showDuplicateLabelError(newLabel);
                    return;
                }

                const oldId = element.id;
                this.drawnElements.update((elements) =>
                    elements.map((el) => {
                        if (el.id !== oldId) return el;
                        const updated = this.buildTransition(newLabel, newLabel, { innerLabel: newLabel });
                        updated.x = el.node.x;
                        updated.y = el.node.y;
                        return { id: newLabel, node: updated };
                    }),
                );
                this.connections.update((cs) =>
                    cs.map((c) => ({
                        ...c,
                        aId: c.aId === oldId ? newLabel : c.aId,
                        bId: c.bId === oldId ? newLabel : c.bId,
                    })),
                );
                if (this.selectedElementId() === oldId) {
                    this.selectedElementId.set(newLabel);
                }
                if (this.isExamMode) {
                    this.hasUserDrawnInExamMode = true;
                }
                this.syncSourceNetFromCanvas();
            });
            return;
        }

        if (element.node instanceof DiagramPlace) {
            const currentLabel = element.node.label ?? element.node.displayLabel;
            this.promptForLabel('DRAW.PROMPT_EDIT_PLACE_TITLE', currentLabel).then((newLabel) => {
                if (!newLabel || newLabel === currentLabel) return;
                if (this.isLabelTaken(newLabel, element.id)) {
                    this.showDuplicateLabelError(newLabel);
                    return;
                }

                const oldId = element.id;
                this.drawnElements.update((elements) =>
                    elements.map((el) => {
                        if (el.id !== oldId) return el;
                        const updated = this.buildPlace(newLabel, newLabel, el.node.tokenCount(), {
                            labelPlacement: 'below',
                        });
                        updated.x = el.node.x;
                        updated.y = el.node.y;
                        return { id: newLabel, node: updated };
                    }),
                );
                this.connections.update((cs) =>
                    cs.map((c) => ({
                        ...c,
                        aId: c.aId === oldId ? newLabel : c.aId,
                        bId: c.bId === oldId ? newLabel : c.bId,
                    })),
                );
                if (this.selectedElementId() === oldId) {
                    this.selectedElementId.set(newLabel);
                }
                if (this.isExamMode) {
                    this.hasUserDrawnInExamMode = true;
                }
                this.syncSourceNetFromCanvas();
            });
        }
    }

    /**
     * Prompts the user to enter a new label for an element using a dialog.
     *
     * @param {string} titleKey - Translation key for the dialog title
     * @param {string | undefined | null} current - The current label value
     * @returns {Promise<string | undefined>} The new label, or undefined if canceled
     * @private
     */
    private async promptForLabel(titleKey: string, current: string | undefined | null): Promise<string | undefined> {
        const dialogRef = this._dialog.open(LabelEditDialogComponent, {
            width: '360px',
            data: { title: titleKey, label: current ?? '' },
        });

        const result = await firstValueFrom(dialogRef.afterClosed());
        return typeof result === 'string' ? result.trim() : undefined;
    }

    /**
     * Validates the student's drawn Petri net against the tuple specification in exam mode.
     *
     * Performs comprehensive validation by comparing:
     * - Places: Checks for missing and extra places
     * - Transitions: Checks for missing and extra transitions
     * - Arcs: Validates connections and their weights
     * - Tokens: Verifies initial marking (token counts on places)
     *
     * Shows detailed error messages for any mismatches, or a success message if everything is correct.
     * Uses a persistent toast notification (duration: 0) to ensure the validation result is visible.
     *
     * @private
     */
    private validateDrawnNetAgainstTuple() {
        const tupleText = this.tupleString().trim();
        if (!tupleText) {
            this._toaster.showError('TUPLE_INPUT.TOAST_INVALIDATION_HEADER', 'TUPLE_INPUT.TOAST_INVALIDATION_BODY', {
                duration: 0,
                toastPosition: TOAST_POSITIONS.TOP_RIGHT,
            });
            return;
        }

        const parsed = this._parserService.parse(tupleText);
        if (!parsed) {
            this._toaster.showError('TUPLE_INPUT.TOAST_INVALIDATION_HEADER', 'TUPLE_INPUT.TOAST_INVALIDATION_BODY', {
                duration: 0,
                toastPosition: TOAST_POSITIONS.TOP_RIGHT,
            });
            return;
        }

        const drawnDiagram = this.buildDiagramFromCanvas();

        const placeLabel = (p: DiagramPlace) => p.label ?? p.displayLabel ?? p.id;
        const transitionLabel = (t: DiagramTransition) => t.label ?? t.displayLabel ?? t.id;

        const parsedPlaceLabelById = new Map(parsed.places.map((p) => [p.id, placeLabel(p)]));
        const parsedTransitionLabelById = new Map(parsed.transitions.map((t) => [t.id, transitionLabel(t)]));
        const drawnPlaceLabelById = new Map(drawnDiagram.places.map((p) => [p.id, placeLabel(p)]));
        const drawnTransitionLabelById = new Map(drawnDiagram.transitions.map((t) => [t.id, transitionLabel(t)]));

        const idToLabel = (id: string, placeMap: Map<string, string>, transitionMap: Map<string, string>) =>
            placeMap.get(id) ?? transitionMap.get(id) ?? id;

        const expectedPlaces = new Set(
            parsed.places.map((p) => idToLabel(p.id, parsedPlaceLabelById, parsedTransitionLabelById)),
        );
        const drawnPlaces = new Set(
            drawnDiagram.places.map((p) => idToLabel(p.id, drawnPlaceLabelById, drawnTransitionLabelById)),
        );

        const expectedTransitions = new Set(
            parsed.transitions.map((t) => idToLabel(t.id, parsedPlaceLabelById, parsedTransitionLabelById)),
        );
        const drawnTransitions = new Set(
            drawnDiagram.transitions.map((t) => idToLabel(t.id, drawnPlaceLabelById, drawnTransitionLabelById)),
        );

        const expectedArcs = new Map<string, number>(
            parsed.arcs.map((a) => {
                const srcLabel = idToLabel(a.source, parsedPlaceLabelById, parsedTransitionLabelById);
                const tgtLabel = idToLabel(a.target, parsedPlaceLabelById, parsedTransitionLabelById);
                return [`${srcLabel}->${tgtLabel}`, a.weight ?? 1];
            }),
        );
        const drawnArcs = new Map<string, number>(
            drawnDiagram.arcs.map((a) => {
                const srcLabel = idToLabel(a.source, drawnPlaceLabelById, drawnTransitionLabelById);
                const tgtLabel = idToLabel(a.target, drawnPlaceLabelById, drawnTransitionLabelById);
                return [`${srcLabel}->${tgtLabel}`, a.weight ?? 1];
            }),
        );

        const expectedTokens = new Map<string, number>(
            parsed.places.map((p) => [
                idToLabel(p.id, parsedPlaceLabelById, parsedTransitionLabelById),
                p.tokenCount(),
            ]),
        );
        const drawnTokens = new Map<string, number>(
            drawnDiagram.places.map((p) => [
                idToLabel(p.id, drawnPlaceLabelById, drawnTransitionLabelById),
                p.tokenCount(),
            ]),
        );

        const errors: string[] = [];

        const missingPlaces = [...expectedPlaces].filter((p) => !drawnPlaces.has(p));
        const extraPlaces = [...drawnPlaces].filter((p) => !expectedPlaces.has(p));
        if (missingPlaces.length)
            errors.push(
                this._translate.instant('TUPLE_INPUT.VALIDATION.MISSING_PLACES', {
                    items: missingPlaces.join(', '),
                }),
            );
        if (extraPlaces.length)
            errors.push(
                this._translate.instant('TUPLE_INPUT.VALIDATION.EXTRA_PLACES', {
                    items: extraPlaces.join(', '),
                }),
            );

        const missingTransitions = [...expectedTransitions].filter((t) => !drawnTransitions.has(t));
        const extraTransitions = [...drawnTransitions].filter((t) => !expectedTransitions.has(t));
        if (missingTransitions.length)
            errors.push(
                this._translate.instant('TUPLE_INPUT.VALIDATION.MISSING_TRANSITIONS', {
                    items: missingTransitions.join(', '),
                }),
            );
        if (extraTransitions.length)
            errors.push(
                this._translate.instant('TUPLE_INPUT.VALIDATION.EXTRA_TRANSITIONS', {
                    items: extraTransitions.join(', '),
                }),
            );

        expectedArcs.forEach((weight, key) => {
            const drawnWeight = drawnArcs.get(key);
            if (drawnWeight === undefined) {
                errors.push(
                    this._translate.instant('TUPLE_INPUT.VALIDATION.MISSING_ARC', {
                        arc: key,
                    }),
                );
            } else if (drawnWeight !== weight) {
                errors.push(
                    this._translate.instant('TUPLE_INPUT.VALIDATION.ARC_WEIGHT_MISMATCH', {
                        arc: key,
                        expected: weight,
                        found: drawnWeight,
                    }),
                );
            }
        });
        drawnArcs.forEach((_, key) => {
            if (!expectedArcs.has(key)) {
                errors.push(
                    this._translate.instant('TUPLE_INPUT.VALIDATION.EXTRA_ARC', {
                        arc: key,
                    }),
                );
            }
        });

        expectedTokens.forEach((weight, placeId) => {
            const drawnToken = drawnTokens.get(placeId) ?? 0;
            if (drawnToken !== weight) {
                const diff = weight - drawnToken;
                errors.push(
                    diff > 0
                        ? this._translate.instant('TUPLE_INPUT.VALIDATION.TOKENS_MISSING', {
                              count: Math.abs(diff),
                              place: placeId,
                              expected: weight,
                              found: drawnToken,
                          })
                        : this._translate.instant('TUPLE_INPUT.VALIDATION.TOKENS_EXTRA', {
                              count: Math.abs(diff),
                              place: placeId,
                              expected: weight,
                              found: drawnToken,
                          }),
                );
            }
        });
        drawnTokens.forEach((weight, placeId) => {
            if (!expectedTokens.has(placeId) && weight !== 0) {
                errors.push(
                    this._translate.instant('TUPLE_INPUT.VALIDATION.TOKENS_UNEXPECTED', {
                        place: placeId,
                        found: weight,
                    }),
                );
            }
        });

        if (errors.length === 0) {
            this._toaster.showSuccess('TUPLE_INPUT.TOAST_VALIDATION_HEADER', 'TUPLE_INPUT.TOAST_VALIDATION_BODY', {
                duration: 0,
                toastPosition: TOAST_POSITIONS.TOP_RIGHT,
            });
            return;
        }

        const list: ToastList[] = errors.map((message) => ({ message }));
        this._toaster.showError('TUPLE_INPUT.TOAST_INVALIDATION_HEADER', 'TUPLE_INPUT.TOAST_INVALIDATION_BODY', {
            duration: 0,
            toastPosition: TOAST_POSITIONS.TOP_RIGHT,
            list,
        });
    }

    /**
     * Shows a toast notification indicating that a label is already in use.
     *
     * @param {string} label - The duplicate label that was attempted
     * @private
     */
    private showDuplicateLabelError(label: string) {
        this._toaster.showError('DRAW.TOAST_DUPLICATE_LABEL_HEADER', 'DRAW.TOAST_DUPLICATE_LABEL_BODY', {
            messageParams: { label },
        });
    }

    /**
     * Checks if a label is already in use by another element.
     *
     * @param {string} label - The label to check
     * @param {string} [ignoreId] - Optional ID to ignore (for checking during rename)
     * @returns {boolean} True if the label is taken
     * @private
     */
    private isLabelTaken(label: string, ignoreId?: string): boolean {
        if (label === ignoreId) return false;
        return this.drawnElements().some((el) => el.id === label);
    }

    /**
     * Document-level mouse move handler for element dragging.
     *
     * Updates the position of the currently dragged element based on mouse coordinates.
     * Preserves all element properties (tokens, labels, etc.) while updating position.
     *
     * Note: This is an arrow function to preserve 'this' context when used as event listener.
     *
     * @param {MouseEvent} event - The mouse move event
     * @private
     */
    private onDocumentMouseMove = (event: MouseEvent) => {
        if (!this.draggedElement || !this.isDraggingElement) return;

        event.preventDefault();
        event.stopImmediatePropagation();

        const svgPoint = this.getSvgCoordinates(event);
        if (!svgPoint) return;

        const newX = svgPoint.x - this.dragOffset.x;
        const newY = svgPoint.y - this.dragOffset.y;

        this.drawnElements.update((elements) =>
            elements.map((el) => {
                if (el.id !== this.draggedElement?.id) return el;
                el.node.x = newX;
                el.node.y = newY;
                return { ...el };
            }),
        );
    };

    /**
     * Document-level mouse up handler for ending element dragging.
     *
     * Completes the drag operation by:
     * - Resetting drag state variables
     * - Removing document-level event listeners
     * - Syncing the updated canvas state to the source net
     *
     * Note: This is an arrow function to preserve 'this' context when used as event listener.
     *
     * @param {MouseEvent} event - The mouse up event
     * @private
     */
    private onDocumentMouseUp = (event: MouseEvent) => {
        if (this.isDraggingElement) {
            event.preventDefault();
            event.stopImmediatePropagation();
            if (this.isExamMode) {
                this.hasUserDrawnInExamMode = true;
            }
        }
        this.draggedElement = null;
        this.isDraggingElement = false;
        document.removeEventListener('mousemove', this.onDocumentMouseMove, true);
        document.removeEventListener('mouseup', this.onDocumentMouseUp, true);
        this.syncSourceNetFromCanvas();
    };

    /**
     * Places an element on the canvas from a drag event.
     * Converts drag event coordinates to SVG coordinates and adds the element.
     *
     * @param {DragEvent} event - The drop event
     * @param {'place' | 'transition'} type - The type of element to place
     * @param {string} label - The label for the new element
     * @private
     */
    private placeElement(event: DragEvent, type: 'place' | 'transition', label: string) {
        const svgPoint = this.getSvgCoordinates(event);
        if (!svgPoint) return;
        this.addElement(type, label, svgPoint.x, svgPoint.y);
    }

    /**
     * Places an element on the canvas from client coordinates.
     * Converts client coordinates to SVG coordinates and adds the element.
     *
     * @param {'place' | 'transition'} type - The type of element to place
     * @param {string} label - The label for the new element
     * @param {number} clientX - The client X coordinate
     * @param {number} clientY - The client Y coordinate
     * @private
     */
    private placeElementAtClient(type: 'place' | 'transition', label: string, clientX: number, clientY: number) {
        const svgPoint = this.getSvgCoordinatesFromClient(clientX, clientY);
        if (!svgPoint) return;
        this.addElement(type, label, svgPoint.x, svgPoint.y);
    }

    /**
     * Adds a new element (place or transition) to the canvas.
     *
     * Validates that the label is unique before adding.
     * Creates the appropriate diagram node and adds it to the drawnElements array.
     * Syncs the change to the source net.
     *
     * @param {'place' | 'transition'} type - The type of element to add
     * @param {string} label - The label for the new element
     * @param {number} x - The X coordinate in SVG space
     * @param {number} y - The Y coordinate in SVG space
     * @private
     */
    private addElement(type: 'place' | 'transition', label: string, x: number, y: number) {
        const newId = label;
        if (this.isLabelTaken(newId)) {
            this.showDuplicateLabelError(newId);
            return;
        }
        let newNode: DiagramNode;
        if (type === 'place') {
            newNode = this.buildPlace(newId, label, 0, {
                labelPlacement: 'below',
                innerLabel: undefined,
                hideTokens: false,
            });
        } else {
            newNode = this.buildTransition(newId, label, { innerLabel: label });
        }
        newNode.x = x;
        newNode.y = y;
        this.drawnElements.update((elements) => [...elements, { id: newId, node: newNode }]);
        if (this.isExamMode) {
            this.hasUserDrawnInExamMode = true;
        }
        this.syncSourceNetFromCanvas();
    }

    /**
     * Loads a Diagram object into the canvas for visual editing.
     *
     * Converts the diagram's places, transitions, and arcs into drawable elements.
     * Resets all counters and creates the necessary DrawnElement and Connection objects.
     * Clears any current selection.
     *
     * @param {Diagram} diagram - The diagram to load
     * @private
     */
    private loadDiagramIntoCanvas(diagram: Diagram) {
        this.connectionIdCounter = 0;
        this.elementIdCounter = 0;
        this.placeLabelCounter = diagram.places.length;
        this.transitionLabelCounter = diagram.transitions.length;

        const elements: DrawnElement[] = [];
        diagram.places.forEach((place) => {
            elements.push({ id: place.id, node: place });
            this.elementIdCounter++;
        });
        diagram.transitions.forEach((transition) => {
            elements.push({ id: transition.id, node: transition });
            this.elementIdCounter++;
        });

        const conns: Connection[] = [];
        diagram.arcs.forEach((arc) => {
            conns.push({
                id: `conn-${++this.connectionIdCounter}`,
                aId: arc.source,
                bId: arc.target,
                weight: arc.weight,
            });
        });

        this.drawnElements.set(elements);
        this.connections.set(conns);
        this.selectedElementId.set(null);
    }

    /**
     * Deletes an element from the canvas.
     *
     * Also removes all connections (arcs) that involve the deleted element.
     * Clears the selection if the deleted element was selected.
     * Syncs the change to the source net.
     *
     * @param {DrawnElement} element - The element to delete
     * @private
     */
    private deleteElement(element: DrawnElement) {
        this.drawnElements.update((els) => els.filter((e) => e.id !== element.id));
        this.connections.update((cs) => cs.filter((c) => c.aId !== element.id && c.bId !== element.id));
        if (this.selectedElementId() === element.id) {
            this.selectedElementId.set(null);
        }
        if (this.isExamMode) {
            this.hasUserDrawnInExamMode = true;
        }
        this.syncSourceNetFromCanvas();
    }

    /**
     * Deletes a connection (arc) from the canvas.
     *
     * Syncs the change to the source net.
     *
     * @param {string} connectionId - The ID of the connection to delete
     * @private
     */
    private deleteConnection(connectionId: string) {
        this.connections.update((cs) => cs.filter((c) => c.id !== connectionId));
        if (this.isExamMode) {
            this.hasUserDrawnInExamMode = true;
        }
        this.syncSourceNetFromCanvas();
    }

    /**
     * Finds an element by its ID.
     *
     * @param {string} id - The ID of the element to find
     * @returns {DrawnElement | undefined} The element if found, undefined otherwise
     * @private
     */
    private getElementById(id: string): DrawnElement | undefined {
        return this.drawnElements().find((e) => e.id === id);
    }

    /**
     * Compares two diagrams to check if they represent the same Petri net structure.
     * Checks places, transitions, arcs, and markings for equality.
     *
     * @param {Diagram} diagram1 - First diagram to compare
     * @param {Diagram} diagram2 - Second diagram to compare
     * @returns {boolean} True if diagrams match, false otherwise
     * @private
     */
    private diagramsMatch(diagram1: Diagram, diagram2: Diagram): boolean {
        // Compare number of places and transitions
        if (diagram1.places.length !== diagram2.places.length) return false;
        if (diagram1.transitions.length !== diagram2.transitions.length) return false;
        if (diagram1.arcs.length !== diagram2.arcs.length) return false;

        // Check if all places match (by id and token count)
        const places1Map = new Map(diagram1.places.map((p) => [p.id, p]));
        for (const place2 of diagram2.places) {
            const place1 = places1Map.get(place2.id);
            if (!place1 || place1.tokenCount() !== place2.tokenCount()) return false;
        }

        // Check if all transitions match (by id)
        const transitions1Set = new Set(diagram1.transitions.map((t) => t.id));
        for (const transition2 of diagram2.transitions) {
            if (!transitions1Set.has(transition2.id)) return false;
        }

        // Check if all arcs match (by source, target, and weight)
        const arcs1Set = new Set(diagram1.arcs.map((a) => `${a.source}->${a.target}:${a.weight}`));
        for (const arc2 of diagram2.arcs) {
            const arcKey = `${arc2.source}->${arc2.target}:${arc2.weight}`;
            if (!arcs1Set.has(arcKey)) return false;
        }

        return true;
    }

    private updateCanvasPositionsFromDiagram(diagram: Diagram) {
        const placeMap = new Map(diagram.places.map((p) => [p.id, p]));
        const transitionMap = new Map(diagram.transitions.map((t) => [t.id, t]));

        this.drawnElements.update((elements) =>
            elements.map((el) => {
                if (el.node instanceof DiagramPlace) {
                    const updated = placeMap.get(el.id);
                    if (updated) {
                        el.node.x = updated.x;
                        el.node.y = updated.y;
                    }
                } else if (el.node instanceof DiagramTransition) {
                    const updated = transitionMap.get(el.id);
                    if (updated) {
                        el.node.x = updated.x;
                        el.node.y = updated.y;
                    }
                }
                return { ...el };
            }),
        );
    }

    /**
     * Synchronizes the current canvas state to the source Petri net.
     *
     * Builds a Diagram from the current canvas elements and connections,
     * then updates:
     * - The source net service (for cross-tab synchronization)
     * - The display service (for visualization)
     * - The tab state service (for marking history)
     * - The tuple string (for text representation, except in exam mode)
     *
     * In exam mode, the tuple string is preserved to show the original specification.
     *
     * @private
     */
    private syncSourceNetFromCanvas() {
        const diagram = this.buildDiagramFromCanvas();

        this.suppressNextSourceLoad = true;
        this._sourceNetService.updateEditedNet(diagram);
        this._tabStateService.setAllLastMarkings(diagram.marking);
        this._displayService.display(diagram);

        // In exam mode, preserve the original tuple string (the specification to match)
        if (!this.isExamMode) {
            const tuple = this._serializationService.serializeTuple(diagram);
            if (tuple) {
                this.tupleString.set(tuple);
            }
        }
    }

    /**
     * Builds a Diagram object from the current canvas state.
     *
     * Constructs a complete Petri net diagram by:
     * 1. Converting drawn elements into DiagramPlace and DiagramTransition objects
     * 2. Building maps for quick lookup during arc construction
     * 3. Creating DiagramArc objects from connections
     * 4. Linking arcs with their source/target places and transitions
     * 5. Assembling everything into a Diagram object
     *
     * Preserves all element properties including position, tokens, labels, etc.
     *
     * @returns {Diagram} A complete diagram representing the current canvas state
     * @private
     */
    private buildDiagramFromCanvas(): Diagram {
        const places: DiagramPlace[] = [];
        const transitions: DiagramTransition[] = [];

        const placeMap = new Map<string, DiagramPlace>();
        const transitionMap = new Map<
            string,
            {
                transition: DiagramTransition;
                inputPlaces: DiagramPlace[];
                outputPlaces: DiagramPlace[];
                inputArcs: DiagramArc[];
                outputArcs: DiagramArc[];
            }
        >();

        this.drawnElements().forEach((el) => {
            if (el.node instanceof DiagramPlace) {
                const place = new DiagramPlace(
                    el.node.id,
                    el.node.tokenCount(),
                    el.node.label ?? el.node.displayLabel,
                    {
                        labelPlacement: el.node.labelPlacement,
                        hideTokens: el.node.hideTokens,
                        innerLabel: el.node.innerLabel,
                        isStartPlace: el.node.isStartPlace,
                    },
                );
                place.x = el.node.x;
                place.y = el.node.y;
                places.push(place);
                placeMap.set(place.id, place);
            } else if (el.node instanceof DiagramTransition) {
                const label = el.node.displayLabel ?? el.node.id;
                const inputPlaces: DiagramPlace[] = [];
                const outputPlaces: DiagramPlace[] = [];
                const inputArcs: DiagramArc[] = [];
                const outputArcs: DiagramArc[] = [];
                const transition = new DiagramTransition(
                    el.node.id,
                    label,
                    inputPlaces,
                    outputPlaces,
                    inputArcs,
                    outputArcs,
                    {
                        innerLabel: el.node.innerLabel ?? label,
                    },
                );
                transition.x = el.node.x;
                transition.y = el.node.y;
                transitions.push(transition);
                transitionMap.set(transition.id, {
                    transition,
                    inputPlaces,
                    outputPlaces,
                    inputArcs,
                    outputArcs,
                });
            }
        });

        const arcs: DiagramArc[] = [];
        this.connections().forEach((conn, idx) => {
            const arc = new DiagramArc(conn.id || `arc-${idx + 1}`, conn.aId, conn.bId, conn.weight);
            arcs.push(arc);

            const placeSource = placeMap.get(conn.aId);
            const placeTarget = placeMap.get(conn.bId);
            const transitionSource = transitionMap.get(conn.aId);
            const transitionTarget = transitionMap.get(conn.bId);

            if (placeSource && transitionTarget) {
                transitionTarget.inputPlaces.push(placeSource);
                transitionTarget.inputArcs.push(arc);
            } else if (transitionSource && placeTarget) {
                transitionSource.outputPlaces.push(placeTarget);
                transitionSource.outputArcs.push(arc);
            }
        });

        const nodeLookup = new Map<string, DiagramNode>();
        placeMap.forEach((p, id) => nodeLookup.set(id, p));
        transitionMap.forEach((t, id) => nodeLookup.set(id, t.transition));
        this.applyParallelOffsetsToArcs(arcs, nodeLookup);

        return new Diagram(places, transitions, arcs);
    }

    /**
     * Applies parallel offsets to arcs to prevent visual overlap.
     *
     * Delegates to the utility function for calculating appropriate offsets
     * for parallel arcs between the same nodes.
     *
     * @param {DiagramArc[]} arcs - The arcs to offset
     * @param {Map<string, DiagramNode>} nodeMap - Map of node IDs to nodes for position lookup
     * @private
     */
    private applyParallelOffsetsToArcs(arcs: DiagramArc[], nodeMap: Map<string, DiagramNode>): void {
        applyParallelOffsetsToArcs(arcs, nodeMap, this.CONNECTION_PARALLEL_OFFSET);
    }

    /**
     * Factory method for creating a DiagramPlace object.
     *
     * @param {string} id - Unique identifier for the place
     * @param {string} [label] - Display label for the place
     * @param {number} [initialTokens=0] - Initial token count
     * @param {Object} [options] - Optional configuration
     * @param {string} [options.innerLabel] - Label to display inside the place circle
     * @param {boolean} [options.hideTokens] - Whether to hide token visualization
     * @param {DiagramPlaceLabelPlacement} [options.labelPlacement] - Where to place the label relative to the circle
     * @param {boolean} [options.isStartPlace] - Whether this is a start place
     * @returns {DiagramPlace} The created place
     * @private
     */
    private buildPlace(
        id: string,
        label?: string,
        initialTokens = 0,
        options?: {
            innerLabel?: string;
            hideTokens?: boolean;
            labelPlacement?: DiagramPlaceLabelPlacement;
            isStartPlace?: boolean;
        },
    ): DiagramPlace {
        return new DiagramPlace(id, initialTokens, label, {
            innerLabel: options?.innerLabel ?? undefined,
            hideTokens: options?.hideTokens ?? false,
            labelPlacement: options?.labelPlacement ?? 'below',
            isStartPlace: options?.isStartPlace ?? false,
        });
    }

    /**
     * Factory method for creating a DiagramTransition object.
     *
     * @param {string} id - Unique identifier for the transition
     * @param {string} label - Display label for the transition
     * @param {DiagramTransitionOptions} [options] - Optional configuration
     * @returns {DiagramTransition} The created transition with empty input/output arrays
     * @private
     */
    private buildTransition(id: string, label: string, options?: DiagramTransitionOptions): DiagramTransition {
        return new DiagramTransition(id, label, [], [], [], [], {
            innerLabel: options?.innerLabel ?? label,
        });
    }

    /**
     * Generates the next available place label (p1, p2, p3, ...).
     *
     * Increments the counter and ensures the generated label is unique
     * by checking against existing elements.
     *
     * @returns {string} A unique place label
     * @private
     */
    private getNextPlaceLabel(): string {
        let candidate: string;
        do {
            candidate = `p${++this.placeLabelCounter}`;
        } while (this.isLabelTaken(candidate));
        return candidate;
    }

    /**
     * Generates the next available transition label (t1, t2, t3, ...).
     *
     * Increments the counter and ensures the generated label is unique
     * by checking against existing elements.
     *
     * @returns {string} A unique transition label
     * @private
     */
    private getNextTransitionLabel(): string {
        let candidate: string;
        do {
            candidate = `t${++this.transitionLabelCounter}`;
        } while (this.isLabelTaken(candidate));
        return candidate;
    }

    /**
     * Gets the display label for a diagram node.
     *
     * @param {DiagramNode} node - The node to get the label from
     * @returns {string} The node's display label or ID as fallback
     * @private
     */
    private getNodeLabel(node: DiagramNode): string {
        if (node instanceof DiagramPlace) return node.displayLabel;
        if (node instanceof DiagramTransition) return node.displayLabel;
        return node.displayLabel ?? node.id;
    }

    /**
     * Converts mouse/drag event coordinates to SVG coordinate space.
     *
     * @param {MouseEvent | DragEvent} event - The event containing client coordinates
     * @returns {{ x: number; y: number } | null} SVG coordinates or null if conversion fails
     * @private
     */
    private getSvgCoordinates(event: MouseEvent | DragEvent): { x: number; y: number } | null {
        return this.getSvgCoordinatesFromClient(event.clientX, event.clientY);
    }

    /**
     * Converts client (screen) coordinates to SVG coordinate space.
     *
     * Uses the SVG's transformation matrix to convert from screen pixels
     * to the SVG's coordinate system, accounting for pan and zoom.
     *
     * @param {number} clientX - The client X coordinate
     * @param {number} clientY - The client Y coordinate
     * @returns {{ x: number; y: number } | null} SVG coordinates or null if conversion fails
     * @private
     */
    private getSvgCoordinatesFromClient(clientX: number, clientY: number): { x: number; y: number } | null {
        if (!this.svgElement) {
            this.svgElement = (this.drawingArea?.nativeElement as SVGSVGElement) ?? null;
        }
        if (!this.svgElement) return null;
        const point = this.svgElement.createSVGPoint();
        point.x = clientX;
        point.y = clientY;
        const ctm = this.svgElement.getScreenCTM();
        if (!ctm) return null;
        const svgPoint = point.matrixTransform(ctm.inverse());
        return { x: svgPoint.x, y: svgPoint.y };
    }

    /**
     * Computes a connection line with parallel offset and endpoint trimming.
     *
     * Calculates the visual line coordinates for an arc, applying:
     * 1. A perpendicular offset to avoid overlap with parallel arcs
     * 2. Trimming at the edges of the node shapes (circles/rectangles)
     *
     * @param {DrawnElement} a - The source element
     * @param {DrawnElement} b - The target element
     * @param {number} offset - The perpendicular offset distance
     * @param {number} [basePerpX] - Precomputed perpendicular X component (optional)
     * @param {number} [basePerpY] - Precomputed perpendicular Y component (optional)
     * @returns {{ x1: number; y1: number; x2: number; y2: number }} Line coordinates
     * @private
     */
    private computeOffsetTrimmedLine(
        a: DrawnElement,
        b: DrawnElement,
        offset: number,
        basePerpX?: number,
        basePerpY?: number,
    ): { x1: number; y1: number; x2: number; y2: number } {
        const ax = a.node.x;
        const ay = a.node.y;
        const bx = b.node.x;
        const by = b.node.y;
        const dx = bx - ax;
        const dy = by - ay;
        const len = Math.hypot(dx, dy) || 1;
        const perpX = basePerpX ?? -dy / len;
        const perpY = basePerpY ?? dx / len;

        const shiftedAx = ax + perpX * offset;
        const shiftedAy = ay + perpY * offset;
        const shiftedBx = bx + perpX * offset;
        const shiftedBy = by + perpY * offset;

        const start = this.trimEndpoint(a.node, shiftedAx, shiftedAy, shiftedBx, shiftedBy);
        const end = this.trimEndpoint(b.node, shiftedBx, shiftedBy, shiftedAx, shiftedAy);

        return { x1: start.x, y1: start.y, x2: end.x, y2: end.y };
    }

    /**
     * Trims a line endpoint to the edge of a node shape.
     *
     * Calculates where a line should end when connecting to a node,
     * accounting for the node's shape:
     * - For places (circles): Trims to the circle's radius
     * - For transitions (rectangles): Trims to the rectangle's edge
     *
     * @param {DiagramNode} node - The node to trim to
     * @param {number} originX - The line's origin X coordinate
     * @param {number} originY - The line's origin Y coordinate
     * @param {number} targetX - The line's target X coordinate
     * @param {number} targetY - The line's target Y coordinate
     * @returns {{ x: number; y: number }} The trimmed endpoint coordinates
     * @private
     */
    private trimEndpoint(
        node: DiagramNode,
        originX: number,
        originY: number,
        targetX: number,
        targetY: number,
    ): { x: number; y: number } {
        const dx = targetX - originX;
        const dy = targetY - originY;
        const dist = Math.hypot(dx, dy) || 1;
        const ux = dx / dist;
        const uy = dy / dist;

        if (node instanceof DiagramPlace) {
            return { x: originX + ux * this.PLACE_RADIUS, y: originY + uy * this.PLACE_RADIUS };
        }
        if (node instanceof DiagramTransition) {
            const halfW = this.TRANSITION_HALF_W;
            const halfH = this.TRANSITION_HALF_H;
            const xIntercept = Math.abs(ux) > 0 ? halfW / Math.abs(ux) : Number.POSITIVE_INFINITY;
            const yIntercept = Math.abs(uy) > 0 ? halfH / Math.abs(uy) : Number.POSITIVE_INFINITY;
            const intercept = Math.min(xIntercept, yIntercept);
            return { x: originX + ux * intercept, y: originY + uy * intercept };
        }
        return { x: originX, y: originY };
    }

    /**
     * Parses a tuple string into a structured preview for display.
     *
     * Expected format: (P, T, F, M)
     * - P: Set of places
     * - T: Set of transitions
     * - F: Set of arcs with format "source->target" or "source->target:weight"
     * - M: Marking (token distribution)
     *
     * @param {string} text - The tuple string to parse
     * @returns {TuplePreview | null} Parsed preview object or null if parsing fails
     * @private
     */
    private parseTuplePreview(text: string): TuplePreview | null {
        const cleaned = text.trim();
        if (!cleaned.startsWith('(') || !cleaned.endsWith(')')) return null;
        const inner = cleaned.slice(1, -1);
        const parts = this.splitTopLevel(inner, ',');
        if (parts.length < 4) return null;

        const placePart = parts[0].trim();
        const transitionPart = parts[1].trim();
        const arcsPart = parts[2].trim();
        const markingPart = parts.slice(3).join(',').trim();

        const places = this.parseSet(placePart);
        const transitions = this.parseSet(transitionPart);
        const arcs = this.parseArcs(arcsPart);
        const marking = this.parseMarking(markingPart);

        return { places, transitions, arcs, marking };
    }

    /**
     * Parses a set notation string (e.g., "{a, b, c}") into an array.
     *
     * @param {string} part - The set string to parse
     * @returns {string[]} Array of elements from the set
     * @private
     */
    private parseSet(part: string): string[] {
        const match = part.match(/^\{(.+)}$/);
        if (!match) return [];
        return match[1]
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
    }

    /**
     * Parses arc notation from tuple string.
     *
     * Recognizes formats like:
     * - (source, target) for simple arcs
     * - 2*(source, target) for weighted arcs
     *
     * @param {string} part - The arcs portion of the tuple string
     * @returns {Array<{ raw: string; source: string; target: string }>} Parsed arc definitions
     * @private
     */
    private parseArcs(part: string): { raw: string; source: string; target: string }[] {
        const arcs: { raw: string; source: string; target: string }[] = [];
        const regex = /(\d+\s*\*\s*)?\(\s*([^,\s]+)\s*,\s*([^,\s)]+)\s*\)/g;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(part))) {
            arcs.push({ raw: match[0], source: match[2], target: match[3] });
        }
        return arcs;
    }

    /**
     * Parses marking (token distribution) from tuple string.
     *
     * Recognizes formats like:
     * - "p1" for 1 token at p1
     * - "2*p1" for 2 tokens at p1
     * - "p1 + p2 + 3*p3" for multiple places
     *
     * @param {string} part - The marking portion of the tuple string
     * @returns {Array<{ raw: string; label: string }>} Parsed marking entries
     * @private
     */
    private parseMarking(part: string): { raw: string; label: string }[] {
        if (!part) return [];
        return part
            .split('+')
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
            .map((raw) => {
                const match = raw.match(/\d+\s*\*\s*(\S+)/) || raw.match(/(\S+)/);
                const label = match ? match[1] : raw;
                return { raw, label };
            });
    }

    /**
     * Splits a string by a separator, respecting nested parentheses and braces.
     *
     * Only splits at separators that are at the top level (not inside () or {}).
     * This ensures that nested tuple structures are preserved.
     *
     * @param {string} text - The text to split
     * @param {string} separator - The separator character
     * @returns {string[]} Array of split parts
     * @private
     */
    private splitTopLevel(text: string, separator: string): string[] {
        const result: string[] = [];
        let depthParens = 0;
        let depthBraces = 0;
        let start = 0;
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (ch === '(') depthParens++;
            else if (ch === ')') depthParens = Math.max(0, depthParens - 1);
            else if (ch === '{') depthBraces++;
            else if (ch === '}') depthBraces = Math.max(0, depthBraces - 1);
            else if (ch === separator && depthParens === 0 && depthBraces === 0) {
                result.push(text.slice(start, i));
                start = i + 1;
            }
        }
        result.push(text.slice(start));
        return result;
    }

    /**
     * Sets the ID of the currently hovered element.
     *
     * @param {string | null} id - The element ID or null to clear hover state
     */
    setHoveredElementId(id: string | null) {
        if (this.isExamMode) {
            this.hoveredElementId.set(null);
            this.hoveredConnectionId.set(null);
            return;
        }
        this.hoveredElementId.set(id);
        if (id !== null) {
            this.hoveredConnectionId.set(null);
            if (!this.showTuplePreviewOnly()) {
                this.showTuplePreviewIfAvailable();
            }
        }
    }

    /**
     * Sets the ID of the currently hovered connection (arc).
     *
     * Clears element hover state when a connection is hovered.
     * In exam mode, all hover states are disabled.
     * Shows tuple preview when hovering if not already showing.
     *
     * @param {string | null} id - The connection ID or null to clear hover state
     */
    setHoveredConnectionId(id: string | null) {
        if (this.isExamMode) {
            this.hoveredElementId.set(null);
            this.hoveredConnectionId.set(null);
            return;
        }
        this.hoveredConnectionId.set(id);
        if (id !== null) {
            this.hoveredElementId.set(null);
            if (!this.showTuplePreviewOnly()) {
                this.showTuplePreviewIfAvailable();
            }
        }
    }

    /**
     * Sets the hovered element by its label instead of ID.
     *
     * Looks up the element ID from the label and sets the hover state.
     * Useful for tuple preview interactions where only labels are available.
     *
     * @param {string | null} label - The element label or null to clear hover state
     */
    setHoveredElementByLabel(label: string | null) {
        if (!label) {
            this.setHoveredElementId(null);
            return;
        }
        const id = this.getElementIdByLabel(label);
        this.setHoveredElementId(id);
    }

    /**
     * Sets the hovered connection by source and target labels.
     *
     * Looks up the connection ID from the source and target labels and sets the hover state.
     * Useful for tuple preview interactions where only labels are available.
     *
     * @param {string | null} sourceLabel - The source element label
     * @param {string | null} targetLabel - The target element label
     */
    setHoveredConnectionByLabels(sourceLabel: string | null, targetLabel: string | null) {
        if (!sourceLabel || !targetLabel) {
            this.setHoveredConnectionId(null);
            return;
        }
        const id = this.getConnectionIdByLabels(sourceLabel, targetLabel);
        this.setHoveredConnectionId(id);
    }

    /**
     * Finds an element's ID by its display label.
     *
     * @param {string} label - The label to search for
     * @returns {string | null} The element ID or null if not found
     */
    getElementIdByLabel(label: string): string | null {
        const normalized = label.trim();
        const match = this.drawnElements().find((el) => this.getNodeLabel(el.node) === normalized);
        return match?.id ?? null;
    }

    /**
     * Finds a connection's ID by the labels of its source and target elements.
     *
     * @param {string} sourceLabel - The source element label
     * @param {string} targetLabel - The target element label
     * @returns {string | null} The connection ID or null if not found
     */
    getConnectionIdByLabels(sourceLabel: string, targetLabel: string): string | null {
        const srcId = this.getElementIdByLabel(sourceLabel);
        const tgtId = this.getElementIdByLabel(targetLabel);
        if (!srcId || !tgtId) return null;
        const conn = this.connections().find((c) => c.aId === srcId && c.bId === tgtId);
        return conn?.id ?? null;
    }
}
