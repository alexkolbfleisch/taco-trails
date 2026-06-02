import { Component, input, output } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { ValidationIssue } from '../../../../../classes/token-trail.model';

@Component({
    selector: 'app-validation-bubble',
    standalone: true,
    imports: [TranslateModule, MatIconModule, MatButtonModule],
    templateUrl: './validation-bubble.component.html',
    styleUrls: ['./validation-bubble.component.css'],
})
export class ValidationBubbleComponent {
    issues = input.required<ValidationIssue[]>();
    isConnection = input<boolean>(false);
    closeBubble = output<void>();
}
