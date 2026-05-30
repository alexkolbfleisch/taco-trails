import { Component, ElementRef, inject, ViewChild } from '@angular/core';
import { DisplayComponent } from '../../../display/display.component';
import { SvgNodeComponent } from '../../../display/svg-node/svg-node.component';
import { SvgArcComponent } from '../../../display/svg-arc/svg-arc.component';
import { DisplayableNode } from '../../../../classes/displayable-graph.interface';
import { DragDropUtil } from '../../../../utils/drag-drop.util';
import { ToasterNotificationService } from '../../../../services/toaster-notification.service';

@Component({
    selector: 'app-process-net-display',
    standalone: true,
    imports: [SvgNodeComponent, SvgArcComponent],
    templateUrl: './process-net-display.component.html',
    styleUrls: ['./process-net-display.component.css'],
})
export class ProcessNetDisplayComponent extends DisplayComponent {
    @ViewChild('drawingArea') override drawingArea!: ElementRef<SVGGraphicsElement>;
    private _toaster = inject(ToasterNotificationService);

    override processDropEvent(e: DragEvent) {
        e.preventDefault();
        this.isDragOver.set(false);
        if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
            this._toaster.showWarning('TOASTER.HEADER.UPLOAD_RESTRICTED', 'TOASTER.BODY.UPLOAD_PROCESS_NET_RESTRICTED');
        }
    }

    onNodeMouseDown(event: MouseEvent, node: DisplayableNode) {
        DragDropUtil.handleNodeMouseDown(event, node);
    }
}
