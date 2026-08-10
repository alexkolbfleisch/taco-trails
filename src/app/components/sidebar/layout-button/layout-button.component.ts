import { Component, computed, inject } from '@angular/core';
import { MatIcon } from '@angular/material/icon';
import { MatIconButton } from '@angular/material/button';
import { MatTooltip } from '@angular/material/tooltip';
import { MatMenu, MatMenuItem, MatMenuTrigger } from '@angular/material/menu';
import { TranslateModule } from '@ngx-translate/core';
import { DisplayService } from '../../../services/display.service';
import { toSignal } from '@angular/core/rxjs-interop';
import { LayoutCalculationService } from '../../../services/layout-calculation.service';

@Component({
    selector: 'app-layout-button',
    standalone: true,
    imports: [MatIcon, MatIconButton, MatTooltip, MatMenu, MatMenuItem, MatMenuTrigger, TranslateModule],
    templateUrl: './layout-button.component.html',
    styleUrl: './layout-button.component.css',
})
export class LayoutButtonComponent {
    private _layoutService = inject(LayoutCalculationService);
    private _displayService = inject(DisplayService);

    private _diagramSignal = toSignal(this._displayService.diagram$);

    public isDisabled = computed(() => !this._diagramSignal() || this._layoutService.isCalculating());

    public calculateSpringEmbedderLayout(): void {
        this._layoutService.calculateSpringEmbedderLayout();
    }

    public calculateSugiyamaLayout(): void {
        this._layoutService.calculateSugiyamaLayout();
    }
}
