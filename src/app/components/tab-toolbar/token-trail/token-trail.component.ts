import { Component } from '@angular/core';
import { TokenTrailDisplayComponent } from './token-trail-display/token-trail-display.component';
import { TokenTrailDrawDisplayComponent } from './token-trail-draw-display/token-trail-draw-display';

@Component({
    selector: 'app-token-trail',
    standalone: true,
    imports: [TokenTrailDisplayComponent, TokenTrailDrawDisplayComponent],
    templateUrl: './token-trail.component.html',
    styleUrl: './token-trail.component.css',
})
export class TokenTrailComponent {}
