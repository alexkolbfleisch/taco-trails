import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { TranslateModule } from '@ngx-translate/core';
import { Tab } from '../../../classes/tabs';

export interface ConfirmDialogData {
    title: string;
    tab: Tab;
    message: string;
    onDiscard?: () => void;
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

    keep() {
        this._dialogRef.close('keep');
    }

    discard() {
        if (this.data.onDiscard) {
            this.data.onDiscard();
        }
        this._dialogRef.close('discard');
    }
}
