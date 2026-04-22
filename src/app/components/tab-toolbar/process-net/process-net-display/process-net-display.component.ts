import { Component, ElementRef, ViewChild } from '@angular/core';
import { DisplayComponent } from '../../../display/display.component';
import { SvgNodeComponent } from '../../../display/svg-node/svg-node.component';
import { SvgArcComponent } from '../../../display/svg-arc/svg-arc.component';
import { DisplayableNode } from '../../../../classes/displayable-graph.interface';
import { DragDropUtil } from '../../../../utils/drag-drop.util';

@Component({
    selector: 'app-process-net-display',
    standalone: true,
    imports: [SvgNodeComponent, SvgArcComponent],
    templateUrl: './process-net-display.component.html',
    styleUrls: ['./process-net-display.component.css'],
})
export class ProcessNetDisplayComponent extends DisplayComponent {
    @ViewChild('drawingArea') override drawingArea!: ElementRef<SVGGraphicsElement>;

    override processDropEvent(e: DragEvent) {
        super.processDropEvent(e);
    }

    override prevent(e: DragEvent) {
        super.prevent(e);
    }

    onNodeMouseDown(event: MouseEvent, node: DisplayableNode) {
        DragDropUtil.handleNodeMouseDown(event, node);
    }
}
