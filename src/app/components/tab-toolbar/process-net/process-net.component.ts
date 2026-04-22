import { Component } from '@angular/core';
import { ProcessNetDisplayComponent } from './process-net-display/process-net-display.component';
import { ProcessNetDrawDisplayComponent } from './process-net-draw-display/process-net-draw-display';
import { SplitViewComponent } from '../../split-view/split-view.component';

@Component({
    selector: 'app-process-net',
    standalone: true,
    imports: [ProcessNetDisplayComponent, ProcessNetDrawDisplayComponent, SplitViewComponent],
    templateUrl: './process-net.component.html',
    styleUrls: ['./process-net.component.css'],
})
export class ProcessNetComponent {}
