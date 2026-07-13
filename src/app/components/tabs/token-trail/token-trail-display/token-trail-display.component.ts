import { Component, ElementRef, ViewChild, inject, computed, signal } from '@angular/core';
import { DisplayComponent } from '../../../display/display.component';
import { SvgNodeComponent } from '../../../display/svg-node/svg-node.component';
import { SvgArcComponent } from '../../../display/svg-arc/svg-arc.component';
import { SHAPE } from '../../../../classes/diagram/diagram-node';
import { DisplayableNode } from '../../../../classes/displayable-graph.interface';
import { TokenTrailStateService, LpnDisplayMode } from '../../../../services/token-trail-state.service';
import { DragDropUtil } from '../../../../utils/drag-drop.util';
import { ToasterNotificationService } from '../../../../services/toaster-notification.service';
import { TokenTrailValidationService } from '../../../../services/token-trail-validation.service';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslateModule } from '@ngx-translate/core';

@Component({
    selector: 'app-token-trail-display',
    standalone: true,
    imports: [SvgNodeComponent, SvgArcComponent, MatIconModule, MatButtonModule, MatTooltipModule, TranslateModule],
    templateUrl: './token-trail-display.component.html',
    styleUrls: ['./token-trail-display.component.css'],
})
export class TokenTrailDisplayComponent extends DisplayComponent {
    @ViewChild('drawingArea') override drawingArea!: ElementRef<SVGGraphicsElement>;
    private _tokenTrailStateService = inject(TokenTrailStateService);
    private _validationService = inject(TokenTrailValidationService);
    private _toaster = inject(ToasterNotificationService);

    readonly selectedPetriPlaceId = this._tokenTrailStateService.selectedPetriPlaceId;
    readonly heldPetriPlaceId = this._tokenTrailStateService.heldPetriPlaceId;
    readonly validPetriPlaceIds = this._validationService.validPetriPlaceIds;
    readonly invalidPetriPlaceIds = this._validationService.invalidPetriPlaceIds;

    readonly showEmptyPlace = computed(() => {
        return this._tokenTrailStateService.displayMode() === LpnDisplayMode.Construction;
    });

    onEmptyPlaceMouseDown(event: MouseEvent) {
        const simulatedNode: DisplayableNode = {
            id: '__empty__',
            shape: SHAPE.CIRCLE,
            displayLabel: '',
            tokenCount: signal(0),
            x: 0,
            y: 0,
        };
        DragDropUtil.handleNodeMouseDown(event, simulatedNode);
    }

    constructor() {
        super();
    }

    override processDropEvent(e: DragEvent) {
        super.processDropEvent(e);
    }

    getNodeFillColor(node: DisplayableNode): string | null {
        if (node.shape !== SHAPE.CIRCLE) {
            return null;
        }
        if (this._tokenTrailStateService.showingSolution()) {
            return this.validPetriPlaceIds().has(node.id) ? '#d7ffd9' : '#ffe0b2'; // Green if already correct, yellow/orange if not yet correct
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
            // Set the held place ID
            this._tokenTrailStateService.heldPetriPlaceId.set(node.id);

            // Register global listeners to release the held place
            const onGlobalMouseUp = () => {
                this._tokenTrailStateService.heldPetriPlaceId.set(null);
                document.removeEventListener('mouseup', onGlobalMouseUp);
                window.removeEventListener('blur', onGlobalMouseUp);
            };
            document.addEventListener('mouseup', onGlobalMouseUp);
            window.addEventListener('blur', onGlobalMouseUp);

            if (this._tokenTrailStateService.displayMode() === LpnDisplayMode.Puzzle) {
                if (this._tokenTrailStateService.selectedPetriPlaceId() === node.id) {
                    this._tokenTrailStateService.setSelectedPetriPlaceId(null);
                } else {
                    this._tokenTrailStateService.setSelectedPetriPlaceId(node.id);
                }
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
