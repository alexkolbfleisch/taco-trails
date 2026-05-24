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

import { Condition, Event as LabeledEvent, LabeledNetNode } from '../../../../classes/labeled-net.model';
import { Diagram } from '../../../../classes/diagram/diagram';
import { DisplayService } from '../../../../services/display.service';
import { TokenTrailValidationService, ValidationIssue } from '../../../../services/token-trail-validation.service';
import { PanningService } from '../../../../services/panning.service';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatDialog } from '@angular/material/dialog';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { GRAPH_FILENAMES, GRAPH_IDS, PLACE_RADIUS, TRANSITION_SIZE } from '../../../display/display.constants';
import { LpnGenerationDifficulty, TokenTrailStateService } from '../../../../services/token-trail-state.service';
import { Subscription } from 'rxjs';
import {
    DrawToolbarAction,
    DrawToolbarComponent,
    DrawToolbarInstruction,
} from '../../../draw-toolbar/draw-toolbar.component';
import { ImageExportService } from '../../../../services/image-export.service';
import { TokenTrailMergeService } from './token-trail-merge.service';
import { SvgEventNodeComponent } from '../../../display/svg-event-node/svg-event-node.component';
import { TokenTrailLpnService } from '../../../../services/token-trail-lpn.service';
import {
    TokenTrailValidationDetailDialogComponent,
    ValidationDetailDialogData,
} from './token-trail-validation-detail-dialog/token-trail-validation-detail-dialog.component';
import { ToasterNotificationService } from '../../../../services/toaster-notification.service';
import { SourcePetriNetService } from '../../../../services/source-petri-net.service';
import { LoadingService } from '../../../../services/loading.service';
import { ModeService } from '../../../../services/mode.service';
import { Tab } from '../../../../classes/tabs';

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
        MatProgressSpinnerModule,
    ],
    templateUrl: './token-trail-draw-display.html',
    providers: [PanningService, TokenTrailMergeService],
    styleUrls: ['./token-trail-draw-display.css'],
})
export class TokenTrailDrawDisplayComponent implements OnInit, OnDestroy, AfterViewInit {
    @ViewChild('drawingArea') drawingArea!: ElementRef<SVGGraphicsElement>;
    protected stateService = inject(TokenTrailStateService);
    private lpnService = inject(TokenTrailLpnService);
    protected validationService = inject(TokenTrailValidationService);
    protected loadingService = inject(LoadingService);
    private _modeService = inject(ModeService);
    private dialog = inject(MatDialog);
    private toaster = inject(ToasterNotificationService);
    private sourcePetriNetService = inject(SourcePetriNetService);

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

                let pathData = `M ${x1} ${y1}`;
                if (c.bendPoints && c.bendPoints.length > 0) {
                    for (const point of c.bendPoints) {
                        pathData += ` L ${point.x} ${point.y}`;
                    }
                }
                pathData += ` L ${x2} ${y2}`;

