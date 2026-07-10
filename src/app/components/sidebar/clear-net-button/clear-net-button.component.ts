import { Component, computed, inject } from '@angular/core';
import { MatIconButton } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';
import { SourcePetriNetService } from '../../../services/source-petri-net.service';
import { DisplayService } from '../../../services/display.service';
import { MatTooltip } from '@angular/material/tooltip';
import { toSignal } from '@angular/core/rxjs-interop';
import { TranslateModule } from '@ngx-translate/core';
import { TokenTrailStateService } from '../../../services/token-trail-state.service';

@Component({
    selector: 'app-clear-net-button',
    standalone: true,
    imports: [MatIconButton, MatIcon, MatTooltip, TranslateModule],
    templateUrl: './clear-net-button.component.html',
    styleUrls: ['./clear-net-button.component.css'],
})
export class ClearNetButtonComponent {
    private _sourcePetriNetService = inject(SourcePetriNetService);
    private _displayService = inject(DisplayService);
    private _tokenTrailStateService = inject(TokenTrailStateService);
    private _diagramSignal = toSignal(this._displayService.diagram$);
    private _sourceNetSignal = toSignal(this._sourcePetriNetService.sourceNet$);
    private _sourceTextSignal = toSignal(this._sourcePetriNetService.sourceText$);
    public isDisabled = computed(() => {
        const hasDiagram = !!this._diagramSignal();
        const hasSourceNet = !!this._sourceNetSignal();
        const hasSourceText = !!this._sourceTextSignal()?.trim();
        return !hasDiagram && !hasSourceNet && !hasSourceText;
    });

    public clearNet(): void {
        this._sourcePetriNetService.clear();
        this._displayService.clear();
        this._tokenTrailStateService.clear();
    }
}
