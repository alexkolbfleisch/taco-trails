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
    ViewChild,
} from '@angular/core';

import {
    Condition,
    Event as LabeledEvent,
    LabeledNetEdge,
    LabeledNetNode,
} from '../../../../classes/labeled-net.model';
import { DiagramNode } from '../../../../classes/diagram/diagram-node';
import { Diagram } from '../../../../classes/diagram/diagram';
import { DisplayService } from '../../../../services/display.service';
import {
    type PetriNet,
    type TokenTrailConnection,
    type TokenTrailElement,
    type ValidationResult,
    validateTokenTrail,
} from '../../../../services/token-trail-validation.service';
import { ToasterNotificationService } from '../../../../services/toaster-notification.service';
import { PanningService } from '../../../../services/panning.service';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { GRAPH_FILENAMES, GRAPH_IDS, PLACE_RADIUS, TRANSITION_SIZE } from '../../../display/display.constants';
import { TokenTrailStateService } from '../../../../services/token-trail-state.service';
import { Subscription } from 'rxjs';
import {
    DrawToolbarAction,
    DrawToolbarComponent,
    DrawToolbarInstruction,
} from '../../../draw-toolbar/draw-toolbar.component';
import { ImageExportService } from '../../../../services/image-export.service';
import { SourcePetriNetService } from '../../../../services/source-petri-net.service';
import { SvgEventNodeComponent } from '../../../display/svg-event-node/svg-event-node.component';

interface GlobalDragData {
    // Source side still emits place/transition from the base Petri net.
    elementType: 'place' | 'transition';
    elementId: string;
    elementLabel: string;
    elementTokens?: number;
    clientX: number;
    clientY: number;
}

interface LastPhysicalMergeSnapshot {
    anchorConditionId: string;
    drawnElements: LabeledNetNode[];
    connections: LabeledNetEdge[];
    mergedConditionAnchorById: Record<string, string>;
    removedConditionLabels: string[];
}

declare global {
    interface Window {
        __dragData?: GlobalDragData;
    }
}

//TODO: clean this up, this is becoming huge, implement a merging service or something, or handle merging in the state service as well. Remove duplications or put them into a common place.

@Component({
    selector: 'app-token-trail-draw-display',
    standalone: true,
    imports: [
        SvgEventNodeComponent,
        TranslateModule,
        DrawToolbarComponent,
        MatTooltipModule,
        MatButtonModule,
        MatIconModule,
        MatButtonToggleModule,
    ],
    templateUrl: './token-trail-draw-display.html',
    providers: [PanningService],
    styleUrls: ['./token-trail-draw-display.css'],
})
export class TokenTrailDrawDisplayComponent implements OnInit, OnDestroy, AfterViewInit {
    @ViewChild('drawingArea') drawingArea!: ElementRef<SVGGraphicsElement>;
    protected stateService = inject(TokenTrailStateService);

    // Bind to service state
    readonly drawnElements = this.stateService.drawnElements;
    readonly connections = this.stateService.connections;
    readonly isDisabled = computed(() => this.drawnElements().length === 0);

    readonly isDragOver = signal<boolean>(false);
    // Derived lines with coordinates for rendering
    readonly connectionLines = computed(() => {
        return this.connections()
            .map((c) => {
                const a = this.getElementById(c.source);
                const b = this.getElementById(c.target);
                if (!a || !b) return null;

                // Compute trimmed endpoints so the line starts/ends at shape boundaries
                const { x1, y1, x2, y2 } = this.computeTrimmedLine(a, b);
                return { id: c.id, x1, y1, x2, y2, weight: c.weight };
            })
            .filter(
                (v): v is { id: string; x1: number; y1: number; x2: number; y2: number; weight: number } => v !== null,
            );
    });
    // Currently selected element for making a connection (highlighted)
    readonly selectedElementId = signal<string | null>(null);
    private _lastValidationTriggerKey: string | null = null;
    private _lastValidationResult: ValidationResult | null = null;

    readonly validationTriggerKey = computed(() => {
        const sourceNet = this.resolveSourceNetForValidation();
        const sourceKey = sourceNet
            ? `${sourceNet.getNodes().length}:${sourceNet.getEdges().length}:${Object.keys(sourceNet.startMarking || {}).length}`
            : 'no-source';

        const elementKey = this.drawnElements()
            .map((node) => {
                if (node instanceof Condition) {
                    return `C:${node.id}:${node.label ?? node.displayLabel}:${node.isStartPlace ? 1 : 0}`;
                }
                return `E:${node.id}:${node.displayLabel}:${node.transitionId}`;
            })
            .sort()
            .join('|');

        const connectionKey = this.connections()
            .map((connection) => `${connection.source}>${connection.target}:${connection.weight}`)
            .sort()
            .join('|');

        return `${sourceKey}::${elementKey}::${connectionKey}`;
    });

    readonly liveValidation = computed<ValidationResult | null>(() => {
        const triggerKey = this.validationTriggerKey();
        if (this._lastValidationTriggerKey === triggerKey) {
            return this._lastValidationResult;
        }

        const data = this.buildValidationInput();
        this._lastValidationTriggerKey = triggerKey;
        this._lastValidationResult = data ? validateTokenTrail(data.petri, data.elements, data.connections) : null;
        return this._lastValidationResult;
    });

    readonly invalidNodeIds = computed<Set<string>>(() => {
        const result = this.liveValidation();
        if (!result) {
            return new Set<string>();
        }
        const ids = new Set<string>();
        for (const issue of result.issues) {
            for (const eventId of issue.eventIds ?? []) ids.add(eventId);
            for (const conditionId of issue.conditionIds ?? []) ids.add(conditionId);
        }
        return ids;
    });

