import { Component, ElementRef, inject, signal, ViewChild } from '@angular/core';
import { DisplayService } from '../../services/display.service';
import { SvgNodeComponent } from './svg-node/svg-node.component';
import { SvgArcComponent } from './svg-arc/svg-arc.component';
import { PanningService } from '../../services/panning.service';
import { toSignal } from '@angular/core/rxjs-interop';
import { ToasterNotificationService } from '../../services/toaster-notification.service';

@Component({
    selector: 'app-display',
    standalone: true,
    templateUrl: './display.component.html',
    imports: [SvgNodeComponent, SvgArcComponent],
    styleUrls: ['./display.component.css'],
})
export class DisplayComponent {
    @ViewChild('drawingArea') drawingArea!: ElementRef<SVGGraphicsElement>;

    private _displayService = inject(DisplayService);
    private _panningService = inject(PanningService);
    private _notificationService = inject(ToasterNotificationService);

    readonly isDragOver = signal<boolean>(false);

    readonly viewBox = this._panningService.viewBoxAsString;
    readonly diagram = toSignal(this._displayService.diagram$);

    public processDropEvent(e: DragEvent) {
        e.preventDefault();
        this.isDragOver.set(false);
        if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
            this._notificationService.showWarning(
                'TOASTER.HEADER.UPLOAD_RESTRICTED',
                'TOASTER.BODY.UPLOAD_ONLY_IN_DRAW_TAB',
            );
        }
    }

    public onDragOver(event: DragEvent) {
        const isFileDrag = event.dataTransfer?.types.includes('Files');
        if (isFileDrag) {
            event.preventDefault();
            if (event.dataTransfer) {
                event.dataTransfer.dropEffect = 'copy';
            }
            this.isDragOver.set(true);
        }
    }

    public onDragLeave() {
        this.isDragOver.set(false);
    }

    public prevent(e: DragEvent) {
        e.preventDefault();
    }

    public startPan(event: MouseEvent): void {
        this._panningService.startPan(event, this.drawingArea);
    }

    public pan(event: MouseEvent): void {
        this._panningService.pan(event, this.drawingArea);
    }

    public endPan(): void {
        this._panningService.endPan(this.drawingArea);
    }

    public onWheel(event: WheelEvent): void {
        this._panningService.zoom(event, this.drawingArea);
    }
}
