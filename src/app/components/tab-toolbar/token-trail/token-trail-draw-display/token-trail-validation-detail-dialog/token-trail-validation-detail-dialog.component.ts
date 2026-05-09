import { Component, inject } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { TranslateModule } from '@ngx-translate/core';
import { ValidationIssue } from '../../../../../services/token-trail-validation.service';
import { MatIconModule } from '@angular/material/icon';

export interface ValidationDetailDialogData {
    title: string;
    issues: ValidationIssue[];
}

@Component({
    selector: 'app-token-trail-validation-detail-dialog',
    standalone: true,
    imports: [MatDialogModule, MatButtonModule, TranslateModule, MatIconModule],
    templateUrl: './token-trail-validation-detail-dialog.component.html',
    styleUrls: ['./token-trail-validation-detail-dialog.component.css']
})
export class TokenTrailValidationDetailDialogComponent {
    public data: ValidationDetailDialogData = inject(MAT_DIALOG_DATA);
    public groupedIssues: { rule: string; issues: ValidationIssue[] }[] = [];

    constructor() {
        const grouped = this.data.issues.reduce((acc, issue) => {
            if (!acc[issue.rule]) {
                acc[issue.rule] = [];
            }
            acc[issue.rule].push(issue);
            return acc;
        }, {} as Record<string, ValidationIssue[]>);

        this.groupedIssues = Object.keys(grouped).map(rule => ({
            rule,
            issues: grouped[rule]
        }));
    }
}
