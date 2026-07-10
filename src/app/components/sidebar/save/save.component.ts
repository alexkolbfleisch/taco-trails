import { Component, computed, inject } from '@angular/core';
import { MatIcon } from '@angular/material/icon';
import { PetriNetSavingService } from '../../../services/petri-net-saving.service';
import { MatMenu, MatMenuItem, MatMenuTrigger } from '@angular/material/menu';
import { MatIconButton } from '@angular/material/button';
import { MatTooltip } from '@angular/material/tooltip';
import { TranslateModule } from '@ngx-translate/core';
import { DisplayService } from '../../../services/display.service';
import { toSignal } from '@angular/core/rxjs-interop';

@Component({
    selector: 'app-save',
    imports: [MatIcon, MatMenu, MatMenuItem, MatMenuTrigger, MatIconButton, MatTooltip, TranslateModule],
    templateUrl: './save.component.html',
    styleUrl: './save.component.css',
})
export class SaveComponent {
    private _petriNetSavingService = inject(PetriNetSavingService);
    private _displayService = inject(DisplayService);
    private _diagramSignal = toSignal(this._displayService.diagram$);
    public isDisabled = computed(() => !this._diagramSignal());

    protected onSave(format: 'json' | 'pnml') {
        this._petriNetSavingService.savePetriNet(format);
    }
}
