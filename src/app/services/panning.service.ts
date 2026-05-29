import { computed, ElementRef, Injectable, signal } from '@angular/core';
import { DisplayableGraph } from '../classes/displayable-graph.interface';
import { PLACE_RADIUS, TRANSITION_SIZE, ViewBox, viewBoxValues } from '../components/display/display.constants';
import { SHAPE } from '../classes/diagram/diagram-node';

@Injectable({
    providedIn: 'root',
})
export class PanningService {
    INITIAL_VIEWBOX: ViewBox = viewBoxValues;
    private readonly ZOOM_INTENSITY = 0.1;
    private _viewBoxValues = signal(this.INITIAL_VIEWBOX);
    public viewBox = this._viewBoxValues.asReadonly();
    private _isPanning = false;
    private _panStartPoint = { x: 0, y: 0 };
    private _panScale = { x: 1, y: 1 };

    public viewBoxAsString = computed(() => {
        const v: ViewBox = this._viewBoxValues();
        return `${v.minX} ${v.minY} ${v.width} ${v.height}`;
    });

    /**
     * Initiates the panning process.
     * @param event
     *          the mouse event that started the panning
     * @param drawingArea
     *        reference to the SVG drawing area
     */
    public startPan(event: MouseEvent, drawingArea: ElementRef<SVGGraphicsElement>): void {
        if (event.button !== 0) return;
        this._isPanning = true;
        this._panStartPoint = { x: event.clientX, y: event.clientY };

        const svg = drawingArea.nativeElement;
        const rect = svg.getBoundingClientRect();
        const vb = this._viewBoxValues();
        const scale = Math.max(vb.width / (rect.width || 1), vb.height / (rect.height || 1));
        this._panScale = {
            x: scale,
            y: scale,
        };

        drawingArea.nativeElement.style.cursor = 'grabbing';
    }

    /**
     * Handles the panning movement by updating the viewBox values,
     * based on mouse movement.
     * @param event
     *         the mouse event during panning
     * @param drawingArea
     *        reference to the SVG drawing area
     */
    public pan(event: MouseEvent, drawingArea: ElementRef<SVGGraphicsElement>): void {
        if (!this._isPanning) {
            return;
        }
        event.preventDefault();

        const dx = (event.clientX - this._panStartPoint.x) * this._panScale.x;
        const dy = (event.clientY - this._panStartPoint.y) * this._panScale.y;

        this._viewBoxValues.update(
            (v: ViewBox): ViewBox => ({
                ...v,
                minX: v.minX - dx,
                minY: v.minY - dy,
            }),
        );
        this._panStartPoint = { x: event.clientX, y: event.clientY };
    }

    /**
     * Ends the panning process.
     * @param drawingArea
     *       reference to the SVG drawing area
     */
    public endPan(drawingArea: ElementRef<SVGGraphicsElement>): void {
        this._isPanning = false;
        drawingArea.nativeElement.style.cursor = 'default';
    }

    /**
     * Resets the viewBox to its initial values and clears the panning state.
     * @param drawingArea
     *        optional reference to the SVG drawing area, to reset the cursor style
     */
    public resetViewBox(drawingArea?: ElementRef<SVGGraphicsElement>): void {
        this._isPanning = false;
        this._panStartPoint = { x: 0, y: 0 };
        this._viewBoxValues.set({ ...this.INITIAL_VIEWBOX });
        if (drawingArea) {
            drawingArea.nativeElement.style.cursor = 'default';
        }
    }

    public fitViewToGraph(graph: DisplayableGraph): void {
        const nodes = graph.getNodes();
        if (nodes.length === 0) return;

        let minX = Number.MAX_VALUE;
        let minY = Number.MAX_VALUE;
        let maxX = Number.MIN_VALUE;
        let maxY = Number.MIN_VALUE;

        nodes.forEach((node) => {
            let halfWidth;
            let halfHeight;
            if (node.shape === SHAPE.CIRCLE) {
                halfWidth = PLACE_RADIUS;
                halfHeight = PLACE_RADIUS;
            } else {
                halfWidth = TRANSITION_SIZE / 2;
                halfHeight = TRANSITION_SIZE / 2;
            }

            minX = Math.min(minX, node.x - halfWidth);
            minY = Math.min(minY, node.y - halfHeight);
            maxX = Math.max(maxX, node.x + halfWidth);
            maxY = Math.max(maxY, node.y + halfHeight);
        });

        const padding = 50;
        const width = maxX - minX + 2 * padding;
        const height = maxY - minY + 2 * padding;

        this._viewBoxValues.set({
            minX: minX - padding,
            minY: minY - padding,
            width: width,
            height: height,
        });
    }

    public nudgeViewBox(deltaX: number, deltaY: number): void {
        this._viewBoxValues.update(
            (v: ViewBox): ViewBox => ({
                ...v,
                minX: v.minX + deltaX,
                minY: v.minY + deltaY,
            }),
        );
    }

    /**
     * Handles zooming in and out based on mouse wheel events.
     * @param event
     *        the wheel event triggering the zoom
     * @param drawingArea
     *       reference to the SVG drawing area
     */
    public zoom(event: WheelEvent, drawingArea: ElementRef<SVGGraphicsElement>): void {
        event.preventDefault();

        const svg = drawingArea.nativeElement;
        const clientRect = svg.getBoundingClientRect();

        const factor = event.deltaY > 0 ? 1 + this.ZOOM_INTENSITY : 1 - this.ZOOM_INTENSITY;

        this._viewBoxValues.update((v: ViewBox): ViewBox => {
            const newWidth = v.width * factor;
            const newHeight = v.height * factor;

            const mouseRelX = (event.clientX - clientRect.left) / clientRect.width;
            const mouseRelY = (event.clientY - clientRect.top) / clientRect.height;

            const dx = (v.width - newWidth) * mouseRelX;
            const dy = (v.height - newHeight) * mouseRelY;

            return {
                minX: v.minX + dx,
                minY: v.minY + dy,
                width: newWidth,
                height: newHeight,
            };
        });
    }

    public expandViewBox(factor: number): void {
        if (factor <= 0) return;
        this._viewBoxValues.update(
            (v: ViewBox): ViewBox => ({
                ...v,
                width: v.width * factor,
                height: v.height * factor,
            }),
        );
    }
}
