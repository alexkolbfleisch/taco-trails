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
    private static isDragging = false;
    private static dragStartPos = { x: 0, y: 0 };
    private static currentDragData: BasicDragData | null = null;

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
    }

    private static simulateDrop(event: MouseEvent) {
        const drawingCanvas = document.querySelector('.drawing-canvas');
        if (!drawingCanvas) {
            delete window.__dragData;
            return;
        }

        const rect = drawingCanvas.getBoundingClientRect();
        const isOverCanvas =
            event.clientX >= rect.left &&
            event.clientX <= rect.right &&
            event.clientY >= rect.top &&
            event.clientY <= rect.bottom;

        if (isOverCanvas && this.currentDragData) {
            const dropEvent = new CustomEvent('customDrop', {
                detail: {
                    ...this.currentDragData,
                    clientX: event.clientX,
                    clientY: event.clientY,
                },
            });
            drawingCanvas.dispatchEvent(dropEvent);
        }

        delete window.__dragData;
    }
}
