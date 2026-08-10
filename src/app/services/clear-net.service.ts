import { inject, Injectable } from '@angular/core';
import { SourcePetriNetService } from './source-petri-net.service';
import { DisplayService } from './display.service';
import { TabStateService } from './tab-state.service';
import { TokenTrailStateService } from './token-trail-state.service';

@Injectable({
    providedIn: 'root',
})
export class ClearNetService {
    private _sourcePetriNetService = inject(SourcePetriNetService);
    private _displayService = inject(DisplayService);
    private _tabStateService = inject(TabStateService);
    private _tokenTrailStateService = inject(TokenTrailStateService);

    public clearNet(): void {
        this._sourcePetriNetService.clear();
        this._displayService.clear();
        const stateService = this._tabStateService.activeTokenTrailStateService || this._tokenTrailStateService;
        stateService.clear();
    }
}
