import {
    AfterViewInit,
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
import { TokenTrailMergeService } from './token-trail-merge.service';
import { SvgEventNodeComponent } from '../../../display/svg-event-node/svg-event-node.component';
import { PlayValidationService } from '../../../../services/play-validation.service';
import { PlayService } from '../../../../services/play.service';
import { PetriNetToPartialOrderTransformerService } from '../../../../../../ilpn-components/src/lib/algorithms/pn/transformation/petri-net-to-partial-order-transformer.service';
import { Ilp2MinerService } from '../../../../../../ilpn-components/src/lib/algorithms/pn/synthesis/ilp2-miner/ilp2-miner.service';
import { PetriNet as IlpnPetriNet } from '../../../../../../ilpn-components/src/lib/models/pn/model/petri-net';
import { Place as IlpnPlace } from '../../../../../../ilpn-components/src/lib/models/pn/model/place';
import { Transition as IlpnTransition } from '../../../../../../ilpn-components/src/lib/models/pn/model/transition';
import { PartialOrder } from '../../../../../../ilpn-components/src/lib/models/po/model/partial-order';
import { SugiyamaService } from '../../../../services/sugiyama.service';

//TODO: clean this up, this is becoming huge, implement a merging service or something, or handle merging in the state service as well. Remove duplications or put them into a common place.

/**
 * TokenTrailDrawDisplayComponent is the main drawing canvas for Token Trail validation in the Token Trail tab.
 *
 * Responsibilities:
 * - Canvas interaction: drag-drop, pan/zoom, click-based connection creation
 * - Token editing in puzzle mode (scroll to adjust counts)
 * - Live validation feedback (highlights invalid nodes/connections)
 * - Drawing layout and rendering of conditions and events
 * - Delegation of merge logic to `TokenTrailMergeService`
 *
 * The component maintains:
 * - Drawing elements (Conditions and Events) via `TokenTrailStateService`
 * - Currently selected element for connection drawing
 * - Live validation state and display errors
 * - SVG coordinate transformations for panning/zooming
 */
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
    providers: [PanningService, TokenTrailMergeService],
    styleUrls: ['./token-trail-draw-display.css'],
})
export class TokenTrailDrawDisplayComponent implements OnInit, OnDestroy, AfterViewInit {
    @ViewChild('drawingArea') drawingArea!: ElementRef<SVGGraphicsElement>;
    protected stateService = inject(TokenTrailStateService);
    private sugiyamaService = inject(SugiyamaService);

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
            tooltip: 'TODO',
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

    private playValidationService = inject(PlayValidationService);
    private playService = inject(PlayService);
    private mergeService = inject(TokenTrailMergeService);
    private pnToPOTransformer = inject(PetriNetToPartialOrderTransformerService);
    private ilp2MinerService = inject(Ilp2MinerService);

    private customDropListener: ((event: Event) => void) | null = null;
    private displayService = inject(DisplayService);
    private toaster = inject(ToasterNotificationService);
    private _imageExportService = inject(ImageExportService);
    private panningService = inject(PanningService);
    private translateService = inject(TranslateService);
    private sourcePetriNetService = inject(SourcePetriNetService);
    private downloadSub?: Subscription;

    readonly viewBox = this.panningService.viewBoxAsString;
    readonly viewBoxObj = this.panningService.viewBox;

    private fitViewSubscription?: Subscription;

    // Dimensions for condition/event nodes
    private readonly CONDITION_RADIUS = PLACE_RADIUS;
    private readonly EVENT_HALF_W = TRANSITION_SIZE / 2;
    private readonly EVENT_HALF_H = TRANSITION_SIZE / 2;
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

                node.hideTokens = !selectedPlaceId;
                node.tokens = selectedPlaceId ? node.getTrailTokens(selectedPlaceId) : 0;
                node.updateDynamicLabel(); // Always compute the correct string based on trailMarkings first

