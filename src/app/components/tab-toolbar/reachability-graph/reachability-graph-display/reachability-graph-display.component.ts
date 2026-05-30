import { Component, inject } from '@angular/core';
import { DisplayComponent } from '../../../display/display.component';
import { SvgNodeComponent } from '../../../display/svg-node/svg-node.component';
import { SvgArcComponent } from '../../../display/svg-arc/svg-arc.component';
import { ToasterNotificationService } from '../../../../services/toaster-notification.service';

//Inherited from process-net-display // display-component

@Component({
    selector: 'app-reachability-graph-display',
    standalone: true,
    imports: [SvgNodeComponent, SvgArcComponent],
    templateUrl: './reachability-graph-display.component.html',
    styleUrl: './reachability-graph-display.component.css',
})
export class ReachabilityGraphDisplayComponent extends DisplayComponent {
    private _toaster = inject(ToasterNotificationService);

    readonly isDisabled = this._reachabilityGraphService.showingCompleteGraph;

    override processDropEvent(e: DragEvent) {
        e.preventDefault();
        this.isDragOver.set(false);
        if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
            this._toaster.showWarning('TOASTER.HEADER.UPLOAD_RESTRICTED', 'TOASTER.BODY.UPLOAD_RG_RESTRICTED');
        }
    }

    handleDisabledClick(event: Event) {
        event.stopPropagation();
        event.preventDefault();
        this._toaster.showInfo('TOASTER.HEADER.RG_INFO', 'TOASTER.BODY.SWITCH_BACK_TO_USER_GRAPH');
    }
}
