import { Component, ElementRef, ViewChild, effect, inject, signal } from '@angular/core';
import { DisplayComponent } from '../../../display/display.component';
import { SvgNodeComponent } from '../../../display/svg-node/svg-node.component';
import { SvgArcComponent } from '../../../display/svg-arc/svg-arc.component';
import { SHAPE } from '../../../../classes/diagram/diagram-node';
import { DisplayableNode } from '../../../../classes/displayable-graph.interface';
import { TokenTrailStateService, LpnDisplayMode } from '../../../../services/token-trail-state.service';
import { DragDropUtil } from '../../../../utils/drag-drop.util';
import { ToasterNotificationService } from '../../../../services/toaster-notification.service';
import { TokenTrailValidationService, ValidationIssue } from '../../../../services/token-trail-validation.service';
import { ModeService } from '../../../../services/mode.service';
import { ValidationBubbleComponent } from '../token-trail-draw-display/validation-bubble/validation-bubble.component';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslateModule } from '@ngx-translate/core';

@Component({
    selector: 'app-token-trail-display',
    standalone: true,
    imports: [
        SvgNodeComponent,
        SvgArcComponent,
        ValidationBubbleComponent,
        MatIconModule,
        MatButtonModule,
        MatTooltipModule,
        TranslateModule,
    ],
    templateUrl: './token-trail-display.component.html',
    styleUrls: ['./token-trail-display.component.css'],
})
export class TokenTrailDisplayComponent extends DisplayComponent {
    @ViewChild('drawingArea') override drawingArea!: ElementRef<SVGGraphicsElement>;
    private _tokenTrailStateService = inject(TokenTrailStateService);
    private _validationService = inject(TokenTrailValidationService);
    private _toaster = inject(ToasterNotificationService);
    private _modeService = inject(ModeService);

    readonly selectedPetriPlaceId = this._tokenTrailStateService.selectedPetriPlaceId;
    readonly validPetriPlaceIds = this._validationService.validPetriPlaceIds;
    readonly invalidPetriPlaceIds = this._validationService.invalidPetriPlaceIds;

    readonly openBubblePlaceId = signal<string | null>(null);

    constructor() {
        super();
        effect(() => {
            // Close the bubble if the LPN drawing/connections change or validation is re-run
            this._validationService.validationTriggerKey();
            this.openBubblePlaceId.set(null);
        });
        effect(() => {
            // Close the bubble if the display mode changes
            this._tokenTrailStateService.displayMode();
            this.openBubblePlaceId.set(null);
        });
    }

    override processDropEvent(e: DragEvent) {
        super.processDropEvent(e);
    }

    override processNodeClick(node: DisplayableNode) {
        super.processNodeClick(node);

        if (this.canShowValidationInfo(node)) {
            this.togglePlaceBubble(node.id);
        } else {
            this.openBubblePlaceId.set(null);
        }
    }

    togglePlaceBubble(placeId: string) {
        if (this.openBubblePlaceId() === placeId) {
            this.openBubblePlaceId.set(null);
        } else {
            this.openBubblePlaceId.set(placeId);
        }
    }

    canShowValidationInfo(node: DisplayableNode): boolean {
        const isExam = this._modeService.isExamMode(this._tabStateService.currentTab());
        const isConstruction = this._tokenTrailStateService.displayMode() === LpnDisplayMode.Construction;
        const isPuzzle = this._tokenTrailStateService.displayMode() === LpnDisplayMode.Puzzle;
        const hasValidated =
            this._validationService.validationTriggerKey() ===
            this._validationService.lastExplicitValidationTriggerKey();

        return (
            isExam &&
            (isConstruction || isPuzzle) &&
            hasValidated &&
            node.shape === SHAPE.CIRCLE &&
            this.invalidPetriPlaceIds().has(node.id)
        );
    }

    override startPan(e: MouseEvent) {
        super.startPan(e);
        this.openBubblePlaceId.set(null);
    }

    getPlaceIssues(nodeId: string): ValidationIssue[] {
        const result = this._validationService.liveValidation();
        if (!result) return [];
        return result.issues.filter((issue) => issue.placeId === nodeId);
    }

    getNodeFillColor(node: DisplayableNode): string | null {
        if (node.shape !== SHAPE.CIRCLE) {
            return null;
        }
        if (this.validPetriPlaceIds().has(node.id)) {
            return '#d7ffd9'; // Green if valid
        }
        if (this.invalidPetriPlaceIds().has(node.id)) {
            return '#ffd7d7'; // Red if invalid
        }
        return null;
    }

    override prevent(e: DragEvent) {
        super.prevent(e);
    }

    onNodeMouseDown(event: MouseEvent, node: DisplayableNode) {
        // Only start drag if left mouse button
        if (event.button !== 0) {
            return;
        }

        // Keep place selection responsive even when no drag is started.
        if (node.shape === SHAPE.CIRCLE) {
            if (this._tokenTrailStateService.selectedPetriPlaceId() === node.id) {
                this._tokenTrailStateService.setSelectedPetriPlaceId(null);
            } else {
                this._tokenTrailStateService.setSelectedPetriPlaceId(node.id);
            }
        }

        if (this._tokenTrailStateService.displayMode() === LpnDisplayMode.Puzzle) {
            // Only show the warning if the user clicks a transition,
            // since clicking a place is a valid action (selection) in puzzle mode.
            if (node.shape !== SHAPE.CIRCLE) {
                this._toaster.showWarning('TOKEN_TRAIL.MODE_WARNING_TITLE', 'TOKEN_TRAIL.MODE_WARNING_BODY');
            }
            return;
        }

        DragDropUtil.handleNodeMouseDown(event, node);
    }
}