                return node;
            }),
        );
    });

    // Previously, validPlaces were automatically computed by _validPlacesEffect.
    // Now they are handled by the ILP TokenTrailValidatorService securely.

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
            element instanceof Condition ? this.mergeService.getMergedConditionAnchorIdOrNull(element.id) : null;

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

        const anchorConditionId = this.mergeService.getMergedConditionAnchorIdOrNull(element.id) ?? element.id;

        // If it's a visual merge group (size > 1), double tap to FINALIZE it
        if (this.mergeService.getConditionGroupSize(anchorConditionId) > 1) {
            const removedConditionIds = this.mergeService.finalizeMergedConditionGroup(anchorConditionId);
            if (this.selectedElementId() && removedConditionIds.includes(this.selectedElementId()!)) {
                this.selectedElementId.set(null);
            }
            return;
        }

        // If it's already a finalized merged condition (size === 1) and the label has a '+' sign or multiplier, UNMERGE it
        const displayLabel = element.label ?? element.displayLabel;
        if (displayLabel.includes('+') || /^\d+\*/.test(displayLabel)) {
            this.mergeService.unmergeConditionGroup(anchorConditionId, (conditionId) =>
                this.shouldMarkAsStartCondition(conditionId),
            );
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

            // Just update coordinates directly. Due to `x` and `y` being WritableSignal getters/setters
            // inside DiagramNode, the UI will re-render automatically. This preserves the object reference
            // so active instances of SpringEmbedderService calculating layout can read the dragged changes.
            this.draggedElement.x = newX;
            this.draggedElement.y = newY;

            if (this.draggedElement instanceof Condition && this.dragStartedMergedAnchorId) {
                const anchor = this.getElementById(this.dragStartedMergedAnchorId);
                if (anchor instanceof Condition) {
                    const distanceToAnchor = Math.hypot(
                        this.draggedElement.x - anchor.x,
                        this.draggedElement.y - anchor.y,
                    );
                    if (distanceToAnchor > this.UNMERGE_DRAG_DISTANCE) {
                        this.mergeService.unmergeCondition(this.draggedElement.id);
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
            this.mergeService.tryMergeConditionOnDrop(releasedElement);
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
                    if (!node.baseName) {
                        node.baseName = node.label ?? node.displayLabel;
                    }

                    const currentTokens = node.getTrailTokens(selectedPlaceId);
                    const nextTokens = Math.max(0, currentTokens + delta);

                    // We directly mutate the inner map without triggering updateDynamicLabel()
                    // because we are in puzzle mode and want to keep the base label ("c1" etc.)
                    if (nextTokens > 0) {
                        node.trailMarkings[selectedPlaceId] = nextTokens;
                    } else {
                        delete node.trailMarkings[selectedPlaceId];
                    }

                    // Call updateDynamicLabel to properly reflect dynamic data correctly even if currently hidden
                    node.updateDynamicLabel();

                    // Visually update the UI right away
                    node.tokens = node.getTrailTokens(selectedPlaceId);

                    return node;
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
        this.mergeService.clearMergeState();

        const diagram = this.displayService.diagram;
        if (diagram instanceof Diagram) {
            diagram.resetMarking();
        }

        this.stateService.clear();
    }

    deleteElement(element: LabeledNetNode) {
        if (element instanceof Condition) {
            this.mergeService.handleConditionDelete(element);
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
        const result = this.liveValidation();
        if (!result) {
            this.toaster.showError('TOASTER.HEADER.VALIDATION', 'TOASTER.BODY.VALIDATION_ERROR', {
                duration: 0,
            });
            return;
        }

        const validSet = new Set<string>();
        const invalidSet = new Set<string>();

        if (result.perPlaceResults) {
            for (const [placeId, placeResult] of Object.entries(result.perPlaceResults)) {
                if (placeResult.valid) {
                    validSet.add(placeId);
                } else {
                    invalidSet.add(placeId);
                }
            }
        }

        this.stateService.setValidPetriPlaceIds(validSet);
        this.stateService.setInvalidPetriPlaceIds(invalidSet);
        this.stateService.setSelectedPetriPlaceId(null);
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
                trailMarkings: isCondition ? { ...el.trailMarkings } : undefined,
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
        return sourceNode instanceof Condition !== targetNode instanceof Condition;
    }

    private hasExactConnectionDirection(sourceId: string, targetId: string): boolean {
        return this.connections().some(
            (connection) => connection.source === sourceId && connection.target === targetId,
        );
    }

    // Template/view helpers bound to merge service

    /**
     * Check if a node should visually display a merge anchor badge (i.e., multiple conditions merged).
     * Used by the template to render the merge group size indicator.
     */
    isMergeAnchor(node: LabeledNetNode): boolean {
        return this.mergeService.isMergeAnchor(node);
    }

    /**
     * Check if a node is currently playing its merge animation.
     * Used by the template to apply CSS animation classes.
     */
    isMergeAnimating(node: LabeledNetNode): boolean {
        return this.mergeService.isMergeAnimating(node);
    }

    /**
     * Get the size of the merge group that this condition belongs to.
     * Used by the template to display the merge count badge.
     */
    getConditionGroupSize(conditionId: string): number {
        return this.mergeService.getConditionGroupSize(conditionId);
    }

    // Merge behavior moved to `TokenTrailMergeService`.

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

    private createNewLPN() {
        const sourceNet = this.resolveSourceNetForValidation();
        if (!sourceNet) return;

        this.playService.firingEntries.set([]);
        this.playValidationService.findSequences(sourceNet, 1, 15);

        const partialOrders: PartialOrder[] = [];
        const entries = this.playService.firingEntries();

        const validEntries = entries.filter((entry) => entry.isValid && entry.labels.length > 0);
        const shuffled = [...validEntries].sort(() => 0.5 - Math.random());
        const subsetSize = Math.max(1, Math.floor(Math.random() * shuffled.length) + 1);
        const selectedEntries = shuffled.slice(0, subsetSize);

        for (const entry of selectedEntries) {
            const net = new IlpnPetriNet();
            let lastPlace = new IlpnPlace();
            lastPlace.marking = 1;
            net.addPlace(lastPlace);

            const occurrenceCount = new Map<string, number>();

            for (const label of entry.labels) {
                const count = occurrenceCount.get(label) || 0;
                occurrenceCount.set(label, count + 1);

                const actualLabel = count === 0 ? label : `${label}__split${count}`;
                const t = new IlpnTransition(actualLabel);
                net.addTransition(t);
                net.addArc(lastPlace, t);

                const nextPlace = new IlpnPlace();
                net.addPlace(nextPlace);
                net.addArc(t, nextPlace);

                lastPlace = nextPlace;
            }

            try {
                const po = this.pnToPOTransformer.transform(net);
                partialOrders.push(po);
            } catch (e) {
                console.error('Failed to transform to partial order', e);
            }
        }

        if (partialOrders.length === 0) return;

        this.ilp2MinerService.mine(partialOrders).subscribe((result) => {
            this.clearDrawing();
            const minedNet = result.net;

            const placeMap = new Map<string, string>();
            const transitionMap = new Map<string, string>();

            const getRandomPos = () => {
                const viewBox = this.viewBoxObj();
                const width = Math.max(viewBox.width, 800);
                const height = Math.max(viewBox.height, 600);
                return {
                    x: viewBox.minX + Math.random() * width,
                    y: viewBox.minY + Math.random() * height,
                };
            };

            minedNet.getPlaces().forEach((p) => {
                const uniqueId = this.stateService.generateElementId(`drawn-place`);
                placeMap.set(p.id!, uniqueId);
                const condition = this.stateService.buildCondition(uniqueId, p.id!, p.marking, {
                    isStartPlace: p.marking > 0,
                });
                const pos = getRandomPos();
                condition.x = pos.x;
                condition.y = pos.y;
                this.stateService.addDrawnElement(condition);
            });

            minedNet.getTransitions().forEach((t) => {
                const uniqueId = this.stateService.generateElementId(`drawn-trans`);
                transitionMap.set(t.id!, uniqueId);
                const rawLabel = t.label ?? t.id!;
                const cleanLabel = rawLabel.split('__split')[0];
                const eventNode = this.stateService.buildEvent(uniqueId, cleanLabel, cleanLabel);
                const pos = getRandomPos();
                eventNode.x = pos.x;
                eventNode.y = pos.y;
                this.stateService.addDrawnElement(eventNode);
            });

            minedNet.getPlaces().forEach((p) => {
                const pId = placeMap.get(p.id!)!;
                p.outgoingArcs.forEach((a) => {
                    const tId = transitionMap.get(a.destinationId!)!;
                    this.stateService.addConnection(
                        new LabeledNetEdge(this.stateService.generateConnectionId('conn'), pId, tId, a.weight),
                    );
                });
                p.ingoingArcs.forEach((a) => {
                    const tId = transitionMap.get(a.sourceId!)!;
                    this.stateService.addConnection(
                        new LabeledNetEdge(this.stateService.generateConnectionId('conn'), tId, pId, a.weight),
                    );
                });
            });

            this.sugiyamaService.calculateLayout(this.drawnElements(), this.connections());
            this.stateService.updateDrawnElements((e) => [...e]);
            this.stateService.updateConnections((c) => [...c]);
        });
    }
}
