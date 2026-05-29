import { ElementRef, inject, Injectable } from '@angular/core';
import { DisplayService } from './display.service';
import { Diagram } from '../classes/diagram/diagram';
import { PLACE_RADIUS, TRANSITION_SIZE } from '../components/display/display.constants';
import { PanningService } from './panning.service';

export interface ElementCoordinates {
    x: number;
    y: number;
    isPlace: boolean;
}

@Injectable({
    providedIn: 'root',
})
export class DrawingDisplayService {
    private displayService = inject(DisplayService);

    /**
     * Converts client coordinates of a mouse/drag event to SVG drawing coordinates.
     */
    public getSvgCoordinates(
        event: MouseEvent | DragEvent,
        svgElement: SVGSVGElement | null,
    ): { x: number; y: number } | null {
        return this.getSvgCoordinatesFromClient(event.clientX, event.clientY, svgElement);
    }

    /**
     * Converts client coordinates to SVG coordinates using the SVG element's CTM.
     */
    public getSvgCoordinatesFromClient(
        clientX: number,
        clientY: number,
        svgElement: SVGSVGElement | null,
    ): { x: number; y: number } | null {
        let svg = svgElement;
        if (!svg) {
            const canvases = document.querySelectorAll('.drawing-canvas');
            for (const canvas of Array.from(canvases)) {
                const rect = canvas.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                    svg = canvas as SVGSVGElement;
                    break;
                }
            }
        }
        if (!svg) {
            return null;
        }

        const point = svg.createSVGPoint();
        point.x = clientX;
        point.y = clientY;

        const ctm = svg.getScreenCTM();
        if (!ctm) {
            return null;
        }

        const svgPoint = point.matrixTransform(ctm.inverse());
        return { x: svgPoint.x, y: svgPoint.y };
    }

    /**
     * Computes trimmed endpoints of a line connecting two nodes, shortened by their shapes' boundaries.
     */
    public computeTrimmedLine(
        a: ElementCoordinates,
        b: ElementCoordinates,
        placeRadius: number = PLACE_RADIUS,
        transitionSize: number = TRANSITION_SIZE,
    ): { x1: number; y1: number; x2: number; y2: number } {
        const ax = a.x;
        const ay = a.y;
        const bx = b.x;
        const by = b.y;
        const dx = bx - ax;
        const dy = by - ay;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len;
        const uy = dy / len;

        const transitionHalf = transitionSize / 2;
        const aOffset = a.isPlace ? placeRadius : transitionHalf;
        const bOffset = b.isPlace ? placeRadius : transitionHalf;

        const x1 = ax + ux * aOffset;
        const y1 = ay + uy * aOffset;
        const x2 = bx - ux * bOffset;
        const y2 = by - uy * bOffset;
        return { x1, y1, x2, y2 };
    }

    /**
     * Gets the number of required tokens for a given place ID to start at.
     */
    public getRequiredStartCount(placeOrConditionId: string): number {
        const base = this.displayService.diagram;
        if (!base || !(base instanceof Diagram)) {
            return 0;
        }
        const tokens = base.startMarking[placeOrConditionId] ?? 0;
        return Math.max(0, Math.floor(tokens));
    }

    /**
     * Checks if a place or condition is marked at the start of the Petri net.
     */
    public isMarkedId(placeOrConditionId: string): boolean {
        return this.getRequiredStartCount(placeOrConditionId) > 0;
    }

    /**
     * Resets the marking of the diagram if active.
     */
    public resetDiagramMarking(): void {
        const diagram = this.displayService.diagram;
        if (diagram instanceof Diagram) {
            diagram.resetMarking();
        }
    }

    /**
     * Checks if exactly one element is a place and the other is a transition.
     */
    public isValidConnectionPair(aIsPlace: boolean, bIsPlace: boolean): boolean {
        return aIsPlace !== bIsPlace;
    }

    /**
     * Common canvas panning start handler.
     */
    public handleCanvasPanStart(
        event: MouseEvent,
        isDraggingElement: boolean,
        drawingArea: ElementRef<SVGGraphicsElement>,
        panningService: PanningService,
    ): void {
        if (isDraggingElement) return;
        const target = event.target as Element | null;
        const isOnElement = target?.closest('.element-wrapper') || target?.classList.contains('drag-overlay');
        if (isOnElement) {
            return;
        }
        panningService.startPan(event, drawingArea);
    }

    /**
     * Common canvas panning move handler.
     */
    public handleCanvasPan(
        event: MouseEvent,
        isDraggingElement: boolean,
        drawingArea: ElementRef<SVGGraphicsElement>,
        panningService: PanningService,
    ): void {
        if (isDraggingElement) return;
        panningService.pan(event, drawingArea);
    }

    /**
     * Common canvas panning end handler.
     */
    public handleCanvasPanEnd(drawingArea: ElementRef<SVGGraphicsElement>, panningService: PanningService): void {
        panningService.endPan(drawingArea);
    }

    /**
     * Common canvas wheel zoom handler.
     */
    public handleCanvasWheel(
        event: WheelEvent,
        drawingArea: ElementRef<SVGGraphicsElement>,
        panningService: PanningService,
    ): void {
        panningService.zoom(event, drawingArea);
    }

    /**
     * Intercepts mouse down events on the canvas to check if a drawn node was clicked.
     * If so, executes the onMouseDown callback.
     */
    public handleCanvasMouseDown<T extends { id: string }>(
        event: MouseEvent,
        drawnElements: T[],
        onMouseDown: (event: MouseEvent, element: T) => void,
    ): void {
        // Only handle left clicks for dragging/moving
        if (event.button !== 0) return;

        // Check if this is the drag overlay rect (which has its own handler)
        const target = event.target as Element;
        if (target.classList.contains('drag-overlay')) {
            return;
        }

        // If clicked on an info button or inside a foreignObject (like info icons), do not intercept!
        if (
            target.closest('foreignObject') ||
            target.closest('.node-info-button') ||
            target.closest('.connection-info-fo')
        ) {
            return;
        }

        // Find if we clicked on an element wrapper
        const wrapper = target.closest('.element-wrapper');

        if (wrapper) {
            const elementId = wrapper.getAttribute('data-element-id');
            if (elementId) {
                const element = drawnElements.find((e) => e.id === elementId);
                if (element) {
                    onMouseDown(event, element);
                }
            }
        }
    }
}
