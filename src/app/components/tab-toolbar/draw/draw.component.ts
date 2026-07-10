import {
    AfterViewInit,
    Component,
    computed,
    ElementRef,
    inject,
    OnDestroy,
    OnInit,
    signal,
    ViewChild,
} from '@angular/core';
import { SvgNodeComponent } from '../../display/svg-node/svg-node.component';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { DrawService } from '../../../services/draw.service';
import { MatDialogModule } from '@angular/material/dialog';
import { DisplayService } from '../../../services/display.service';
import { ImageExportService } from '../../../services/image-export.service';
import { ModeService } from '../../../services/mode.service';
import { Subscription } from 'rxjs';
import { GRAPH_FILENAMES, GRAPH_IDS } from '../../display/display.constants';
import {
    DrawToolbarAction,
    DrawToolbarComponent,
    DrawToolbarInstruction,
    DrawToolbarToggle,
} from '../../draw-toolbar/draw-toolbar.component';
import { DrawnElement } from '../../../classes/diagram/drawn-element';

/**
 * DrawComponent
 *
 * The main component for the Petri Net drawing interface. This component provides a visual canvas
 * where users can create and manipulate Petri Net diagrams by drawing places, transitions, and arcs.
 *
 * Key responsibilities:
 * - Manages the SVG drawing canvas and its viewport (pan, zoom)
 * - Handles user interactions (drag-drop, click, double-click, wheel events)
 * - Coordinates with DrawService to perform drawing operations
 * - Manages UI state for selected/hovered elements
 * - Supports image export of the drawn Petri Net
 * - Provides tuple editing interface for token marking
 * - Displays contextual toolbar instructions to the user
 *
 * User Interactions:
 * - Drag-drop elements from palette to canvas
 * - Left-click to move elements
 * - Right-click to create connections (arcs)
 * - Middle-click to delete elements
 * - Double-click to edit element labels
 * - Scroll to modify token weights or zoom
 * - Text input for direct tuple editing
 *
 * @implements {AfterViewInit} For initializing the drawing canvas after view is initialized
 * @implements {OnInit} For initializing the component and subscribing to download requests
 * @implements {OnDestroy} For cleanup and unsubscribing from observables
 */
@Component({
    selector: 'app-draw',
    standalone: true,
    imports: [CommonModule, FormsModule, TranslateModule, SvgNodeComponent, MatDialogModule, DrawToolbarComponent],
    templateUrl: './draw.component.html',
    styleUrl: './draw.component.css',
    providers: [],
})
export class DrawComponent implements AfterViewInit, OnDestroy, OnInit {
    /** Reference to the SVG drawing canvas element */
    @ViewChild('drawingArea') drawingArea!: ElementRef<SVGGraphicsElement>;

    /** Service for managing drawing operations and element state */
    draw = inject(DrawService);
    /** Reference to this component's native DOM element */
    private _elementRef = inject(ElementRef);
    /** Service for display-related functionality and download requests */
    private _displayService = inject(DisplayService);
    /** Service for exporting drawn diagrams as images */
    private _imageExportService = inject(ImageExportService);
    /** Service for managing application modes (e.g., exam mode) */
    private _modeService = inject(ModeService);
    /** Subscription to the download request observable */
    private _sub?: Subscription;

    // ===== Reactive State Signals from DrawService =====
    /** Observable array of all drawn elements (places, transitions, arcs) */
    readonly drawnElements = this.draw.drawnElements;
    /** Signal indicating if an element is currently being dragged over the canvas */
    readonly isDragOver = this.draw.isDragOver;
    /** Signal containing the ID of the currently selected element, or null if none */
    readonly selectedElementId = this.draw.selectedElementId;
    /** Signal containing the ID of the currently hovered element, or null if none */
    readonly hoveredElementId = this.draw.hoveredElementId;
    /** Signal containing the ID of the currently hovered connection/arc, or null if none */
    readonly hoveredConnectionId = this.draw.hoveredConnectionId;
    /** Array of rendered connection lines (arcs) between elements */
    readonly connectionLines = this.draw.connectionLines;
    /** Signal containing the tuple preview data for visual feedback */
    readonly tuplePreview = this.draw.tuplePreview;
    /** Signal to show only the tuple preview, hiding other UI elements */
    readonly showTuplePreviewOnly = this.draw.showTuplePreviewOnly;

