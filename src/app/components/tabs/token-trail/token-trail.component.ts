import { Component, effect, inject } from '@angular/core';
import { TokenTrailDisplayComponent } from './token-trail-display/token-trail-display.component';
import { TokenTrailDrawDisplayComponent } from './token-trail-draw-display/token-trail-draw-display';
import { SplitViewComponent } from '../../split-view/split-view.component';
import { TabStateService } from '../../../services/tab-state.service';
import { TokenTrailTourService } from '../../../services/token-trail-tour.service';
import { Tab } from '../../../classes/tabs';
import { TokenTrailStateService } from '../../../services/token-trail-state.service';
import { TokenTrailLpnService } from '../../../services/token-trail-lpn.service';
import { TokenTrailGoalsService } from '../../../services/token-trail-goals.service';
import { TokenTrailValidationService } from '../../../services/token-trail-validation.service';

@Component({
    selector: 'app-token-trail',
    standalone: true,
    imports: [TokenTrailDisplayComponent, TokenTrailDrawDisplayComponent, SplitViewComponent],
    templateUrl: './token-trail.component.html',
    styleUrl: './token-trail.component.css',
    providers: [
        TokenTrailStateService,
        TokenTrailLpnService,
        TokenTrailGoalsService,
        TokenTrailValidationService,
        TokenTrailTourService,
    ],
})
export class TokenTrailComponent {
    private _tabStateService = inject(TabStateService);
    private _tourService = inject(TokenTrailTourService);

    constructor() {
        effect(() => {
            if (this._tabStateService.currentTab() === Tab.TOKEN_TRAIL) {
                // Introduce a small timeout to ensure the tab DOM elements are fully rendered and layout settled
                setTimeout(() => {
                    this._tourService.startTour();
                }, 200);
            }
        });
    }
}
