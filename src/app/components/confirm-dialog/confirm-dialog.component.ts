import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { TranslateModule } from '@ngx-translate/core';
import { Tab } from '../../classes/tabs';
import { DrawService } from '../../services/draw.service';
import { ReachabilityGraphService } from '../../reachability-graph.service';
import { ProcessNetFiringService } from '../../services/process-net-firing.service';
import { ModeService } from '../../services/mode.service';
import { TokenTrailStateService } from '../../services/token-trail-state.service';

export interface ConfirmDialogData {
    title: string;
    tab: Tab;
    message: string;
}

@Component({
    selector: 'app-confirm-dialog',
    standalone: true,
    imports: [CommonModule, MatDialogModule, MatButtonModule, TranslateModule],
    templateUrl: './confirm-dialog.component.html',
    styleUrls: ['./confirm-dialog.component.css'],
})
export class ConfirmDialogComponent {
    readonly data = inject<ConfirmDialogData>(MAT_DIALOG_DATA);
    private readonly _dialogRef = inject(MatDialogRef<ConfirmDialogComponent>);

    private readonly processNetFiringService = inject(ProcessNetFiringService);
    private readonly reachabilityGraphService = inject(ReachabilityGraphService);
    private readonly drawService = inject(DrawService);
    private readonly modeService = inject(ModeService);
    private readonly tokenTrailStateService = inject(TokenTrailStateService);

    keep() {
        this._dialogRef.close('keep');
    }

    discard() {
        switch (this.data.tab) {
            case Tab.DRAW:
                this.drawService.clearCanvas();
                break;
            case Tab.PROCESS_NET:
                this.processNetFiringService.clear(this.modeService.getMode(this.data.tab));
                break;
            case Tab.REACHABILITY_GRAPH:
                this.reachabilityGraphService.clear();
                break;
            case Tab.TOKEN_TRAIL:
                this.tokenTrailStateService.clear();
                break;
            default:
                break;
        }
        this._dialogRef.close('discard');
    }
}