    /**
     * Gets the current tuple string representing token markings.
     * @returns {string} The current tuple string from DrawService
     */
    get tupleString(): string {
        return this.draw.tupleString();
    }

    /**
     * Sets the tuple string representing token markings.
     * @param {string} value - The new tuple string to set
     */
    set tupleString(value: string) {
        this.draw.setTupleString(value);
    }

    /** SVG viewBox string for the drawing canvas (e.g., "0 0 1000 1000") */
    readonly viewBox = this.draw.viewBox;
    /** Parsed viewBox object containing x, y, width, and height values */
    readonly viewBoxObj = this.draw.viewBoxObj;

    /** Signal for toggle switch state */
    protected toggleState = signal(true);

    /**
     * Angular lifecycle hook: OnInit
     *
     * Initializes the component by:
     * - Initializing the DrawService
     * - Subscribing to display download requests
     * - Triggering image export when download is requested for the Petri Net graph
     */
    ngOnInit(): void {
        this.draw.init();

        this._sub = this._displayService.downloadRequest$.subscribe(({ format, target }) => {
            if (target && target !== GRAPH_IDS.PETRI_NET) {
                return;
            }
            if (this._elementRef.nativeElement.getBoundingClientRect().height === 0) {
                return;
            }
            this._imageExportService.exportImage(
                this.drawingArea.nativeElement,
                format,
                GRAPH_FILENAMES[GRAPH_IDS.PETRI_NET],
            );
        });
    }

    /**
     * Angular lifecycle hook: AfterViewInit
     *
     * Called after the component's view is initialized. Registers the SVG drawing area
     * reference with the DrawService so it can manage rendering operations.
     */
    ngAfterViewInit() {
        this.draw.setDrawingArea(this.drawingArea);
    }

    /**
     * Angular lifecycle hook: OnDestroy
     *
     * Cleans up resources by:
     * - Destroying the DrawService
     * - Unsubscribing from the download request observable
     */
    ngOnDestroy(): void {
        this.draw.destroy();
        this._sub?.unsubscribe();
    }

    /**
     * Initiates a drag operation for a palette element (place or transition).
     * Called when the user starts dragging from the element palette.
     *
     * @param {DragEvent} event - The drag event
     * @param {'place' | 'transition'} type - The type of element being dragged
     */
    startPaletteDrag(event: DragEvent, type: 'place' | 'transition') {
        this.draw.startPaletteDrag(event, type);
    }

    /**
     * Ends a drag operation for a palette element.
     * Called when the user releases a dragged palette element.
     */
    endPaletteDrag() {
        this.draw.endPaletteDrag();
    }

    /**
     * Handles the dragover event on the canvas.
     * Updates the visual feedback (isDragOver state) while an element is being dragged over the canvas.
     *
     * @param {DragEvent} event - The dragover event
     */
    onDragOver(event: DragEvent) {
        this.draw.onDragOver(event);
    }

    /**
     * Handles the dragleave event on the canvas.
     * Removes the visual feedback when the dragged element leaves the canvas area.
     */
    onDragLeave() {
        this.draw.onDragLeave();
    }

    /**
     * Handles the drop event on the canvas.
     * Processes the dropped element and adds it to the Petri Net.
     *
     * @param {DragEvent} event - The drop event
     */
    onDrop(event: DragEvent) {
        this.draw.onDrop(event);
    }

    /**
     * Starts a pan operation on the canvas.
     * Called when the user begins to pan (typically with middle mouse button or space+drag).
     *
     * @param {MouseEvent} event - The mouse event
     */
    onCanvasPanStart(event: MouseEvent) {
        this.draw.onCanvasPanStart(event);
    }

