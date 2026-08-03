import { Component, inject, OnInit, HostListener, effect } from '@angular/core';
import { MatTabChangeEvent, MatTabsModule } from '@angular/material/tabs';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { DrawComponent } from '../tabs/draw/draw.component';
import { TokenTrailComponent } from '../tabs/token-trail/token-trail.component';
import { TokenTrailPracticeComponent } from '../tabs/token-trail/token-trail-practice.component';
import { Tab } from '../../classes/tabs';
import { Diagram } from '../../classes/diagram/diagram';
import { TabStateService } from '../../services/tab-state.service';
import { SourcePetriNetService } from '../../services/source-petri-net.service';
import { DisplayService } from '../../services/display.service';
import { SaveComponent } from '../sidebar/save/save.component';
import { UploadComponent } from '../sidebar/upload/upload.component';
import { ClearNetButtonComponent } from '../sidebar/clear-net-button/clear-net-button.component';
import { LayoutButtonComponent } from '../sidebar/layout-button/layout-button.component';
import { LanguageButtonComponent } from '../sidebar/language-button/language-button.component';
import { ExampleMenuComponent } from '../sidebar/example-menu/example-menu.component';
import { TranslateModule } from '@ngx-translate/core';

@Component({
    selector: 'app-main-tab',
    standalone: true,
    imports: [
        MatTabsModule,
        MatIconModule,
        MatButtonModule,
        MatTooltipModule,
        DrawComponent,
        TokenTrailComponent,
        TokenTrailPracticeComponent,
        SaveComponent,
        UploadComponent,
        ClearNetButtonComponent,
        MatButtonModule,
        LayoutButtonComponent,
        LanguageButtonComponent,
        ExampleMenuComponent,
        TranslateModule,
    ],
    templateUrl: './main-tab.component.html',
    styleUrl: './main-tab.component.css',
})
export class MainTabComponent implements OnInit {
    protected _tabStateService: TabStateService = inject(TabStateService);
    private _sourcePetriNetService: SourcePetriNetService = inject(SourcePetriNetService);
    private _displayService: DisplayService = inject(DisplayService);
    private readonly _tabs: Tab[] = [Tab.DRAW, Tab.TOKEN_TRAIL, Tab.PRACTICE];

    selectedIndex = Tab.DRAW; // Select which tab to show by default

    constructor() {
        effect(() => {
            const isPresentation = this._tabStateService.isPresentationMode();
            if (isPresentation) {
                document.body.classList.add('presentation-mode');
                document.documentElement.classList.add('presentation-mode');
            } else {
                document.body.classList.remove('presentation-mode');
                document.documentElement.classList.remove('presentation-mode');
            }
        });
    }

    @HostListener('document:keydown.escape')
    onEscapePress() {
        if (this._tabStateService.isPresentationMode()) {
            this._tabStateService.isPresentationMode.set(false);
        }
    }

    protected togglePresentationMode(event: Event) {
        event.stopPropagation();
        this._tabStateService.togglePresentationMode();
    }

    ngOnInit(): void {
        this._tabStateService.switchTo(this._tabs[this.selectedIndex]);
    }

    onTabChange(event: MatTabChangeEvent) {
        this.selectedIndex = event.index;
        this._tabStateService.switchTo(this._tabs[event.index]);

        const diagram = this._displayService.diagram;
        if (!diagram || !(diagram instanceof Diagram)) return;
        this._sourcePetriNetService.updateEditedNet(diagram, { triggeredByFiring: false });
    }

    protected startTour() {
        this._tabStateService.activeTourService?.startTour(true);
    }
}
