import { Component, inject } from '@angular/core';
import { MatIcon } from '@angular/material/icon';
import { MatIconButton } from '@angular/material/button';
import { MatTooltip } from '@angular/material/tooltip';
import { TranslateModule, TranslateService } from '@ngx-translate/core';

export enum Language {
    EN = 'en',
    DE = 'de',
}

@Component({
    selector: 'app-language-button',
    imports: [MatIcon, MatIconButton, MatTooltip, TranslateModule],
    templateUrl: './language-button.component.html',
    styleUrl: './language-button.component.css',
})
export class LanguageButtonComponent {
    private _translationService = inject(TranslateService);

    protected currentLanguage: Language;

    constructor() {
        const browserLang = this._translationService.getBrowserLang();
        this.currentLanguage = browserLang === Language.DE ? Language.DE : Language.EN;
        this._translationService.use(this.currentLanguage);
    }

    protected switchLanguage() {
        this.currentLanguage = this.currentLanguage === Language.DE ? Language.EN : Language.DE;
        this._translationService.use(this.currentLanguage);
    }

    protected color() {
        return this.currentLanguage === Language.DE ? 'primary' : 'accent';
    }
}