    /**
     * Handles continuous panning of the canvas during a pan operation.
     * Updates the viewBox to reflect the pan motion.
     *
     * @param {MouseEvent} event - The mouse event
     */
    onCanvasPan(event: MouseEvent) {
        this.draw.onCanvasPan(event);
    }

    /**
     * Ends a pan operation on the canvas.
     * Called when the user releases the pan control.
     */
    onCanvasPanEnd() {
        this.draw.onCanvasPanEnd();
    }

    /**
     * Handles mouse wheel events on the canvas.
     * Typically used for zooming in/out or adjusting canvas properties.
     *
     * @param {WheelEvent} event - The wheel event
     */
    onCanvasWheel(event: WheelEvent) {
        this.draw.onCanvasWheel(event);
    }

    /**
     * Prevents the default context menu from appearing on the canvas.
     * Allows the application to use right-click for custom operations (e.g., creating connections).
     *
     * @param {MouseEvent} event - The context menu event
     */
    preventContext(event: MouseEvent) {
        this.draw.preventContext(event);
    }

    /**
     * Handles clicks on the tuple button in the UI.
     * Toggles the tuple input interface and shows a preview of tuple values if available.
     */
    onTupleButtonClick(): void {
        this.draw.onTupleButtonClick();
        this.draw.showTuplePreviewIfAvailable();
    }

    /**
     * Handles clicks on the tuple preview element.
     * Transitions from preview mode to inline editing mode.
     */
    onTuplePreviewClick(): void {
        this.draw.showTupleInline();
    }

    /**
     * Handles mouse down events on drawn elements.
     * Initiates element selection or movement.
     *
     * @param {MouseEvent} event - The mouse event
     * @param {DrawnElement} element - The element being interacted with
     */
    onElementMouseDown(event: MouseEvent, element: DrawnElement) {
        this.draw.onElementMouseDown(event, element);
    }

    /**
     * Handles right-click events on drawn elements.
     * Typically used for creating connections (arcs) from the element.
     *
     * @param {MouseEvent} event - The right-click event
     * @param {DrawnElement} element - The element being right-clicked
     */
    onElementRightClick(event: MouseEvent, element: DrawnElement) {
        this.draw.onElementRightClick(event, element);
    }

    /**
     * Handles mouse down events on connection lines (arcs).
     * Used for selecting or interacting with arc connections.
     *
     * @param {MouseEvent} event - The mouse event
     * @param {string} connectionId - The unique identifier of the connection
     */
    onConnectionMouseDown(event: MouseEvent, connectionId: string) {
        this.draw.onConnectionMouseDown(event, connectionId);
    }

    /**
     * Handles wheel events on connection lines (arcs).
     * Typically used for modifying arc weights or other properties.
     *
     * @param {WheelEvent} event - The wheel event
     * @param {string} connectionId - The unique identifier of the connection
     */
    onConnectionWheel(event: WheelEvent, connectionId: string) {
        this.draw.onConnectionWheel(event, connectionId);
    }

    /**
     * Handles double-click events on drawn elements.
     * Initiates label editing for the element.
     *
     * @param {MouseEvent} event - The double-click event
     * @param {DrawnElement} element - The element being double-clicked
     */
    onElementDoubleClick(event: MouseEvent, element: DrawnElement) {
        this.draw.onElementDoubleClick(event, element);
    }

    /**
     * Handles wheel events on drawn elements.
     * Typically used for modifying element properties like token counts.
     *
     * @param {WheelEvent} event - The wheel event
     * @param {DrawnElement} element - The element receiving the wheel event
     */
    onElementWheel(event: WheelEvent, element: DrawnElement) {
        this.draw.onElementWheel(event, element);
    }

