import { SHAPE } from '../classes/diagram/diagram-node';
import { DisplayableNode } from '../classes/displayable-graph.interface';

export interface BasicDragData {
    elementType: 'place' | 'transition';
    elementId: string;
    elementLabel: string;
    elementTokens?: number;
}

export interface DragData extends BasicDragData {
    clientX: number;
    clientY: number;
}

declare global {
    interface Window {
        __dragData?: DragData;
    }
}

export class DragDropUtil {
    /**
     * Creates an SVG element depicting a place (circle) or transition (rectangle)
     * suitable for use as a custom drag image.
     *
     * @param type - The Petri net element type to render
     * @param size - The width/height of the SVG in pixels (default 56)
     * @returns The SVG element (not yet attached to the DOM)
     */
    static createSvgDragImage(type: 'place' | 'transition', size = 56): SVGSVGElement {
        const svgNS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(svgNS, 'svg');
        svg.setAttribute('width', size.toString());
        svg.setAttribute('height', size.toString());
        svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
        svg.style.background = 'none';

        if (type === 'place') {
            const circle = document.createElementNS(svgNS, 'circle');
            circle.setAttribute('cx', (size / 2).toString());
            circle.setAttribute('cy', (size / 2).toString());
            circle.setAttribute('r', ((size - 12) / 2).toString());
            circle.setAttribute('fill', '#fff');
            circle.setAttribute('stroke', '#222');
            circle.setAttribute('stroke-width', '2.5');
            svg.appendChild(circle);
        } else {
            const inset = Math.round(size * 0.107);
            const side = size - 2 * inset;
            const rect = document.createElementNS(svgNS, 'rect');
            rect.setAttribute('x', inset.toString());
            rect.setAttribute('y', inset.toString());
            rect.setAttribute('width', side.toString());
            rect.setAttribute('height', side.toString());
            rect.setAttribute('fill', '#fff');
            rect.setAttribute('stroke', '#222');
            rect.setAttribute('stroke-width', '2.5');
            rect.setAttribute('rx', '3');
            svg.appendChild(rect);
        }

        return svg;
    }

    /**
     * Sets a custom SVG drag image on a DragEvent's dataTransfer.
     *
     * Temporarily appends the SVG off-screen so the browser can capture it,
     * then removes it on the next frame.
     *
     * @param event - The dragstart event
     * @param type  - The Petri net element type ('place' or 'transition')
     * @param size  - The width/height of the drag image in pixels (default 56)
     */
    static setPaletteDragImage(event: DragEvent, type: 'place' | 'transition', size = 56): void {
        if (!event.dataTransfer) return;

        const svg = DragDropUtil.createSvgDragImage(type, size);

        // Temporarily attach off-screen so the browser can snapshot it
        svg.style.position = 'absolute';
        svg.style.left = '-9999px';
        document.body.appendChild(svg);

        event.dataTransfer.setDragImage(svg, size / 2, size / 2);

        // Remove after the browser has captured the image
        setTimeout(() => document.body.removeChild(svg), 0);
    }

    private static isDragging = false;
    private static dragStartPos = { x: 0, y: 0 };
    private static currentDragData: BasicDragData | null = null;
    private static ghostElement: HTMLElement | null = null;

    static handleNodeMouseDown(event: MouseEvent, node: DisplayableNode): void {
        if (event.button !== 0) {
            return;
        }

        this.isDragging = false;
        this.dragStartPos = { x: event.clientX, y: event.clientY };

        const elementType: BasicDragData['elementType'] = node.shape === SHAPE.CIRCLE ? 'place' : 'transition';
        const elementId = node.id;
        const elementLabel = node.displayLabel;
        const elementTokens = elementType === 'place' ? node.tokenCount() : undefined;

        const dragData: BasicDragData = {
            elementType,
            elementId,
            elementLabel,
            elementTokens,
        };

        const onMouseMove = (e: MouseEvent) => {
            const dx = e.clientX - this.dragStartPos.x;
            const dy = e.clientY - this.dragStartPos.y;
            if (!this.isDragging && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
                this.isDragging = true;
                this.currentDragData = dragData;
                this.startDrag(e, dragData);
            }

            if (this.isDragging) {
                window.__dragData = {
                    ...dragData,
                    clientX: e.clientX,
                    clientY: e.clientY,
                };
                this.updateGhostPosition(e.clientX, e.clientY);
            }
        };

        const onMouseUp = (e: MouseEvent) => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);

            if (this.isDragging) {
                this.simulateDrop(e);
            }

            this.isDragging = false;
            this.currentDragData = null;
            this.removeGhost();
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);

        event.preventDefault();
        event.stopPropagation();
    }

    private static startDrag(event: MouseEvent, dragData: BasicDragData) {
        window.__dragData = {
            ...dragData,
            clientX: event.clientX,
            clientY: event.clientY,
        };
        this.showGhost(dragData.elementType, event.clientX, event.clientY);
    }

    /**
     * Creates and shows a floating SVG ghost element that follows the cursor
     * during a mouse-based custom drag operation.
     */
    private static showGhost(type: 'place' | 'transition', clientX: number, clientY: number) {
        this.removeGhost();

        const size = 48;
        const svg = DragDropUtil.createSvgDragImage(type, size);

        const wrapper = document.createElement('div');
        wrapper.style.position = 'fixed';
        wrapper.style.pointerEvents = 'none';
        wrapper.style.zIndex = '10000';
        wrapper.style.opacity = '0.75';
        wrapper.style.transform = 'translate(-50%, -50%)';
        wrapper.style.left = `${clientX}px`;
        wrapper.style.top = `${clientY}px`;
        wrapper.appendChild(svg);
        document.body.appendChild(wrapper);

        this.ghostElement = wrapper;
    }

    private static updateGhostPosition(clientX: number, clientY: number) {
        if (this.ghostElement) {
            this.ghostElement.style.left = `${clientX}px`;
            this.ghostElement.style.top = `${clientY}px`;
        }
    }

    private static removeGhost() {
        if (this.ghostElement) {
            this.ghostElement.remove();
            this.ghostElement = null;
        }
    }

    private static simulateDrop(event: MouseEvent) {
        const drawingCanvases = document.querySelectorAll('.drawing-canvas');
        let targetCanvas: Element | null = null;

        for (const canvas of Array.from(drawingCanvases)) {
            const rect = canvas.getBoundingClientRect();

            // First check if the canvas is actually visible (non-zero size)
            if (rect.width > 0 && rect.height > 0) {
                // Then check if the mouse is within the bounding rect of this canvas
                const isOver =
                    event.clientX >= rect.left &&
                    event.clientX <= rect.right &&
                    event.clientY >= rect.top &&
                    event.clientY <= rect.bottom;

                if (isOver) {
                    targetCanvas = canvas;
                    break;
                }
            }
        }

        if (targetCanvas && this.currentDragData) {
            const dropEvent = new CustomEvent('customDrop', {
                detail: {
                    ...this.currentDragData,
                    clientX: event.clientX,
                    clientY: event.clientY,
                },
            });
            targetCanvas.dispatchEvent(dropEvent);
        }

        delete window.__dragData;
    }
}