                return { id: c.id, x1, y1, x2, y2, weight: c.weight, pathData };
            })
            .filter(
                (
                    v,
                ): v is {
                    id: string;
                    x1: number;
                    y1: number;
                    x2: number;
                    y2: number;
                    weight: number;
                    pathData: string;
                } => v !== null,
            );
    });
    // Currently selected element for making a connection (highlighted)
    readonly selectedElementId = signal<string | null>(null);

    // Toolbar configuration
    protected readonly toolbarActions = computed<DrawToolbarAction[]>(() => [
        {
            icon: 'delete',
            tooltip: 'TOKEN_TRAIL.BUTTON_CLEAR_DRAWING',
            color: 'warn',
            isActive: !this.isDisabled(),
            action: () => this.clearDrawing(),
        },
        {
            icon: 'checklist',
            tooltip: 'TOKEN_TRAIL.BUTTON_VALIDATE_NET',
            color: 'primary',
            isActive: !this.isDisabled(),
            action: () => this.validationService.onValidate(),
        },
        {
            icon: this.getModeToggleIcon(),
            tooltip: this.getModeToggleTooltip(),
            color: 'accent',
            isActive: true, //TODO
            action: () => this.toggleMode(),
        },
        {
            icon: 'science',
            tooltip: 'TOKEN_TRAIL.BUTTON_SYNTHESIZE_LPN',
            color: 'accent',
            isActive: this.stateService.displayMode() === 'puzzle',
            action: () => {
                /* empty because we trigger the menu */
            },
            menu: [
                {
                    label: 'TOKEN_TRAIL.LPN_DIFFICULTY_EASY',
                    icon: 'sentiment_satisfied',
                    action: () => this.createNewLPNWithDifficulty('easy'),
                },
                {
                    label: 'TOKEN_TRAIL.LPN_DIFFICULTY_MEDIUM',
                    icon: 'sentiment_neutral',
                    action: () => this.createNewLPNWithDifficulty('medium'),
                },
                {
                    label: 'TOKEN_TRAIL.LPN_DIFFICULTY_HARD',
                    icon: 'sentiment_very_dissatisfied',
                    action: () => this.createNewLPNWithDifficulty('hard'),
                },
            ],
        },
    ]);

    private getModeToggleIcon(): string {
        return this.stateService.displayMode() === 'puzzle' ? 'construction' : 'extension';
    }

    private getModeToggleTooltip(): string {
        return this.stateService.displayMode() === 'puzzle'
            ? 'TOKEN_TRAIL.MODE_CONSTRUCTION'
            : 'TOKEN_TRAIL.MODE_PUZZLE';
    }

    private toggleMode(): void {
        const nextMode = this.stateService.displayMode() === 'puzzle' ? 'construction' : 'puzzle';
        this.stateService.setDisplayMode(nextMode);
    }

    protected readonly toolbarInstructions = computed<DrawToolbarInstruction[]>(() => {
        return [
            { label: 'TOKEN_TRAIL.ACTION_DRAG_DROP', text: 'TOKEN_TRAIL.INSTRUCTION_DRAG_DROP' },
            { label: 'TOKEN_TRAIL.INSTRUCTION_MOVE', text: 'TOKEN_TRAIL.INSTRUCTION_LEFT_CLICK_MOVE' },
            { label: 'TOKEN_TRAIL.INSTRUCTION_CONNECT', text: 'TOKEN_TRAIL.INSTRUCTION_RIGHT_CLICK_CONNECT' },
            { label: 'TOKEN_TRAIL.INSTRUCTION_DELETE', text: 'TOKEN_TRAIL.INSTRUCTION_MIDDLE_CLICK_DELETE' },
            { label: 'TOKEN_TRAIL.INSTRUCTION_DELETE_CONN', text: 'TOKEN_TRAIL.INSTRUCTION_MIDDLE_CLICK_DELETE_CONN' },
            { label: 'TOKEN_TRAIL.INSTRUCTION_VALIDATE', text: 'TOKEN_TRAIL.INSTRUCTION_VALIDATE_TOAST' },
            { label: 'TOKEN_TRAIL.INSTRUCTION_CHANGE_TOKENS', text: 'TOKEN_TRAIL.INSTRUCTION_CHANGE_TOKENS_TEXT' },
        ];
    });

    private draggedElement: Condition | LabeledEvent | null = null;
    private dragOffset = { x: 0, y: 0 };
    private hasDragged = false;
    private svgElement: SVGSVGElement | null = null;
    private isDraggingElement = false;
    private dragStartedMergedAnchorId: string | null = null;
    private elementRef = inject(ElementRef);

    private mergeService = inject(TokenTrailMergeService);

    private customDropListener: ((event: Event) => void) | null = null;
    private displayService = inject(DisplayService);
    private _imageExportService = inject(ImageExportService);
    private panningService = inject(PanningService);
    private translateService = inject(TranslateService);
    private downloadSub?: Subscription;
    private sourceNetSub?: Subscription;

    readonly viewBox = this.panningService.viewBoxAsString;
    readonly viewBoxObj = this.panningService.viewBox;

    private fitViewSubscription?: Subscription;

    // Dimensions for condition/event nodes
    private readonly CONDITION_RADIUS = PLACE_RADIUS;
    private readonly EVENT_HALF_W = TRANSITION_SIZE / 2;
    private readonly EVENT_HALF_H = TRANSITION_SIZE / 2;
    private readonly UNMERGE_DRAG_DISTANCE = this.CONDITION_RADIUS * 2;

    private readonly _tokenPreviewEffect = effect(() => {
        const displayMode = this.stateService.displayMode();
        const selectedPlaceId = this.stateService.selectedPetriPlaceId();
        const isExam = this._modeService.isExamMode(Tab.TOKEN_TRAIL);

        if (displayMode !== 'puzzle') {
            // In construction mode, tokens are never visible
            let hasChanges = false;
            for (const node of this.drawnElements()) {
                if (!(node instanceof Condition)) {
                    continue;
                }
                if (!node.hideTokens || node.tokenCount() !== 0) {
                    hasChanges = true;
                    break;
                }
            }

            if (!hasChanges) {
                return;
            }

            this.stateService.updateDrawnElements((elements) =>
                elements.map((node) => {
                    if (node instanceof Condition) {
                        node.hideTokens = true;
                        node.tokens = 0;
                        node.updateDynamicLabel();
                    }
                    return node;
                }),
            );
            return;
        }

        let hasChanges = false;
        for (const node of this.drawnElements()) {
            if (!(node instanceof Condition)) {
                continue;
            }
            const showStartPlaceTokens = node.isStartPlace && !isExam;
            const desiredTokens = selectedPlaceId ? node.getTrailTokens(selectedPlaceId) : showStartPlaceTokens ? 1 : 0;
            const desiredHideTokens = selectedPlaceId ? false : !showStartPlaceTokens;
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

                const showStartPlaceTokens = node.isStartPlace && !isExam;
                node.hideTokens = selectedPlaceId ? false : !showStartPlaceTokens;
                node.tokens = selectedPlaceId ? node.getTrailTokens(selectedPlaceId) : showStartPlaceTokens ? 1 : 0;
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

        this.sourceNetSub = this.sourcePetriNetService.sourceNet$.subscribe((net) => {
            if (this.stateService.displayMode() === 'puzzle' && net) {
                this.createNewLPNWithSynthesis();
            }
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
        this.sourceNetSub?.unsubscribe();
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

        const selectedPlaceId = this.stateService.selectedPetriPlaceId();
        if (!selectedPlaceId) {
            this.toaster.showWarning(
                'TOKEN_TRAIL.PLACE_SELECTION_REQUIRED_TITLE',
                'TOKEN_TRAIL.PLACE_SELECTION_REQUIRED_BODY',
            );
            return;
        }

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
        if (this._modeService.isExamMode(Tab.TOKEN_TRAIL)) {
            return false;
        }
        return this.validationService.invalidNodeIds().has(elementId);
    }

    isConnectionInvalid(connectionId: string): boolean {
        if (this._modeService.isExamMode(Tab.TOKEN_TRAIL)) {
            return false;
        }
        return this.validationService.invalidConnectionIds().has(connectionId);
    }

    hasElementIssues(elementId: string): boolean {
        if (this._modeService.isExamMode(Tab.TOKEN_TRAIL)) {
            return false;
        }
        const result = this.validationService.liveValidation();
        if (!result) return false;

        let issues = result.issues.filter(
            (issue) => (issue.eventIds ?? []).includes(elementId) || (issue.conditionIds ?? []).includes(elementId),
        );

        if (this.stateService.displayMode() === 'puzzle') {
            const selectedPlaceId = this.stateService.selectedPetriPlaceId();
            if (selectedPlaceId) {
                issues = issues.filter((issue) => issue.messageParams?.['place'] === selectedPlaceId);
            }
        }

        return issues.length > 0;
    }

    hasConnectionIssues(connectionId: string): boolean {
        if (this._modeService.isExamMode(Tab.TOKEN_TRAIL)) {
            return false;
        }
        const result = this.validationService.liveValidation();
        if (!result) return false;

        let issues = result.issues.filter((issue) => (issue.connectionIds ?? []).includes(connectionId));

        if (this.stateService.displayMode() === 'puzzle') {
            const selectedPlaceId = this.stateService.selectedPetriPlaceId();
            if (selectedPlaceId) {
                issues = issues.filter((issue) => issue.messageParams?.['place'] === selectedPlaceId);
            }
        }

        return issues.length > 0;
    }

    openValidationDetailDialog(id: string, type: 'element' | 'connection') {
        const result = this.validationService.liveValidation();
        if (!result) return;

        let issues: ValidationIssue[] = [];
        if (type === 'element') {
            issues = result.issues.filter(
                (issue) => (issue.eventIds ?? []).includes(id) || (issue.conditionIds ?? []).includes(id),
            );
        } else {
            issues = result.issues.filter((issue) => (issue.connectionIds ?? []).includes(id));
        }

        if (this.stateService.displayMode() === 'puzzle') {
            const selectedPlaceId = this.stateService.selectedPetriPlaceId();
            if (selectedPlaceId) {
                issues = issues.filter((issue) => issue.messageParams?.['place'] === selectedPlaceId);
            }
        }

        const data: ValidationDetailDialogData = {
            title: this.translateService.instant('TOASTER.HEADER.VALIDATION'),
            issues,
        };

        this.dialog.open(TokenTrailValidationDetailDialogComponent, {
            data,
            width: '500px',
            maxHeight: '80vh',
        });
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

    private createNewLPNWithDifficulty(difficulty: LpnGenerationDifficulty) {
        if (this.stateService.displayMode() === 'construction') return;
        const sourceNet = this.validationService.resolveSourceNetForValidation();
        if (!sourceNet) return;
        this.lpnService.createLPNWithSynthesis(sourceNet, difficulty);
    }

    private createNewLPNWithSynthesis() {
        if (this.stateService.displayMode() === 'construction') return;
        const sourceNet = this.validationService.resolveSourceNetForValidation();
        if (!sourceNet) return;
        this.lpnService.createLPNWithSynthesis(sourceNet);
    }
}