    /**
     * Handles paste events in the tuple input textarea.
     * Ensures pasted text is directly inserted into the tuple string without additional formatting.
     *
     * @param {ClipboardEvent} event - The clipboard paste event
     */
    onTupleTextareaPaste(event: ClipboardEvent) {
        // Ensure pasted text goes directly into tupleString
        const text = event.clipboardData?.getData('text');
        if (text !== undefined && text !== null) {
            event.preventDefault();
            this.tupleString = text;
        }
    }

    /**
     * TrackBy function for ngFor optimization on connection lines.
     * Helps Angular identify connection line elements by their unique ID.
     *
     * @param {number} _ - The index (unused)
     * @param {Object} line - The connection line object with an id property
     * @returns {string} The unique identifier of the line
     */
    trackLineById = (_: number, line: { id: string }): string => line.id;

    /**
     * TrackBy function for ngFor optimization on drawn elements.
     * Helps Angular identify drawn elements by their unique ID.
     *
     * @param {number} _ - The index (unused)
     * @param {DrawnElement} element - The drawn element with an id property
     * @returns {string} The unique identifier of the element
     */
    trackElementById = (_: number, element: DrawnElement): string => element.id;

    /**
     * Returns the list of toolbar action items.
     * Provides actions such as clearing the drawing area.
     *
     * @returns {DrawToolbarAction[]} Array of toolbar action configurations
     */
    toolbarActions = computed<DrawToolbarAction[]>(() => {
        const hasElements = this.drawnElements().length > 0;
        return [
            {
                icon: 'delete',
                tooltip: 'DRAW.ACTION.CLEAR_DRAWING',
                color: 'warn',
                isActive: hasElements,
                action: () => this.draw.clearCanvas(false, true),
            },
        ];
    });

    /**
     * Computed signal containing the instruction labels and descriptions for the drawing toolbar.
     * Provides localized instructions for user interactions with the drawing interface.
     *
     * Instructions include:
     * - ACTION_DRAG_DROP: How to drag elements from the palette
     * - MOVE: How to move elements on the canvas
     * - CONNECT: How to create connections between elements
     * - DELETE: How to delete elements
     * - EDIT_LABEL: How to edit element labels
     * - SCROLL: How to modify token weights or zoom
     */
    protected readonly toolbarInstructions = computed<DrawToolbarInstruction[]>(() => {
        return [
            { label: 'DRAW.INSTRUCTION.ACTION_DRAG_DROP', text: 'DRAW.INSTRUCTION.DRAG_DROP' },
            { label: 'DRAW.INSTRUCTION.MOVE', text: 'DRAW.INSTRUCTION.LEFT_CLICK_MOVE' },
            { label: 'DRAW.INSTRUCTION.CONNECT', text: 'DRAW.INSTRUCTION.RIGHT_CLICK_CONNECT' },
            { label: 'DRAW.INSTRUCTION.DELETE', text: 'DRAW.INSTRUCTION.MIDDLE_CLICK_DELETE' },
            { label: 'DRAW.INSTRUCTION.EDIT_LABEL', text: 'DRAW.INSTRUCTION.DOUBLE_CLICK_EDIT_LABEL' },
            { label: 'DRAW.INSTRUCTION.SCROLL', text: 'DRAW.INSTRUCTION.SCROLL_CHANGE_TOKENS_WEIGHT' },
        ];
    });

    /**
     * Computed signal for the toolbar toggle configuration.
     * Controls whether the drawing is displayed on the canvas.
     * When toggled off, only the tuple is shown; when on, both tuple and drawing are shown.
     */
    protected readonly toolbarToggle = computed<DrawToolbarToggle>(() => {
        return {
            label: 'DRAW.TOGGLE.SHOW_DRAWING',
            tooltip: 'DRAW.TOGGLE.SHOW_DRAWING_TOOLTIP',
            checked: this.toggleState(),
            onChange: (checked: boolean) => {
                this.toggleState.set(checked);
                this.draw.setShowDrawing(checked);
            },
        };
    });
}
