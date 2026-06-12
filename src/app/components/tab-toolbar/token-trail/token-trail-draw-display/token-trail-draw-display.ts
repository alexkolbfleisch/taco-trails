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
    LabeledNetNode,
    LabeledNetEdge,
} from '../../../../classes/labeled-net.model';
import { DisplayService } from '../../../../services/display.service';
import { TokenTrailValidationService, ValidationIssue } from '../../../../services/token-trail-validation.service';
import { PanningService } from '../../../../services/panning.service';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCardModule } from '@angular/material/card';
import { MatDialog } from '@angular/material/dialog';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { GRAPH_FILENAMES, GRAPH_IDS, PLACE_RADIUS, TRANSITION_SIZE } from '../../../display/display.constants';
import { LpnGenerationDifficulty, TokenTrailStateService } from '../../../../services/token-trail-state.service';
import { SerializationService } from '../../../../services/serialization.service';
import { Subscription, take } from 'rxjs';
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
import { TokenTrailValidatorService } from '../../../../../../ilpn-components/src/lib/algorithms/pn/validation/token-trails/token-trail-validator.service';
import { DrawingDisplayService } from '../../../../services/drawing-display.service';
import { ParserService } from '../../../../services/parser.service';
import { ValidationBubbleComponent } from './validation-bubble/validation-bubble.component';
import { TokenTrailTourService } from '../../../../services/token-trail-tour.service';

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
        MatCardModule,
        ValidationBubbleComponent,
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
    private tokenTrailValidatorService = inject(TokenTrailValidatorService);
    private sourcePetriNetService = inject(SourcePetriNetService);
    private drawingDisplayService = inject(DrawingDisplayService);
    private serializationService = inject(SerializationService);
    private parserService = inject(ParserService);
    protected tourService = inject(TokenTrailTourService);

    // Bind to service state
    readonly drawnElements = this.stateService.drawnElements;
    readonly connections = this.stateService.connections;
    readonly isDisabled = computed(() => this.drawnElements().length === 0);

    protected readonly isExamMode = computed(() => this._modeService.isExamMode(Tab.TOKEN_TRAIL));

    // Bubble open states mapping
    private readonly _openElementBubbles = signal<Set<string>>(new Set<string>());
    private readonly _openConnectionBubbles = signal<Set<string>>(new Set<string>());

    isElementBubbleOpen(elementId: string): boolean {
        return this._openElementBubbles().has(elementId);
    }

    toggleElementBubble(elementId: string): void {
        this._openElementBubbles.update((prev) => {
            const next = new Set(prev);
            if (next.has(elementId)) {
                next.delete(elementId);
            } else {
                next.add(elementId);
            }
            return next;
        });
    }

    isConnectionBubbleOpen(connectionId: string): boolean {
        return this._openConnectionBubbles().has(connectionId);
    }

    toggleConnectionBubble(connectionId: string): void {
        this._openConnectionBubbles.update((prev) => {
            const next = new Set(prev);
            if (next.has(connectionId)) {
                next.delete(connectionId);
            } else {
                next.add(connectionId);
            }
            return next;
        });
    }

    getElementIssues(elementId: string): ValidationIssue[] {
        const isExam = this.isExamMode();
        if (isExam) return [];

        const result = this.validationService.liveValidation();
        if (!result) return [];

        const displayMode = this.stateService.displayMode();
        const selectedPlaceId = this.stateService.selectedPetriPlaceId();

        let issues = result.issues.filter(
            (issue) => (issue.eventIds ?? []).includes(elementId) || (issue.conditionIds ?? []).includes(elementId),
        );

        if (displayMode === 'puzzle' && selectedPlaceId) {
            issues = issues.filter((issue) => issue.placeId === selectedPlaceId);
        }

        return issues;
    }

    getConnectionIssues(connectionId: string): ValidationIssue[] {
        const isExam = this.isExamMode();
        if (isExam) return [];

        const result = this.validationService.liveValidation();
        if (!result) return [];

        const displayMode = this.stateService.displayMode();
        const selectedPlaceId = this.stateService.selectedPetriPlaceId();

        let issues = result.issues.filter((issue) => (issue.connectionIds ?? []).includes(connectionId));

        if (displayMode === 'puzzle' && selectedPlaceId) {
            issues = issues.filter((issue) => issue.placeId === selectedPlaceId);
        }

        return issues;
    }

    readonly isDragOver = signal<boolean>(false);
    // Derived lines with coordinates for rendering
    readonly connectionLines = computed(() => {
        return this.connections()
            .map((c) => {
                const a = this.getElementById(c.source);
                const b = this.getElementById(c.target);
                if (!a || !b) return null;

                // Compute trimmed endpoints so the line starts/ends at shape boundaries
                const { x1, y1, x2, y2 } = this.drawingDisplayService.computeTrimmedLine(
                    { x: a.x, y: a.y, isPlace: a instanceof Condition },
                    { x: b.x, y: b.y, isPlace: b instanceof Condition },
                );

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
            isActive:
                !this.isDisabled() &&
                !this.stateService.showingSolution() &&
                this.stateService.displayMode() !== 'puzzle',
            action: () => this.clearDrawing(),
        },
        {
            icon: 'checklist',
            tooltip: 'TOKEN_TRAIL.BUTTON_VALIDATE_NET',
            color: 'primary',
            isActive: !this.isDisabled() && !this.stateService.showingSolution(),
            action: () => this.validationService.onValidate(),
        },
        {
            icon: this.getModeToggleIcon(),
            tooltip: this.getModeToggleTooltip(),
            color: 'accent',
            isActive: !this.stateService.showingSolution(),
            action: () => this.toggleMode(),
        },
        {
            icon: this.stateService.showingSolution() ? 'lightbulb' : 'lightbulb_outline',
            tooltip: this.stateService.showingSolution()
                ? 'TOKEN_TRAIL.BUTTON_HIDE_SOLUTION'
                : 'TOKEN_TRAIL.BUTTON_SHOW_SOLUTION',
            color: 'primary',
            isActive: !this.isDisabled(),
            action: () => this.toggleSolution(),
        },
        {
            icon: 'science',
            tooltip: 'TOKEN_TRAIL.BUTTON_SYNTHESIZE_LPN',
            color: 'accent',
            isActive: this.stateService.displayMode() === 'puzzle' && !this.stateService.showingSolution(),
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
        {
            icon: 'file_download',
            tooltip: 'TOKEN_TRAIL.BUTTON_EXPORT_LPN',
            color: 'primary',
            isActive: !this.isDisabled() && !this.stateService.showingSolution(),
            action: () => {
                /* empty because we trigger the menu */
            },
            menu: [
                {
                    label: 'TOKEN_TRAIL.EXPORT_JSON',
                    icon: 'code',
                    action: () => this.exportLpn('json'),
                },
                {
                    label: 'TOKEN_TRAIL.EXPORT_PNML',
                    icon: 'article',
                    action: () => this.exportLpn('pnml'),
                },
            ],
        },
        {
            icon: 'explore',
            tooltip: 'TOKEN_TRAIL.TOUR.RESTART_BUTTON',
            color: 'primary',
            isActive: true,
            action: () => this.tourService.startTour(true),
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

        // Always clean the LPN drawing area first before switching modes
        this.clearDrawing();

        this.stateService.setDisplayMode(nextMode);

        if (nextMode === 'puzzle') {
            this.createNewLPNWithSynthesis();
        }
    }

    protected readonly toolbarInstructions = computed<DrawToolbarInstruction[]>(() => {
        if (this.stateService.displayMode() === 'puzzle') {
            return [
                { label: 'TOKEN_TRAIL.INSTRUCTION_CHANGE_TOKENS', text: 'TOKEN_TRAIL.INSTRUCTION_CHANGE_TOKENS_TEXT' },
                { label: 'TOKEN_TRAIL.INSTRUCTION_VALIDATE', text: 'TOKEN_TRAIL.INSTRUCTION_VALIDATE_TOAST' },
            ];
        }
        return [
            { label: 'TOKEN_TRAIL.ACTION_DRAG_DROP', text: 'TOKEN_TRAIL.INSTRUCTION_DRAG_DROP' },
            { label: 'TOKEN_TRAIL.INSTRUCTION_MOVE', text: 'TOKEN_TRAIL.INSTRUCTION_LEFT_CLICK_MOVE' },
            { label: 'TOKEN_TRAIL.INSTRUCTION_CONNECT', text: 'TOKEN_TRAIL.INSTRUCTION_RIGHT_CLICK_CONNECT' },
            { label: 'TOKEN_TRAIL.INSTRUCTION_DELETE', text: 'TOKEN_TRAIL.INSTRUCTION_MIDDLE_CLICK_DELETE' },
            { label: 'TOKEN_TRAIL.INSTRUCTION_DELETE_CONN', text: 'TOKEN_TRAIL.INSTRUCTION_MIDDLE_CLICK_DELETE_CONN' },
            { label: 'TOKEN_TRAIL.INSTRUCTION_VALIDATE', text: 'TOKEN_TRAIL.INSTRUCTION_VALIDATE_TOAST' },
        ];
    });

    private draggedElement: Condition | LabeledEvent | null = null;
    private dragOffset = { x: 0, y: 0 };
    private hasDragged = false;
    private isDraggingElement = false;
    private dragStartedMergedAnchorId: string | null = null;
    private elementRef = inject(ElementRef);

    private mergeService = inject(TokenTrailMergeService);
    private originalDisplayMode: 'puzzle' | 'construction' | null = null;

    private customDropListener: ((event: Event) => void) | null = null;
    private displayService = inject(DisplayService);
    private _imageExportService = inject(ImageExportService);
    private panningService = inject(PanningService);
    private translateService = inject(TranslateService);
    private downloadSub?: Subscription;
    private sourceNetSub?: Subscription;

    readonly viewBox = this.panningService.viewBoxAsString;
    readonly viewBoxObj = this.panningService.viewBox;

    /**
     * Highly optimized, cached signal map containing visual metadata and state for all drawn elements.
     * Computes values for invalid status, merge anchors, animation triggers, tooltips, and issues in a single pass.
     * Prevents expensive O(N^2) calculations during change detection cycles triggered by panning and zooming.
     */
    readonly elementMetadataMap = computed(() => {
        const elements = this.drawnElements();
        const displayMode = this.stateService.displayMode();
        const showingSolution = this.stateService.showingSolution();
        const isExam = this._modeService.isExamMode(Tab.TOKEN_TRAIL);
        const selectedPlaceId = this.stateService.selectedPetriPlaceId();

        const invalidNodeIds = this.validationService.invalidNodeIds();
        const validationResult = this.validationService.liveValidation();

        const map = new Map<
            string,
            {
                isMergeAnchor: boolean;
                isMergeAnimating: boolean;
                isInvalid: boolean;
                shouldShowTooltip: boolean;
                groupSize: number;
                hasIssues: boolean;
                tooltipText: string;
            }
        >();

        for (const element of elements) {
            const isMergeAnchor = this.mergeService.isMergeAnchor(element);
            const isMergeAnimating = this.mergeService.isMergeAnimating(element);

            // groupSize logic
            const groupSize = this.mergeService.getConditionGroupSize(element.id);

            // hasElementIssues logic
            let hasIssues = false;
            if (!isExam && !showingSolution && validationResult) {
                let issues = validationResult.issues.filter(
                    (issue) =>
                        (issue.eventIds ?? []).includes(element.id) || (issue.conditionIds ?? []).includes(element.id),
                );

                if (displayMode === 'puzzle' && selectedPlaceId) {
                    issues = issues.filter((issue) => issue.placeId === selectedPlaceId);
                }
                hasIssues = issues.length > 0;
            }

            // isNodeInvalid logic
            let isInvalid = !isExam && !showingSolution && invalidNodeIds.has(element.id);
            if (isInvalid && displayMode === 'puzzle' && selectedPlaceId) {
                isInvalid = hasIssues;
            }

            // shouldShowTooltip logic
            const label = element.displayLabel || element.label || '';
            let shouldShowTooltip = false;
            if (label.length > 15) {
                shouldShowTooltip = true;
            } else if (displayMode === 'puzzle') {
                shouldShowTooltip = label.length > 5;
            }

            map.set(element.id, {
                isMergeAnchor,
                isMergeAnimating,
                isInvalid,
                shouldShowTooltip,
                groupSize,
                hasIssues,
                tooltipText: label,
            });
        }

        return map;
    });

    /**
     * Highly optimized, cached signal map containing visual metadata and state for all connections.
     * Pre-calculates invalid statuses and validation issues in a single pass to ensure O(1) rendering lookups.
     */
    readonly connectionMetadataMap = computed(() => {
        const connections = this.connections();
        const showingSolution = this.stateService.showingSolution();
        const isExam = this._modeService.isExamMode(Tab.TOKEN_TRAIL);
        const displayMode = this.stateService.displayMode();
        const selectedPlaceId = this.stateService.selectedPetriPlaceId();

        const invalidConnectionIds = this.validationService.invalidConnectionIds();
        const validationResult = this.validationService.liveValidation();

        const map = new Map<
            string,
            {
                isInvalid: boolean;
                hasIssues: boolean;
            }
        >();

        for (const connection of connections) {
            let hasIssues = false;
            if (!isExam && !showingSolution && validationResult) {
                let issues = validationResult.issues.filter((issue) =>
                    (issue.connectionIds ?? []).includes(connection.id),
                );
                if (displayMode === 'puzzle' && selectedPlaceId) {
                    issues = issues.filter((issue) => issue.placeId === selectedPlaceId);
                }
                hasIssues = issues.length > 0;
            }

            let isInvalid = !isExam && !showingSolution && invalidConnectionIds.has(connection.id);
            if (isInvalid && displayMode === 'puzzle' && selectedPlaceId) {
                isInvalid = hasIssues;
            }

            map.set(connection.id, {
                isInvalid,
                hasIssues,
            });
        }

        return map;
    });

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
        const showSolution = this.stateService.showingSolution();
        const solvedTrails = this.stateService.solvedTokenTrails();

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
            const desiredTokens = selectedPlaceId
                ? showSolution
                    ? (solvedTrails.get(selectedPlaceId)?.[node.id] ?? 0)
                    : node.getTrailTokens(selectedPlaceId)
                : showStartPlaceTokens
                  ? 1
                  : 0;
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
                node.tokens = selectedPlaceId
                    ? showSolution
                        ? (solvedTrails.get(selectedPlaceId)?.[node.id] ?? 0)
                        : node.getTrailTokens(selectedPlaceId)
                    : showStartPlaceTokens
                      ? 1
                      : 0;
                node.updateDynamicLabel(); // Always compute the correct string based on trailMarkings first

                return node;
            }),
        );
    });

    // Previously, validPlaces were automatically computed by _validPlacesEffect.
    // Now they are handled by the ILP TokenTrailValidatorService securely.

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
                getNodes: () => this.drawnElements(),
                getEdges: () => [],
            });
        });

        this.sourceNetSub = this.sourcePetriNetService.sourceNet$.subscribe((net) => {
            if (this.stateService.displayMode() === 'puzzle' && net) {
                const currentSig = this.lpnService.getNetSignature(net);
                const hasDrawnElements = this.drawnElements().length > 0;
                const isSameSignature = currentSig === this.stateService.lastSynthesizedNetSignature;

                if (!hasDrawnElements || !isSameSignature) {
                    this.createNewLPNWithSynthesis();
                }
            }
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
        this.sourceNetSub?.unsubscribe();
    }

    private handleCanvasMouseDown = (event: MouseEvent) => {
        this.drawingDisplayService.handleCanvasMouseDown(event, this.drawnElements(), (evt, el) =>
            this.onElementMouseDown(evt, el),
        );
    };

    private handleCustomDrop(event: CustomEvent) {
        if (this.stateService.showingSolution()) return;
        if (this.stateService.displayMode() === 'puzzle') {
            this.toaster.showWarning('TOKEN_TRAIL.MODE_WARNING_TITLE', 'TOKEN_TRAIL.MODE_WARNING_PUZZLE_RESTRICTION');
            return;
        }

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

        let newNode: LabeledNetNode;
        const elementLabel = detail.elementLabel || detail.elementId;
        const elementTokens = detail.elementTokens ?? 0;

        const isSourceCondition = detail.elementType === 'place';
        const isSourceEvent = detail.elementType === 'transition';

        if (isSourceCondition) {
            const conditionId = this.stateService.generateConditionName();
            newNode = this.stateService.buildCondition(conditionId, detail.elementId, elementTokens, {
                isStartPlace: this.shouldMarkAsStartCondition(detail.elementId),
                innerLabel: detail.elementId,
                baseName: conditionId,
            });
            // In construction mode, the new Condition directly receives the trail marking of the dragged place:
            (newNode as Condition).trailMarkings = { [detail.elementId]: 1 };
            (newNode as Condition).updateDynamicLabel();
        } else if (isSourceEvent) {
            const uniqueId = this.stateService.generateElementId(`drawn-${detail.elementId}`);
            newNode = this.stateService.buildEvent(uniqueId, elementLabel, elementLabel);
        } else {
            return;
        }

        newNode.x = svgPoint.x;
        newNode.y = svgPoint.y;

        this.stateService.addDrawnElement(newNode);
        this.tourService.notifyElementDropped();
    }

    onDragOver(event: DragEvent) {
        const isFileDrag = event.dataTransfer?.types.includes('Files');
        if (this.stateService.displayMode() === 'puzzle' && !isFileDrag) return;
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
        // 1. Check for dropped files (JSON / PNML LPN representation)
        if (event.dataTransfer?.files && event.dataTransfer.files.length > 0) {
            event.preventDefault();
            this.isDragOver.set(false);

            if (this.stateService.showingSolution()) {
                this.toaster.showWarning(
                    'TOKEN_TRAIL.MODE_SOLUTION_ACTIVE',
                    'TOKEN_TRAIL.MODE_WARNING_SOLUTION_UPLOAD_RESTRICTION',
                );
                return;
            }

            if (this.stateService.displayMode() === 'puzzle') {
                this.toaster.showWarning(
                    'TOKEN_TRAIL.MODE_WARNING_TITLE',
                    'TOKEN_TRAIL.MODE_WARNING_UPLOAD_RESTRICTION',
                );
                return;
            }

            const file = event.dataTransfer.files[0];
            const fileReader = new FileReader();
            fileReader.onload = (e) => {
                const content = e.target?.result as string;
                if (content) {
                    try {
                        const parsedDiagram = this.parserService.parse(content);
                        if (parsedDiagram) {
                            this.lpnService.loadLpnFromDiagram(parsedDiagram);
                            this.toaster.showSuccess('TOASTER.HEADER.SUCCESS', 'TOASTER.BODY.NET_LOADED_SUCCESSFULLY');
                        } else {
                            this.toaster.showWarning(
                                'TOASTER.HEADER.PARSER_ERROR',
                                'TOASTER.BODY.FILE_NOT_INTERPRETABLE',
                            );
                        }
                    } catch (err) {
                        console.error('Error importing LPN file:', err);
                        this.toaster.showError(
                            'TOASTER.HEADER.PROCESSING_ERROR',
                            'TOASTER.BODY.CRITICAL_PARSING_ERROR',
                        );
                    }
                }
            };
            fileReader.readAsText(file);
            return;
        }

        if (this.stateService.showingSolution()) return;

        if (this.stateService.displayMode() === 'puzzle') {
            this.toaster.showWarning('TOKEN_TRAIL.MODE_WARNING_TITLE', 'TOKEN_TRAIL.MODE_WARNING_PUZZLE_RESTRICTION');
            return;
        }

        event.preventDefault();
        this.isDragOver.set(false);

        // 2. Check for drag data from the global window object (custom drag)
        const dragData = window.__dragData;
        if (dragData) {
            const svgPoint = this.drawingDisplayService.getSvgCoordinates(
                event,
                this.drawingArea.nativeElement as SVGSVGElement,
            );
            if (!svgPoint) {
                return;
            }

            let newNode: LabeledNetNode;
            const elementLabel = dragData.elementLabel || dragData.elementId;
            const elementTokens = dragData.elementTokens ?? 0;

            const isSourceCondition = dragData.elementType === 'place';
            const isSourceEvent = dragData.elementType === 'transition';

            if (isSourceCondition) {
                const conditionId = this.stateService.generateConditionName();
                newNode = this.stateService.buildCondition(conditionId, dragData.elementId, elementTokens, {
                    isStartPlace: this.shouldMarkAsStartCondition(dragData.elementId),
                    innerLabel: dragData.elementId,
                    baseName: conditionId,
                });
                // Set initial trail marking for the source place:
                (newNode as Condition).trailMarkings = { [dragData.elementId]: 1 };
                (newNode as Condition).updateDynamicLabel();
            } else if (isSourceEvent) {
                const uniqueId = this.stateService.generateElementId(`drawn-${dragData.elementId || 'element'}`);
                newNode = this.stateService.buildEvent(uniqueId, elementLabel, elementLabel);
            } else {
                return;
            }

            newNode.x = svgPoint.x;
            newNode.y = svgPoint.y;

            this.stateService.addDrawnElement(newNode);
            this.tourService.notifyElementDropped();

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

        let newNode: LabeledNetNode;
        const isSourceCondition = elementType === 'place';
        const isSourceEvent = elementType === 'transition';

        if (isSourceCondition) {
            const conditionId = this.stateService.generateConditionName();
            newNode = this.stateService.buildCondition(conditionId, undefined, 0, {
                baseName: conditionId,
            });
        } else if (isSourceEvent) {
            const uniqueId = this.stateService.generateElementId('drawn-element');
            newNode = this.stateService.buildEvent(uniqueId, uniqueId, uniqueId);
        } else {
            return;
        }

        newNode.x = svgPoint.x;
        newNode.y = svgPoint.y;

        this.stateService.addDrawnElement(newNode);
        this.tourService.notifyElementDropped();
    }

    /**
     * Mouse down event handler on canvas elements. Handles shift-clicks for debugging,
     * middle clicks for element deletion, and left clicks to initiate dragging.
     */
    onElementMouseDown(event: MouseEvent, element: LabeledNetNode) {
        if (this.stateService.showingSolution()) return;
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
            if (this.stateService.displayMode() === 'puzzle') {
                this.toaster.showWarning(
                    'TOKEN_TRAIL.MODE_WARNING_TITLE',
                    'TOKEN_TRAIL.MODE_WARNING_PUZZLE_RESTRICTION',
                );
                return;
            }
            this.deleteElement(element);
            return;
        }

        // Only start dragging for left mouse button
        if (event.button !== 0) {
            return;
        }

        if (this.stateService.displayMode() === 'puzzle') {
            this.toaster.showWarning('TOKEN_TRAIL.MODE_WARNING_TITLE', 'TOKEN_TRAIL.MODE_WARNING_PUZZLE_RESTRICTION');
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

        const svgPoint = this.drawingDisplayService.getSvgCoordinates(
            event,
            this.drawingArea.nativeElement as SVGSVGElement,
        );
        if (svgPoint) {
            this.dragOffset.x = svgPoint.x - element.x;
            this.dragOffset.y = svgPoint.y - element.y;
        }

        document.addEventListener('mousemove', this.onDocumentMouseMove, true);
        document.addEventListener('mouseup', this.onDocumentMouseUp, true);
    }

    /**
     * Right-click mouse handler on canvas elements. Handles drawing new directed connections
     * between selected conditions and events (or vice versa).
     */
    onElementRightClick(event: MouseEvent, element: LabeledNetNode) {
        if (this.stateService.showingSolution()) return;
        if (this.stateService.displayMode() === 'puzzle') {
            this.toaster.showWarning('TOKEN_TRAIL.MODE_WARNING_TITLE', 'TOKEN_TRAIL.MODE_WARNING_PUZZLE_RESTRICTION');
            return;
        }
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
        if (
            !this.drawingDisplayService.isValidConnectionPair(
                sourceNode instanceof Condition,
                targetNode instanceof Condition,
            )
        ) {
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

    /**
     * Double-click mouse handler on canvas elements. Handles finalization of visual
     * merge groups or unmerging of finalized conditions back into constituent elements.
     */
    onElementDoubleClick(event: MouseEvent, element: LabeledNetNode) {
        if (this.stateService.showingSolution()) return;
        if (this.stateService.displayMode() === 'puzzle') return;
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
                this.shouldMarkAsStartCondition(conditionId, anchorConditionId),
            );
            return;
        }
    }

    // Increment connection weight (used by left click)
    /**
     * Mouse down event handler on connection lines. Handles middle-click connection deletion.
     */
    onConnectionMouseDown(event: MouseEvent, connectionId: string) {
        if (this.stateService.showingSolution()) return;
        if (this.stateService.displayMode() === 'puzzle') {
            if (event.button === 1) {
                event.stopImmediatePropagation();
                event.preventDefault();
                this.toaster.showWarning(
                    'TOKEN_TRAIL.MODE_WARNING_TITLE',
                    'TOKEN_TRAIL.MODE_WARNING_PUZZLE_RESTRICTION',
                );
            }
            return;
        }
        // Middle click deletes connection
        if (event.button === 1) {
            event.stopImmediatePropagation();
            event.preventDefault();
            this.deleteConnection(connectionId);
            return;
        }
    }

    /**
     * Handles mouse wheel events on connection lines to adjust arc weights.
     * Scrolling up increases weight, scrolling down decreases weight (minimum weight is 1).
     */
    onConnectionWheel(event: WheelEvent, connectionId: string) {
        if (this.stateService.showingSolution()) return;
        if (this.stateService.displayMode() === 'puzzle') return;

        event.preventDefault();
        event.stopPropagation();

        const delta = Math.sign(event.deltaY) || 0;
        if (delta === 0) return;

        this.stateService.updateConnections((cs) =>
            cs.map((c) => {
                if (c.id !== connectionId) return c;
                const newWeight = Math.max(1, c.weight - delta);
                return { ...c, weight: newWeight } as LabeledNetEdge;
            }),
        );
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

            // Mark that we dragged
            if (Math.abs(newX - this.draggedElement.x) > 2 || Math.abs(newY - this.draggedElement.y) > 2) {
                this.hasDragged = true;
            }

            this.draggedElement.x = newX;
            this.draggedElement.y = newY;

            if (
                this.draggedElement instanceof Condition &&
                this.dragStartedMergedAnchorId &&
                this.stateService.displayMode() !== 'puzzle'
            ) {
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

        if (releasedElement instanceof Condition && this.hasDragged && this.stateService.displayMode() !== 'puzzle') {
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
        if (this.stateService.showingSolution()) return;
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

    /**
     * Adjusts the token markings on a condition based on a delta (e.g. mousewheel scroll in puzzle mode).
     */
    private handleConditionTokenDelta(condition: Condition, delta: number) {
        this.tourService.notifyTokenAdjusted();
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

    clearDrawing() {
        this.selectedElementId.set(null);
        this.mergeService.clearMergeState();

        this.drawingDisplayService.resetDiagramMarking();

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
        return !!this.elementMetadataMap().get(elementId)?.isInvalid;
    }

    isConnectionInvalid(connectionId: string): boolean {
        return !!this.connectionMetadataMap().get(connectionId)?.isInvalid;
    }

    hasElementIssues(elementId: string): boolean {
        return !!this.elementMetadataMap().get(elementId)?.hasIssues;
    }

    hasConnectionIssues(connectionId: string): boolean {
        return !!this.connectionMetadataMap().get(connectionId)?.hasIssues;
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
                issues = issues.filter((issue) => issue.placeId === selectedPlaceId);
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
        return !!this.elementMetadataMap().get(node.id)?.isMergeAnchor;
    }

    /**
     * Check if a node is currently playing its merge animation.
     * Used by the template to apply CSS animation classes.
     */
    isMergeAnimating(node: LabeledNetNode): boolean {
        return !!this.elementMetadataMap().get(node.id)?.isMergeAnimating;
    }

    /**
     * Get the size of the merge group that this condition belongs to.
     * Used by the template to display the merge count badge.
     */
    getConditionGroupSize(conditionId: string): number {
        return this.elementMetadataMap().get(conditionId)?.groupSize ?? 1;
    }

    // Merge behavior moved to `TokenTrailMergeService`.

    // Helpers for template
    getElementById(id: string): LabeledNetNode | undefined {
        return this.drawnElements().find((e) => e.id === id);
    }

    private getCurrentStartConditionCount(conditionId: string, excludeConditionId?: string): number {
        return this.drawnElements().reduce((count, el) => {
            if (el instanceof Condition && el.isStartPlace && el.id !== excludeConditionId) {
                const markingCount = el.trailMarkings[conditionId] ?? 0;
                return count + markingCount;
            }
            return count;
        }, 0);
    }

    private shouldMarkAsStartCondition(conditionId: string, excludeConditionId?: string): boolean {
        if (!this.drawingDisplayService.isMarkedId(conditionId)) {
            return false;
        }
        return (
            this.getCurrentStartConditionCount(conditionId, excludeConditionId) <
            this.drawingDisplayService.getRequiredStartCount(conditionId)
        );
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

    private toggleSolution(): void {
        const nextShowing = !this.stateService.showingSolution();
        if (nextShowing) {
            if (this.stateService.solutionCache) {
                this.originalDisplayMode = this.stateService.displayMode();
                this.stateService.setDisplayMode('puzzle');
                this.stateService.setSolvedTokenTrails(this.stateService.solutionCache);
                this.stateService.setShowingSolution(true);
                this.toaster.showSuccess('TOKEN_TRAIL.SOLUTION_FOUND_TITLE', 'TOKEN_TRAIL.SOLUTION_FOUND_BODY');
                return;
            }

            const sourceNet = this.validationService.resolveSourceNetForValidation();
            if (!sourceNet) {
                this.toaster.showError('TOKEN_TRAIL.NO_SOURCE_NET_TITLE', 'TOKEN_TRAIL.NO_SOURCE_NET_BODY');
                return;
            }
            this.originalDisplayMode = this.stateService.displayMode();
            this.stateService.setDisplayMode('puzzle');

            const ilpnSource = this.lpnService.convertSourceNetToIlpn(sourceNet);
            const ilpnSpec = this.lpnService.convertLpnToIlpn(this.drawnElements(), this.connections());
            this.loadingService.show();

            this.tokenTrailValidatorService
                .validate(ilpnSource, ilpnSpec)
                .pipe(take(1))
                .subscribe({
                    next: (results) => {
                        this.loadingService.hide();

                        // A solution exists only if every place in the source Petri net has a valid token trail.
                        const allValid = results.every((res) => res.valid);
                        if (!allValid) {
                            if (this.originalDisplayMode) {
                                this.stateService.setDisplayMode(this.originalDisplayMode);
                                this.originalDisplayMode = null;
                            }

                            const placeLabelMap = new Map<string, string>();
                            if (sourceNet) {
                                for (const node of sourceNet.getNodes()) {
                                    if (node.shape === 'circle') {
                                        placeLabelMap.set(node.id, node.displayLabel || node.id);
                                    }
                                }
                            }

                            const invalidPlaces = results
                                .filter((res) => !res.valid)
                                .map((res) => placeLabelMap.get(res.placeId) || res.placeId);

                            this.toaster.showError(
                                'TOKEN_TRAIL.SOLUTION_NOT_FOUND_TITLE',
                                'TOKEN_TRAIL.SOLUTION_NOT_FOUND_BODY',
                                {
                                    messageParams: {
                                        places: invalidPlaces.join(', '),
                                    },
                                },
                            );
                            return;
                        }

                        const solvedTrailsMap = this.lpnService.mapValidatorResultsToSolvedTrails(results);
                        this.stateService.solutionCache = solvedTrailsMap;
                        this.stateService.setSolvedTokenTrails(solvedTrailsMap);
                        this.stateService.setShowingSolution(true);
                        this.toaster.showSuccess('TOKEN_TRAIL.SOLUTION_FOUND_TITLE', 'TOKEN_TRAIL.SOLUTION_FOUND_BODY');
                    },
                    error: (err) => {
                        this.loadingService.hide();
                        if (this.originalDisplayMode) {
                            this.stateService.setDisplayMode(this.originalDisplayMode);
                            this.originalDisplayMode = null;
                        }
                        this.toaster.showError('TOKEN_TRAIL.SOLUTION_ERROR_TITLE', 'TOKEN_TRAIL.SOLUTION_ERROR_BODY');
                        console.error('LPN Solution solver error:', err);
                    },
                });
        } else {
            this.stateService.setShowingSolution(false);
            this.stateService.setSolvedTokenTrails(new Map());
            if (this.originalDisplayMode) {
                this.stateService.setDisplayMode(this.originalDisplayMode);
                this.originalDisplayMode = null;
            }
        }
    }

    private exportLpn(format: 'json' | 'pnml'): void {
        const content = this.serializationService.serializeLpn(this.drawnElements(), this.connections(), format);
        const fileName = `lpn.${format}`;
        const fileType = format === 'pnml' ? 'application/xml' : 'application/json';

        const blob = new Blob([content], { type: fileType });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = fileName;

        document.body.appendChild(a);
        a.click();

        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
    }

    protected shouldShowTooltip(element: LabeledNetNode): boolean {
        return !!this.elementMetadataMap().get(element.id)?.shouldShowTooltip;
    }
}