    readonly invalidConnectionIds = computed<Set<string>>(() => {
        const result = this.liveValidation();
        if (!result) {
            return new Set<string>();
        }
        const ids = new Set<string>();
        for (const issue of result.issues) {
            for (const connectionId of issue.connectionIds ?? []) ids.add(connectionId);
        }
        return ids;
    });

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
        {
            icon: this.getModeToggleIcon(),
            tooltip: this.getModeToggleTooltip(),
            color: 'accent',
            isActive: true, //TODO
            action: () => this.toggleMode(),
        },
        {
            icon: 'refresh',
            tooltip: "TODO",
            color: 'warn',
            isActive: true, //TODO
            action: () => this.createNewLPN(),
        },
    ]);

    private getModeToggleIcon(): string {
        return this.stateService.displayMode() === 'puzzle' ? 'construction' : 'extension';
    }

    private getModeToggleTooltip(): string {
        return this.stateService.displayMode() === 'puzzle'
            ? 'PROCESS_NET.MODE_CONSTRUCTION'
            : 'PROCESS_NET.MODE_PUZZLE';
    }

    private toggleMode(): void {
        const nextMode = this.stateService.displayMode() === 'puzzle' ? 'construction' : 'puzzle';
        this.stateService.setDisplayMode(nextMode);
    }

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

    private draggedElement: Condition | LabeledEvent | null = null;
    private dragOffset = { x: 0, y: 0 };
    private hasDragged = false;
    private svgElement: SVGSVGElement | null = null;
    private isDraggingElement = false;
    private dragStartedMergedAnchorId: string | null = null;
    private elementRef = inject(ElementRef);
    private cdr = inject(ChangeDetectorRef);
    private customDropListener: ((event: Event) => void) | null = null;
    private displayService = inject(DisplayService);
    private toaster = inject(ToasterNotificationService);
    private _imageExportService = inject(ImageExportService);
    private panningService = inject(PanningService);
    private translateService = inject(TranslateService);
    private sourcePetriNetService = inject(SourcePetriNetService);
    private downloadSub?: Subscription;
    private mergeAnimationTimeout?: ReturnType<typeof setTimeout>;
    private lastPhysicalMergeSnapshot = signal<LastPhysicalMergeSnapshot | null>(null);

    private readonly mergedConditionAnchorById = signal<Record<string, string>>({});
    readonly mergeAnimationAnchorId = signal<string | null>(null);

    readonly viewBox = this.panningService.viewBoxAsString;
    readonly viewBoxObj = this.panningService.viewBox;

    private fitViewSubscription?: Subscription;

    // Dimensions for condition/event nodes
    private readonly CONDITION_RADIUS = PLACE_RADIUS;
    private readonly EVENT_HALF_W = TRANSITION_SIZE / 2;
    private readonly EVENT_HALF_H = TRANSITION_SIZE / 2;
    private readonly MERGE_DROP_DISTANCE = this.CONDITION_RADIUS * 1.2;
    private readonly UNMERGE_DRAG_DISTANCE = this.CONDITION_RADIUS * 2;

    private readonly _tokenPreviewEffect = effect(() => {
        const selectedPlaceId = this.stateService.selectedPetriPlaceId();

        let hasChanges = false;
        for (const node of this.drawnElements()) {
            if (!(node instanceof Condition)) {
                continue;
            }
            const desiredTokens = selectedPlaceId ? node.getTrailTokens(selectedPlaceId) : 0;
            const desiredHideTokens = !selectedPlaceId;
            if (node.tokenCount() !== desiredTokens || node.hideTokens !== desiredHideTokens) {
                hasChanges = true;
                break;
            }
        }

        if (!hasChanges) {
            return;
        }

        // We update the view to visually reflect the tokens for the selected Petri-Net place.
        this.stateService.updateDrawnElements((elements) =>
            elements.map((node) => {
                if (!(node instanceof Condition)) {
                    return node;
                }

                const updated = this.stateService.buildCondition(node.id, node.label ?? node.displayLabel, 0, {
                    hideTokens: !selectedPlaceId,
                    labelPlacement: node.labelPlacement,
                    isStartPlace: node.isStartPlace,
                    baseName: node.baseName,
                });
                updated.x = node.x;
                updated.y = node.y;
                updated.baseName = node.baseName ?? node.label ?? node.displayLabel;
                updated.trailMarkings = { ...node.trailMarkings };
                updated.tokens = selectedPlaceId ? node.getTrailTokens(selectedPlaceId) : 0;

                updated.updateDynamicLabel(); // Always compute the correct string based on trailMarkings first

                return updated;
            }),
        );
    });

    private readonly _validPlacesEffect = effect(() => {
        const result = this.liveValidation();
        if (!result?.perPlaceResults) {
            this.stateService.setValidPetriPlaceIds(new Set<string>());
            return;
        }

        const validPlaces = new Set<string>();
        for (const [placeId, placeResult] of Object.entries(result.perPlaceResults)) {
            if (placeResult.valid) {
                validPlaces.add(placeId);
            }
        }
        this.stateService.setValidPetriPlaceIds(validPlaces);
    });

    ngOnInit() {
        // Listen for custom drop events
        const canvas = this.elementRef.nativeElement.querySelector('.drawing-canvas');
        if (canvas) {
            this.customDropListener = (event: Event) => {
                this.handleCustomDrop(event as CustomEvent);
            };
            canvas.addEventListener('customDrop', this.customDropListener);

            // Add mousedown listener with capture phase to intercept before child elements
            canvas.addEventListener('mousedown', this.handleCanvasMouseDown, true);
        }

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
                getNodes: () => this.drawnElements(),
                getEdges: () => [],
            });
        });
    }

    ngAfterViewInit() {
        this.svgElement = (this.drawingArea?.nativeElement as SVGSVGElement) ?? null;
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
        if (this.mergeAnimationTimeout) {
            clearTimeout(this.mergeAnimationTimeout);
            this.mergeAnimationTimeout = undefined;
        }
    }

    private handleCanvasMouseDown = (event: MouseEvent) => {
        // Only handle left clicks for dragging/moving
        if (event.button !== 0) return;

        // Check if this is the drag overlay rect (which has its own handler)
        const target = event.target as Element;
        if (target.classList.contains('drag-overlay')) {
            return;
        }

        // Find if we clicked on an element wrapper
        const wrapper = target.closest('.element-wrapper');

        if (wrapper) {
            const elementId = wrapper.getAttribute('data-element-id');
            if (elementId) {
                const element = this.drawnElements().find((e) => e.id === elementId);
                if (element) {
                    this.onElementMouseDown(event, element);
                }
            }
        }
    };

    private handleCustomDrop(event: CustomEvent) {
        if (this.stateService.displayMode() === 'puzzle') return;
        const detail = event.detail;
        if (!detail) {
            return;
        }

        const svgPoint = this.getSvgCoordinatesFromClient(detail.clientX, detail.clientY);
        if (!svgPoint) {
            return;
        }

        let newNode: LabeledNetNode;
        // Always create a unique ID for the drawing area, based on the source element
        // Use service to generate ID
        const uniqueId = this.stateService.generateElementId(`drawn-${detail.elementId}`);
        const elementLabel = detail.elementLabel || detail.elementId;
        const elementTokens = detail.elementTokens ?? 0;

        const isSourceCondition = detail.elementType === 'place';
        const isSourceEvent = detail.elementType === 'transition';

        if (isSourceCondition) {
            newNode = this.stateService.buildCondition(uniqueId, detail.elementId, elementTokens, {
                isStartPlace: this.shouldMarkAsStartCondition(detail.elementId),
                innerLabel: detail.elementId,
            });
            // Im Konstruktionsmodus erhält die neue Condition direkt das Trail Marking der gezogenen Stelle:
            (newNode as Condition).trailMarkings = { [detail.elementId]: 1 };
            (newNode as Condition).updateDynamicLabel();
        } else if (isSourceEvent) {
            newNode = this.stateService.buildEvent(uniqueId, elementLabel, elementLabel);
        } else {
            return;
        }

        newNode.x = svgPoint.x;
        newNode.y = svgPoint.y;

        this.stateService.addDrawnElement(newNode);
    }

    onDragOver(event: DragEvent) {
        event.preventDefault();
        if (event.dataTransfer) {
            event.dataTransfer.dropEffect = 'copy';
        }
        this.isDragOver.set(true);
    }

    onDragLeave() {
        this.isDragOver.set(false);
    }

    onDrop(event: DragEvent) {
        if (this.stateService.displayMode() === 'puzzle') return;
        event.preventDefault();
        this.isDragOver.set(false);

        // Check for drag data from the global window object (custom drag)
        const dragData = window.__dragData;
        if (dragData) {
            const svgPoint = this.getSvgCoordinates(event);
            if (!svgPoint) {
                return;
            }

            let newNode: LabeledNetNode;
            // Always create a unique ID for the drawing area
            const uniqueId = this.stateService.generateElementId(`drawn-${dragData.elementId || 'element'}`);
            const elementLabel = dragData.elementLabel || dragData.elementId;
            const elementTokens = dragData.elementTokens ?? 0;

            const isSourceCondition = dragData.elementType === 'place';
            const isSourceEvent = dragData.elementType === 'transition';

            if (isSourceCondition) {
                newNode = this.stateService.buildCondition(uniqueId, dragData.elementId, elementTokens, {
                    isStartPlace: this.shouldMarkAsStartCondition(dragData.elementId),
                    innerLabel: dragData.elementId,
                });
                // Initiales Trail Marking für die Source-Stelle setzen:
                (newNode as Condition).trailMarkings = { [dragData.elementId]: 1 };
                (newNode as Condition).updateDynamicLabel();
            } else if (isSourceEvent) {
                newNode = this.stateService.buildEvent(uniqueId, elementLabel, elementLabel);
            } else {
                return;
            }

            newNode.x = svgPoint.x;
            newNode.y = svgPoint.y;

            this.stateService.addDrawnElement(newNode);

            // Clear the global drag data
            delete window.__dragData;
            return;
        }

        // Fallback to standard drag and drop (for files, etc.)
        const elementType = event.dataTransfer?.getData('element-type');
        if (!elementType) {
            return;
        }

        const svgPoint = this.getSvgCoordinates(event);
        if (!svgPoint) {
            return;
        }

        let newNode: LabeledNetNode;
        const uniqueId = this.stateService.generateElementId('drawn-element');

        const isSourceCondition = elementType === 'place';
        const isSourceEvent = elementType === 'transition';

        if (isSourceCondition) {
            newNode = this.stateService.buildCondition(uniqueId, undefined, 0);
        } else if (isSourceEvent) {
            newNode = this.stateService.buildEvent(uniqueId, uniqueId, uniqueId);
        } else {
            return;
        }

        newNode.x = svgPoint.x;
        newNode.y = svgPoint.y;

        this.stateService.addDrawnElement(newNode);
    }

    onElementMouseDown(event: MouseEvent, element: LabeledNetNode) {
        // Shift + Left Click for Debugging
        if (event.shiftKey && event.button === 0) {
            console.log('Condition Properties Debug:', element);
            if (element instanceof Condition) {
                console.log('Trail Markings:', element.trailMarkings);
            }
            event.stopImmediatePropagation();
            event.preventDefault();
            return;
        }

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
        this.hasDragged = false;
        this.draggedElement = element;
        this.dragStartedMergedAnchorId =
            element instanceof Condition ? this.getMergedConditionAnchorIdOrNull(element.id) : null;

        const svgPoint = this.getSvgCoordinates(event);
        if (svgPoint) {
            this.dragOffset.x = svgPoint.x - element.x;
            this.dragOffset.y = svgPoint.y - element.y;
        }

        document.addEventListener('mousemove', this.onDocumentMouseMove, true);
        document.addEventListener('mouseup', this.onDocumentMouseUp, true);
    }

    onElementRightClick(event: MouseEvent, element: LabeledNetNode) {
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

        const sourceNode = this.drawnElements().find((e) => e.id === currentSelectedId);
        const targetNode = element;
        if (!sourceNode) {
            // Safety: reset selection
            this.selectedElementId.set(null);
            return;
        }

        // Only connect if exactly one is condition and one is event.
        if (!this.isValidConditionEventPair(sourceNode, targetNode)) {
            // If types don't match, replace selection with the newly clicked element
            this.selectedElementId.set(element.id);
            return;
        }

        // Keep opposite direction; only deduplicate same direction.
        if (!this.hasExactConnectionDirection(sourceNode.id, targetNode.id)) {
            this.stateService.addConnection({
                id: this.stateService.generateConnectionId('conn'),
                source: sourceNode.id,
                target: targetNode.id,
                weight: 1,
                bendPoints: [],
                displayLabel: '',
            });
        }

        // Clear selection after connect attempt.
        this.selectedElementId.set(null);
    }

    onElementDoubleClick(event: MouseEvent, element: LabeledNetNode) {
        event.preventDefault();
        event.stopImmediatePropagation();

        if (!(element instanceof Condition)) {
            return;
        }

        const anchorConditionId = this.resolveConditionAnchorId(element.id);

        // If it's a visual merge group (size > 1), double tap to FINALIZE it
        if (this.getConditionGroupSize(anchorConditionId) > 1) {
            this.finalizeMergedConditionGroup(anchorConditionId);
            return;
        }

        // If it's already a finalized merged condition (size === 1) and the label has a '+' sign or multiplier, UNMERGE it
        const displayLabel = element.label ?? element.displayLabel;
        if (displayLabel.includes('+') || /^\d+\*/.test(displayLabel)) {
            this.unmergeConditionGroup(anchorConditionId);
            return;
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
        if (this.isDraggingElement) return;
        const target = event.target as Element | null;
        const isOnElement = target?.closest('.element-wrapper') || target?.classList.contains('drag-overlay');
        if (isOnElement) {
            return;
        }
        this.panningService.startPan(event, this.drawingArea);
    }

    onCanvasPan(event: MouseEvent) {
        if (this.isDraggingElement) return;
        this.panningService.pan(event, this.drawingArea);
    }

    onCanvasPanEnd() {
        this.panningService.endPan(this.drawingArea);
    }

    onCanvasWheel(event: WheelEvent) {
        this.panningService.zoom(event, this.drawingArea);
    }

    private onDocumentMouseMove = (event: MouseEvent) => {
        if (!this.draggedElement || !this.isDraggingElement) {
            return;
        }

        event.preventDefault();
        event.stopImmediatePropagation();

        const svgPoint = this.getSvgCoordinates(event);
        if (svgPoint) {
            const newX = svgPoint.x - this.dragOffset.x;
            const newY = svgPoint.y - this.dragOffset.y;

            // Mark that we dragged
            if (Math.abs(newX - this.draggedElement.x) > 2 || Math.abs(newY - this.draggedElement.y) > 2) {
                this.hasDragged = true;
            }

            let updatedElement: LabeledNetNode | null = null;
            this.stateService.updateDrawnElements((elements) =>
                elements.map((el) => {
                    if (el.id !== this.draggedElement?.id) return el;

                    // Recreate node instance to trigger SvgNodeComponent re-render
                    let newNode: LabeledNetNode;
                    if (el instanceof Condition) {
                        const tokens = el.tokenCount() ?? 0;
                        const originalLabel = el.label ?? el.displayLabel;
                        newNode = this.stateService.buildCondition(el.id, originalLabel, tokens, {
                            hideTokens: el.hideTokens,
                            isStartPlace: el.isStartPlace,
                            baseName: el.baseName,
                        });
                        newNode.trailMarkings = { ...el.trailMarkings };
                        newNode.baseName = el.baseName;
                    } else {
                        newNode = this.stateService.buildEvent(el.id, el.displayLabel, el.transitionId);
                    }
                    newNode.x = newX;
                    newNode.y = newY;

                    updatedElement = newNode;
                    return newNode;
                }),
            );

            if (updatedElement) {
                this.draggedElement = updatedElement;
            }

            // Force Angular to detect the changes just in case
            this.cdr.detectChanges();

            if (this.draggedElement instanceof Condition && this.dragStartedMergedAnchorId) {
                const anchor = this.getElementById(this.dragStartedMergedAnchorId);
                if (anchor instanceof Condition) {
                    const distanceToAnchor = Math.hypot(
                        this.draggedElement.x - anchor.x,
                        this.draggedElement.y - anchor.y,
                    );
                    if (distanceToAnchor > this.UNMERGE_DRAG_DISTANCE) {
                        this.unmergeCondition(this.draggedElement.id);
                        this.dragStartedMergedAnchorId = null;
                    }
                }
            }
        }
    };

    private onDocumentMouseUp = (event: MouseEvent) => {
        const releasedElement = this.draggedElement;

        if (this.isDraggingElement) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }

        if (releasedElement instanceof Condition && this.hasDragged) {
            this.tryMergeConditionOnDrop(releasedElement);
        }

        this.draggedElement = null;
        this.isDraggingElement = false;
        this.hasDragged = false;
        this.dragStartedMergedAnchorId = null;
        document.removeEventListener('mousemove', this.onDocumentMouseMove, true);
        document.removeEventListener('mouseup', this.onDocumentMouseUp, true);
    };

    onElementWheel(event: WheelEvent, element: LabeledNetNode) {
        if (this.stateService.displayMode() !== 'puzzle' || !(element instanceof Condition)) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();

        // Scroll up = positive token delta, scroll down = negative
        const delta = event.deltaY < 0 ? 1 : -1;
        this.handleConditionTokenDelta(element, delta);
    }

    private getSvgCoordinates(event: MouseEvent | DragEvent): { x: number; y: number } | null {
        return this.getSvgCoordinatesFromClient(event.clientX, event.clientY);
    }

    private handleConditionTokenDelta(condition: Condition, delta: number) {
        const selectedPlaceId = this.stateService.selectedPetriPlaceId();
        if (!selectedPlaceId) {
            return;
        }

        this.stateService.updateDrawnElements((elements) =>
            elements.map((node) => {
                if (node.id === condition.id && node instanceof Condition) {
                    const originalLabel = node.label ?? node.displayLabel;
                    const updated = this.stateService.buildCondition(node.id, originalLabel, 0, {
                        hideTokens: node.hideTokens,
                        isStartPlace: node.isStartPlace,
                        labelPlacement: node.labelPlacement,
                        baseName: node.baseName,
                    });
                    updated.x = node.x;
                    updated.y = node.y;
                    // Ensure the base name stays exactly as is, and we preserve it
                    updated.baseName = node.baseName ?? originalLabel;
                    updated.trailMarkings = { ...node.trailMarkings };

                    const currentTokens = updated.getTrailTokens(selectedPlaceId);
                    const nextTokens = Math.max(0, currentTokens + delta);

                    // We directly mutate the inner map without triggering updateDynamicLabel()
                    // because we are in puzzle mode and want to keep the base label ("c1" etc.)
                    if (nextTokens > 0) {
                        updated.trailMarkings[selectedPlaceId] = nextTokens;
                    } else {
                        delete updated.trailMarkings[selectedPlaceId];
                    }

                    // Call updateDynamicLabel to properly reflect dynamic data correctly even if currently hidden
                    updated.updateDynamicLabel();

                    // Visually update the UI right away
                    updated.tokens = updated.getTrailTokens(selectedPlaceId);

                    return updated;
                }
                return node;
            }),
        );
    }

    private getSvgCoordinatesFromClient(clientX: number, clientY: number): { x: number; y: number } | null {
        if (!this.svgElement) {
            this.svgElement =
                (this.drawingArea?.nativeElement as SVGSVGElement) ??
                ((document.querySelector('.drawing-canvas') as SVGSVGElement) || null);
        }

        if (!this.svgElement) {
            return null;
        }

        const point = this.svgElement.createSVGPoint();
        point.x = clientX;
        point.y = clientY;

        const ctm = this.svgElement.getScreenCTM();
        if (!ctm) {
            return null;
        }

        const svgPoint = point.matrixTransform(ctm.inverse());
        return { x: svgPoint.x, y: svgPoint.y };
    }

    // Compute trimmed line from center of a to center of b, shortened by shape radii/half-sizes
    private computeTrimmedLine(
        a: LabeledNetNode,
        b: LabeledNetNode,
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

        const aOffset = a instanceof Condition ? this.CONDITION_RADIUS : Math.min(this.EVENT_HALF_W, this.EVENT_HALF_H);
        const bOffset = b instanceof Condition ? this.CONDITION_RADIUS : Math.min(this.EVENT_HALF_W, this.EVENT_HALF_H);

        const x1 = ax + ux * aOffset;
        const y1 = ay + uy * aOffset;
        const x2 = bx - ux * bOffset;
        const y2 = by - uy * bOffset;
        return { x1, y1, x2, y2 };
    }

    clearDrawing() {
        this.selectedElementId.set(null);
        this.mergedConditionAnchorById.set({});
        this.lastPhysicalMergeSnapshot.set(null);
        this.mergeAnimationAnchorId.set(null);
        if (this.mergeAnimationTimeout) {
            clearTimeout(this.mergeAnimationTimeout);
            this.mergeAnimationTimeout = undefined;
        }

        const diagram = this.displayService.diagram;
        if (diagram instanceof Diagram) {
            diagram.resetMarking();
        }

        this.stateService.clear();
    }

    deleteElement(element: LabeledNetNode) {
        if (element instanceof Condition) {
            const lastSnapshot = this.lastPhysicalMergeSnapshot();
            if (lastSnapshot && lastSnapshot.anchorConditionId === element.id) {
                this.commitLastPhysicalMergeSnapshot();
            }
            this.removeConditionFromMergeGraph(element.id);
            this.stateService.releaseConditionName(element.baseName ?? element.label ?? element.displayLabel);
        }
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

    isNodeInvalid(elementId: string): boolean {
        return this.invalidNodeIds().has(elementId);
    }

    isConnectionInvalid(connectionId: string): boolean {
        return this.invalidConnectionIds().has(connectionId);
    }

    getElementTooltip(elementId: string): string {
        const result = this.liveValidation();
        if (!result) {
            return '';
        }

        const messages = result.issues
            .filter(
                (issue) => (issue.eventIds ?? []).includes(elementId) || (issue.conditionIds ?? []).includes(elementId),
            )
            .map((issue) => {
                const translated = this.translateService.instant(issue.messageKey, issue.messageParams ?? {});
                return `[${issue.rule}] ${translated}`;
            });

        return messages.join('\n');
    }

    getConnectionTooltip(connectionId: string): string {
        const result = this.liveValidation();
        if (!result) {
            return '';
        }

        const messages = result.issues
            .filter((issue) => (issue.connectionIds ?? []).includes(connectionId))
            .map((issue) => {
                const translated = this.translateService.instant(issue.messageKey, issue.messageParams ?? {});
                return `[${issue.rule}] ${translated}`;
            });

        return messages.join('\n');
    }

    //TODO: implement actual validation logic and show results in a user-friendly way (e.g. list of errors and infos with translations)
    //maybe we will replace this with a more direct way of giving feedback on specific elements (e.g. red border on invalid elements with tooltip explanations) instead of a separate validation step and toast
    onValidate() {
        const data = this.buildValidationInput();
        if (!data) {
            this.toaster.showError('TOASTER.HEADER.VALIDATION', 'TOASTER.BODY.VALIDATION_ERROR', {
                duration: 0,
            });

            return;
        }
        validateTokenTrail(data.petri, data.elements, data.connections);
        //TODO: show validation results in a user-friendly way (e.g. list of errors and infos with translations)
    }

    private resolveSourceNetForValidation(): Diagram | null {
        const sourceNet = this.sourcePetriNetService.getCurrentSourceNet();
        if (sourceNet instanceof Diagram) {
            return sourceNet;
        }

        const displayed = this.displayService.diagram;
        return displayed instanceof Diagram ? displayed : null;
    }

    private buildValidationInput(): {
        petri: PetriNet;
        elements: TokenTrailElement[];
        connections: TokenTrailConnection[];
    } | null {
        const base = this.resolveSourceNetForValidation() ?? undefined;
        if (!base) {
            return null;
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

        const elements: TokenTrailElement[] = this.drawnElements().map((el) => {
            const isCondition = el instanceof Condition;
            const isEvent = el instanceof LabeledEvent;
            return {
                id: el.id,
                type: isCondition ? 'Condition' : isEvent ? 'Event' : 'Condition',
                label: isCondition ? (el.innerLabel ?? el.displayLabel) : el.displayLabel,
                isStartCondition: isCondition ? el.isStartPlace : undefined,
                marking: isCondition ? el.tokenCount() : undefined,
            };
        });

        const connections: TokenTrailConnection[] = this.connections().map((c) => ({
            id: c.id,
            from: c.source,
            to: c.target,
            weight: c.weight,
        }));

        const startConditions = this.drawnElements()
            .filter((el): el is Condition => el instanceof Condition && el.isStartPlace)
            .map((el) => el.label ?? el.displayLabel);

        return {
            petri: {
                ...petri,
                startPlaces: startConditions,
                focusPlaceId: this.stateService.selectedPetriPlaceId() ?? undefined,
            },
            elements,
            connections,
        };
    }

    private isValidConditionEventPair(sourceNode: LabeledNetNode, targetNode: LabeledNetNode): boolean {
        return this.isCondition(sourceNode) !== this.isCondition(targetNode);
    }

    private hasExactConnectionDirection(sourceId: string, targetId: string): boolean {
        return this.connections().some(
            (connection) => connection.source === sourceId && connection.target === targetId,
        );
    }

    private finalizeMergedConditionGroup(anchorConditionId: string) {
        const groupMemberIds = this.getConditionGroupMembers(anchorConditionId);
        const removedConditionIds = groupMemberIds.filter((id) => id !== anchorConditionId);
        if (removedConditionIds.length === 0) {
            return;
        }

        const allMemberNodes = groupMemberIds
            .map((id) => this.getElementById(id))
            .filter((node): node is Condition => node instanceof Condition);

        // Immediate release of ALL member base names to generate the optimal lowest available one
        allMemberNodes.forEach((node) => {
            if (node.baseName) {
                this.stateService.releaseConditionName(node.baseName);
            }
        });
        const newMergedBaseName = this.stateService.generateConditionName();

        // Only the most recent physical merge is reversible.
        this.commitLastPhysicalMergeSnapshot();
        this.lastPhysicalMergeSnapshot.set({
            anchorConditionId,
            drawnElements: this.cloneDrawnElements(this.drawnElements()),
            connections: this.cloneConnections(this.connections()),
            mergedConditionAnchorById: { ...this.mergedConditionAnchorById() },
            removedConditionLabels: [], // Immediately released, so nothing queued
        });

        const removedConditionIdSet = new Set(removedConditionIds);

        // Update the anchor condition with the merged label and trail markings
        const mergedLabel = this.computeMergedLabel(groupMemberIds);

        // Sum trail markings across all members
        const combinedTrailMarkings: Record<string, number> = {};
        for (const memberNode of allMemberNodes) {
            for (const [place, count] of Object.entries(memberNode.trailMarkings)) {
                combinedTrailMarkings[place] = (combinedTrailMarkings[place] ?? 0) + count;
            }
        }

        this.stateService.updateDrawnElements((elements) =>
            elements
                .map((node) => {
                    if (node.id === anchorConditionId && node instanceof Condition) {
                        const updated = this.stateService.buildCondition(node.id, mergedLabel, node.tokenCount(), {
                            hideTokens: node.hideTokens,
                            isStartPlace: node.isStartPlace,
                            labelPlacement: node.labelPlacement,
                            baseName: newMergedBaseName,
                        });
                        updated.trailMarkings = combinedTrailMarkings;
                        updated.updateDynamicLabel();
                        updated.x = node.x;
                        updated.y = node.y;
                        return updated;
                    }
                    return node;
                })
                .filter((node) => !removedConditionIdSet.has(node.id)),
        );

        this.stateService.updateConnections((connections) => {
            const remapped = connections
                .map((connection) => {
                    const mappedSource = removedConditionIdSet.has(connection.source)
                        ? anchorConditionId
                        : connection.source;
                    const mappedTarget = removedConditionIdSet.has(connection.target)
                        ? anchorConditionId
                        : connection.target;
                    return {
                        ...connection,
                        source: mappedSource,
                        target: mappedTarget,
                    };
                })
                .filter(
                    (connection) =>
                        !(connection.source === anchorConditionId && connection.target === anchorConditionId),
                );

            const uniqueByDirection = new Map<string, (typeof remapped)[number]>();
            for (const connection of remapped) {
                const key = `${connection.source}->${connection.target}`;
                if (!uniqueByDirection.has(key)) {
                    uniqueByDirection.set(key, connection);
                }
            }
            return Array.from(uniqueByDirection.values());
        });

        this.mergedConditionAnchorById.update((currentMap) => {
            const nextMap = { ...currentMap };
            for (const removedId of removedConditionIds) {
                delete nextMap[removedId];
            }
            delete nextMap[anchorConditionId];

            for (const [conditionId, mappedAnchorId] of Object.entries(nextMap)) {
                if (removedConditionIdSet.has(mappedAnchorId)) {
                    delete nextMap[conditionId];
                }
            }

            return nextMap;
        });

        if (this.selectedElementId() && removedConditionIdSet.has(this.selectedElementId()!)) {
            this.selectedElementId.set(null);
        }

        this.playMergeAnimation(anchorConditionId);
    }

    private unmergeConditionGroup(anchorConditionId: string) {
        const anchorNode = this.getElementById(anchorConditionId);
        if (!(anchorNode instanceof Condition)) {
            return;
        }

        const mergedLabel = anchorNode.label ?? anchorNode.displayLabel;
        const parsedLabels = this.parseMergedLabel(mergedLabel);

        if (parsedLabels.length <= 1) {
            return;
        }

        // Release the anchor's base name so its pieces can optimally reuse it (e.g. c1)
        if (anchorNode.baseName) {
            this.stateService.releaseConditionName(anchorNode.baseName);
        }

        const newIds: string[] = [];

        this.stateService.updateDrawnElements((elements) => {
            const updated = elements.filter((n) => n.id !== anchorConditionId);

            // Add back the anchor with the first label
            const firstClone = this.stateService.buildCondition(
                anchorConditionId,
                parsedLabels[0],
                anchorNode.tokenCount(),
                {
                    hideTokens: anchorNode.hideTokens,
                    isStartPlace: this.shouldMarkAsStartCondition(parsedLabels[0]),
                    labelPlacement: anchorNode.labelPlacement,
                },
            );
            firstClone.trailMarkings = { [parsedLabels[0]]: 1 };
            firstClone.updateDynamicLabel();
            firstClone.x = anchorNode.x;
            firstClone.y = anchorNode.y;
            updated.push(firstClone);
            newIds.push(anchorConditionId);

            // Add the rest
            const otherLabels = parsedLabels.slice(1);
            otherLabels.forEach((label, index) => {
                const angle = ((index + 1) / otherLabels.length) * 2 * Math.PI;
                const radius = 80;
                const newX = anchorNode.x + Math.cos(angle) * radius;
                const newY = anchorNode.y + Math.sin(angle) * radius;

                const newId = this.stateService.generateElementId(`drawn-${label}`);
                const clone = this.stateService.buildCondition(newId, label, 0, {
                    hideTokens: anchorNode.hideTokens,
                    isStartPlace: this.shouldMarkAsStartCondition(label),
                    labelPlacement: anchorNode.labelPlacement,
                });
                clone.trailMarkings = { [label]: 1 };
                clone.updateDynamicLabel();
                clone.x = newX;
                clone.y = newY;
                updated.push(clone);
                newIds.push(newId);
            });

            return updated;
        });

        // Duplicate connections for all unmerged conditions
        this.stateService.updateConnections((connections) => {
            const newConnections: LabeledNetEdge[] = [];

            for (const conn of connections) {
                if (conn.source === anchorConditionId) {
                    for (let i = 1; i < newIds.length; i++) {
                        const newConnId = this.stateService.generateConnectionId('conn');
                        const newConn = {
                            id: newConnId,
                            source: newIds[i],
                            target: conn.target,
                            weight: conn.weight,
                            bendPoints: [],
                            displayLabel: conn.displayLabel,
                        };
                        newConnections.push(newConn as LabeledNetEdge);
                    }
                }

                if (conn.target === anchorConditionId) {
                    for (let i = 1; i < newIds.length; i++) {
                        const newConnId = this.stateService.generateConnectionId('conn');
                        const newConn = {
                            id: newConnId,
                            source: conn.source,
                            target: newIds[i],
                            weight: conn.weight,
                            bendPoints: [],
                            displayLabel: conn.displayLabel,
                        };
                        newConnections.push(newConn as LabeledNetEdge);
                    }
                }
            }
            return [...connections, ...newConnections];
        });

        this.playMergeAnimation(anchorConditionId);
    }

    private parseMergedLabel(label: string): string[] {
        // Parse a merged label like "p1 + 2*p2" into individual labels
        const result: string[] = [];
        const parts = label.split(' + ').map((p) => p.trim());

        for (const part of parts) {
            // Parse multipliers like "2*p1" or single labels like "p1"
            const match = part.match(/^(\d+)\*(.+)$|^(.+)$/);
            if (match) {
                const multiplier = match[1] ? parseInt(match[1], 10) : 1;
                const singleLabel = match[2] || match[3];
                for (let i = 0; i < multiplier; i++) {
                    result.push(singleLabel);
                }
            }
        }

        return result;
    }

    isMergeAnchor(node: LabeledNetNode): boolean {
        return node instanceof Condition && this.getConditionGroupSize(node.id) > 1;
    }

    isMergeAnimating(node: LabeledNetNode): boolean {
        return node instanceof Condition && this.mergeAnimationAnchorId() === node.id;
    }

    getConditionGroupSize(conditionId: string): number {
        const anchorId = this.resolveConditionAnchorId(conditionId);
        return this.drawnElements().filter(
            (node) => node instanceof Condition && this.resolveConditionAnchorId(node.id) === anchorId,
        ).length;
    }

    private tryMergeConditionOnDrop(condition: Condition) {
        const mergeTarget = this.findConditionMergeTarget(condition);
        if (!mergeTarget) {
            return;
        }
        this.mergeConditions(condition.id, mergeTarget.id);
    }

    private findConditionMergeTarget(movingCondition: Condition): Condition | null {
        const movingAnchorId = this.resolveConditionAnchorId(movingCondition.id);
        let nearest: { node: Condition; distance: number } | null = null;

        for (const node of this.drawnElements()) {
            if (!(node instanceof Condition) || node.id === movingCondition.id) {
                continue;
            }

            if (this.resolveConditionAnchorId(node.id) === movingAnchorId) {
                continue;
            }

            const distance = Math.hypot(movingCondition.x - node.x, movingCondition.y - node.y);
            if (distance > this.MERGE_DROP_DISTANCE) {
                continue;
            }

            if (!nearest || distance < nearest.distance) {
                nearest = { node, distance };
            }
        }

        return nearest?.node ?? null;
    }

    private mergeConditions(sourceConditionId: string, targetConditionId: string) {
        const sourceAnchorId = this.resolveConditionAnchorId(sourceConditionId);
        const targetAnchorId = this.resolveConditionAnchorId(targetConditionId);
        if (sourceAnchorId === targetAnchorId) {
            return;
        }

        const sourceGroupMembers = this.getConditionGroupMembers(sourceAnchorId);
        this.mergedConditionAnchorById.update((currentMap) => {
            const nextMap = { ...currentMap };
            for (const memberId of sourceGroupMembers) {
                if (memberId !== targetAnchorId) {
                    nextMap[memberId] = targetAnchorId;
                }
            }
            delete nextMap[targetAnchorId];
            return nextMap;
        });

        this.animateMergedConditionsTowardsAnchor(targetAnchorId);
        this.playMergeAnimation(targetAnchorId);
    }

    private unmergeCondition(conditionId: string) {
        this.mergedConditionAnchorById.update((currentMap) => {
            if (!currentMap[conditionId]) {
                return currentMap;
            }
            const nextMap = { ...currentMap };
            delete nextMap[conditionId];
            return nextMap;
        });
    }

    private removeConditionFromMergeGraph(conditionId: string) {
        this.mergedConditionAnchorById.update((currentMap) => {
            const nextMap = { ...currentMap };

            if (nextMap[conditionId]) {
                delete nextMap[conditionId];
                return nextMap;
            }

            const mergedChildren = Object.entries(nextMap)
                .filter(([, anchorId]) => anchorId === conditionId)
                .map(([id]) => id);

            if (mergedChildren.length === 0) {
                return nextMap;
            }

            const [newAnchorId, ...otherChildren] = mergedChildren;
            delete nextMap[newAnchorId];
            for (const childId of otherChildren) {
                nextMap[childId] = newAnchorId;
            }

            return nextMap;
        });
    }

    private animateMergedConditionsTowardsAnchor(anchorConditionId: string) {
        const anchorNode = this.getElementById(anchorConditionId);
        if (!(anchorNode instanceof Condition)) {
            return;
        }

        const members = this.getConditionGroupMembers(anchorConditionId).filter((id) => id !== anchorConditionId);
        if (members.length === 0) {
            return;
        }

        const placementRadius = Math.max(12, this.CONDITION_RADIUS * 0.9);
        members.forEach((memberId, index) => {
            const angle = (index / members.length) * 2 * Math.PI;
            const targetX = anchorNode.x + Math.cos(angle) * placementRadius;
            const targetY = anchorNode.y + Math.sin(angle) * placementRadius;
            this.animateConditionPosition(memberId, targetX, targetY, 180);
        });
    }

    private animateConditionPosition(conditionId: string, targetX: number, targetY: number, durationMs: number) {
        const conditionNode = this.getElementById(conditionId);
        if (!(conditionNode instanceof Condition)) {
            return;
        }

        const startX = conditionNode.x;
        const startY = conditionNode.y;
        const startTime = performance.now();

        const step = (now: number) => {
            const progress = Math.min(1, (now - startTime) / durationMs);
            const eased = 1 - Math.pow(1 - progress, 3);
            const nextX = startX + (targetX - startX) * eased;
            const nextY = startY + (targetY - startY) * eased;

            this.stateService.updateDrawnElements((elements) =>
                elements.map((node) => {
                    if (node.id !== conditionId || !(node instanceof Condition)) {
                        return node;
                    }
                    const updated = this.stateService.buildCondition(
                        node.id,
                        node.label ?? node.displayLabel,
                        node.tokenCount(),
                        {
                            hideTokens: node.hideTokens,
                            isStartPlace: node.isStartPlace,
                            baseName: node.baseName,
                        },
                    );
                    updated.trailMarkings = { ...node.trailMarkings };
                    updated.x = nextX;
                    updated.y = nextY;
                    return updated;
                }),
            );

            if (progress < 1) {
                requestAnimationFrame(step);
            }
        };

        requestAnimationFrame(step);
    }

    private playMergeAnimation(anchorConditionId: string) {
        this.mergeAnimationAnchorId.set(anchorConditionId);
        if (this.mergeAnimationTimeout) {
            clearTimeout(this.mergeAnimationTimeout);
        }
        this.mergeAnimationTimeout = setTimeout(() => {
            if (this.mergeAnimationAnchorId() === anchorConditionId) {
                this.mergeAnimationAnchorId.set(null);
            }
        }, 220);
    }

    private getConditionGroupMembers(anchorId: string): string[] {
        return this.drawnElements()
            .filter((node): node is Condition => node instanceof Condition)
            .filter((condition) => this.resolveConditionAnchorId(condition.id) === anchorId)
            .map((condition) => condition.id);
    }

    private computeMergedLabel(groupMemberIds: string[]): string {
        // Get all labels from the group members, parsing existing multipliers
        const labelCounts = new Map<string, number>();

        for (const id of groupMemberIds) {
            const node = this.getElementById(id);
            if (!(node instanceof Condition)) continue;

            // Since trailMarkings correctly hold all specific markings now,
            // the merged label is best generated dynamically from merged trail markings
            for (const [place, count] of Object.entries(node.trailMarkings)) {
                labelCounts.set(place, (labelCounts.get(place) ?? 0) + count);
            }
        }

        // Build the merged label with counts and plus signs
        const parts: string[] = [];
        const sortedPlaces = Array.from(labelCounts.keys()).sort((a, b) =>
            a.localeCompare(b, undefined, { numeric: true }),
        );

        for (const label of sortedPlaces) {
            const count = labelCounts.get(label)!;
            if (count > 1) {
                parts.push(`${count}*${label}`);
            } else {
                parts.push(label);
            }
        }

        return parts.length > 0 ? parts.join(' + ') : 'c...'; // fallback baseline label will be replaced by the object method correctly
    }

    private getMergedConditionAnchorIdOrNull(conditionId: string): string | null {
        const resolvedAnchor = this.resolveConditionAnchorId(conditionId);
        return resolvedAnchor === conditionId ? null : resolvedAnchor;
    }

    private resolveConditionAnchorId(conditionId: string): string {
        const anchorMap = this.mergedConditionAnchorById();
        let anchorId = conditionId;
        const visited = new Set<string>();

        while (anchorMap[anchorId] && !visited.has(anchorId)) {
            visited.add(anchorId);
            anchorId = anchorMap[anchorId];
        }

        return anchorId;
    }

    private restoreLastPhysicalMergeSnapshot(snapshot: LastPhysicalMergeSnapshot) {
        const currentNodes = this.drawnElements();
        const currentNodeIds = new Set(currentNodes.map((node) => node.id));
        const existingEventIds = new Set(
            currentNodes.filter((node): node is LabeledEvent => node instanceof LabeledEvent).map((event) => event.id),
        );

        const removedConditionSnapshots = snapshot.drawnElements
            .filter((node): node is Condition => node instanceof Condition)
            .filter((condition) => condition.id !== snapshot.anchorConditionId)
            .filter((condition) => !currentNodeIds.has(condition.id));

        if (removedConditionSnapshots.length === 0) {
            this.lastPhysicalMergeSnapshot.set(null);
            return;
        }

        const removedConditionIds = new Set(removedConditionSnapshots.map((condition) => condition.id));
        const restorableConnections = snapshot.connections.filter(
            (connection) =>
                (removedConditionIds.has(connection.source) && existingEventIds.has(connection.target)) ||
                (removedConditionIds.has(connection.target) && existingEventIds.has(connection.source)),
        );

        // If all event relations disappeared after merge, unmerge is no longer meaningful.
        if (restorableConnections.length === 0) {
            this.lastPhysicalMergeSnapshot.set(null);
            return;
        }

        const restoredConditions = this.cloneDrawnElements(removedConditionSnapshots);
        this.stateService.updateDrawnElements((elements) => [...elements, ...restoredConditions]);

        this.stateService.updateConnections((connections) => {
            const existingDirections = new Set(
                connections.map((connection) => `${connection.source}->${connection.target}`),
            );
            const toAdd = this.cloneConnections(restorableConnections).filter((connection) => {
                const key = `${connection.source}->${connection.target}`;
                if (existingDirections.has(key)) {
                    return false;
                }
                existingDirections.add(key);
                return true;
            });
            return [...connections, ...toAdd];
        });

        this.mergedConditionAnchorById.update((currentMap) => {
            const nextMap = { ...currentMap };
            for (const restoredCondition of removedConditionSnapshots) {
                delete nextMap[restoredCondition.id];
            }
            delete nextMap[snapshot.anchorConditionId];
            return nextMap;
        });

        this.lastPhysicalMergeSnapshot.set(null);
        this.playMergeAnimation(snapshot.anchorConditionId);
    }

    private commitLastPhysicalMergeSnapshot() {
        const lastSnapshot = this.lastPhysicalMergeSnapshot();
        if (!lastSnapshot) {
            return;
        }

        for (const conditionLabel of lastSnapshot.removedConditionLabels) {
            this.stateService.releaseConditionName(conditionLabel);
        }
        this.lastPhysicalMergeSnapshot.set(null);
    }

    private cloneDrawnElements(elements: LabeledNetNode[]): LabeledNetNode[] {
        return elements.map((node) => {
            if (node instanceof Condition) {
                const clone = this.stateService.buildCondition(
                    node.id,
                    node.label ?? node.displayLabel,
                    node.tokenCount(),
                    {
                        hideTokens: node.hideTokens,
                        isStartPlace: node.isStartPlace,
                        baseName: node.baseName,
                    },
                );
                clone.trailMarkings = { ...node.trailMarkings };
                clone.x = node.x;
                clone.y = node.y;
                return clone;
            }

            const clone = this.stateService.buildEvent(node.id, node.displayLabel, node.transitionId);
            clone.x = node.x;
            clone.y = node.y;
            return clone;
        });
    }

    private cloneConnections(connections: LabeledNetEdge[]): LabeledNetEdge[] {
        return connections.map((connection) => {
            const clone = new LabeledNetEdge(connection.id, connection.source, connection.target, connection.weight);
            clone.displayLabel = connection.displayLabel;
            clone.bendPoints = connection.bendPoints.map((point) => ({ x: point.x, y: point.y }));
            return clone;
        });
    }

    // Helpers for template
    getElementById(id: string): LabeledNetNode | undefined {
        return this.drawnElements().find((e) => e.id === id);
    }

    private isMarkedConditionId(conditionId: string): boolean {
        return this.getRequiredStartConditionCount(conditionId) > 0;
    }

    private getRequiredStartConditionCount(conditionId: string): number {
        const base = this.displayService.diagram;
        if (!base || !(base instanceof Diagram)) {
            return 0;
        }
        const tokens = base.startMarking[conditionId] ?? 0;
        return Math.max(0, Math.floor(tokens));
    }

    private getCurrentStartConditionCount(conditionId: string): number {
        return this.drawnElements().filter((el) => {
            if (!(el instanceof Condition) || !el.isStartPlace) {
                return false;
            }
            const label = el.label ?? el.displayLabel;
            return label === conditionId;
        }).length;
    }

    private shouldMarkAsStartCondition(conditionId: string): boolean {
        if (!this.isMarkedConditionId(conditionId)) {
            return false;
        }
        return this.getCurrentStartConditionCount(conditionId) < this.getRequiredStartConditionCount(conditionId);
    }

    isCondition(node: DiagramNode): boolean {
        return node instanceof Condition;
    }

    private createNewLPN() {
        //TODO: create a new LPN based on the existing Petri Net
    }
}
