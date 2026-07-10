import { Component, inject } from '@angular/core';
import { PetriNetLoaderService } from '../../../services/petri-net-loader.service';
import { MatIcon } from '@angular/material/icon';
import { MatIconButton } from '@angular/material/button';
import { MatTooltip } from '@angular/material/tooltip';
import { TranslateModule } from '@ngx-translate/core';
import { MatMenu, MatMenuItem, MatMenuTrigger } from '@angular/material/menu';

@Component({
    selector: 'app-upload',
    imports: [MatIcon, MatIconButton, MatTooltip, TranslateModule, MatMenu, MatMenuItem, MatMenuTrigger],
    templateUrl: './upload.component.html',
    styleUrl: './upload.component.css',
})
export class UploadComponent {
    private _loaderService = inject(PetriNetLoaderService);

    public onPetriFileSelected(event: Event): void {
        const file = (event.target as HTMLInputElement).files?.[0];
        if (file) this._loaderService.loadFile(file);
        (event.target as HTMLInputElement).value = '';
    }

    public onLpnFileSelected(event: Event): void {
        const file = (event.target as HTMLInputElement).files?.[0];
        if (file) this._loaderService.loadLpnFile(file);
        (event.target as HTMLInputElement).value = '';
    }
}
