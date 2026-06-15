import { Component, ElementRef, ViewChild } from '@angular/core';
import { DisplayComponent } from '../../../display/display.component';
import { SvgNodeComponent } from '../../../display/svg-node/svg-node.component';
import { SvgArcComponent } from '../../../display/svg-arc/svg-arc.component';
import { SHAPE } from '../../../../classes/diagram/diagram-node';
import { DisplayableNode } from '../../../../classes/displayable-graph.interface';
import { inject } from '@angular/core';
import { TokenTrailStateService, LpnDisplayMode } from '../../../../services/token-trail-state.service';
import { DragDropUtil } from '../../../../utils/drag-drop.util';
import { ToasterNotificationService } from '../../../../services/toaster-notification.service';
import { TokenTrailValidationService } from '../../../../services/token-trail-validation.service';

@Component({
    selector: 'app-token-trail-display',
    standalone: true,
    imports: [SvgNodeComponent, SvgArcComponent],
    templateUrl: './token-trail-display.component.html',
    styleUrls: ['./token-trail-display.component.css'],
})
export class TokenTrailDisplayComponent extends DisplayComponent {
    @ViewChild('drawingArea') override drawingArea!: ElementRef<SVGGraphicsElement>;
    private _tokenTrailStateService = inject(TokenTrailStateService);
    private _validationService = inject(TokenTrailValidationService);
    private _toaster = inject(ToasterNotificationService);
    readonly selectedPetriPlaceId = this._tokenTrailStateService.selectedPetriPlaceId;
    readonly validPetriPlaceIds = this._validationService.validPetriPlaceIds;
    readonly invalidPetriPlaceIds = this._validationService.invalidPetriPlaceIds;

    override processDropEvent(e: DragEvent) {
        super.processDropEvent(e);
    }

    override processNodeClick(node: DisplayableNode) {
        super.processNodeClick(node);
        // Selection is now handled in onNodeMouseDown to prevent double-toggling
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
