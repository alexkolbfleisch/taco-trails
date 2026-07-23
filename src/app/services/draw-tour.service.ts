import { inject, Injectable } from '@angular/core';
import { ShepherdService } from 'angular-shepherd';
import { TranslateService } from '@ngx-translate/core';

@Injectable({
    providedIn: 'root',
})
export class DrawTourService {
    private shepherdService = inject(ShepherdService);
    private translate = inject(TranslateService);

    startTour(restart = false) {
        const completedKey = 'draw-tour-completed';

        if (!restart && localStorage.getItem(completedKey) === 'true') {
            return;
        }

        // Cancel any active tour first
        if (this.shepherdService.isActive) {
            this.shepherdService.cancel();
        }

        // Configure shepherd options
        this.shepherdService.defaultStepOptions = {
            classes: 'shepherd-theme-custom',
            arrow: false,
            scrollTo: { behavior: 'smooth', block: 'center' },
            cancelIcon: {
                enabled: true,
            },
        };
        this.shepherdService.modal = true;
        this.shepherdService.confirmCancel = false;

        const steps = this.getDrawSteps();
        this.shepherdService.addSteps(steps);

        // Track completion or cancellation
        const cleanup = () => {
            localStorage.setItem(completedKey, 'true');
        };

        const tour = this.shepherdService.tourObject;
        if (tour) {
            tour.on('complete', cleanup);
            tour.on('cancel', cleanup);
        }

        this.shepherdService.start();
    }

    private getDrawSteps() {
        return [
            {
                id: 'draw-step-welcome',
                title: this.translate.instant('DRAW.TOUR.WELCOME_TITLE'),
                text: this.translate.instant('DRAW.TOUR.WELCOME_TEXT'),
                buttons: [
                    {
                        type: 'cancel',
                        classes: 'shepherd-button-secondary',
                        text: this.translate.instant('DRAW.TOUR.BUTTON_SKIP'),
                    },
                    {
                        type: 'next',
                        classes: 'shepherd-button-primary',
                        text: this.translate.instant('DRAW.TOUR.BUTTON_NEXT'),
                    },
                ],
            },
            {
                id: 'draw-step-palette',
                attachTo: {
                    element: '.draw-palette',
                    on: 'right' as const,
                },
                title: this.translate.instant('DRAW.TOUR.PALETTE_TITLE'),
                text: this.translate.instant('DRAW.TOUR.PALETTE_TEXT'),
                buttons: this.getDefaultButtons(),
            },
            {
                id: 'draw-step-tuple-input',
                attachTo: {
                    element: '.inline-tuple-input',
                    on: 'right' as const,
                },
                title: this.translate.instant('DRAW.TOUR.TUPLE_INPUT_TITLE'),
                text: this.translate.instant('DRAW.TOUR.TUPLE_INPUT_TEXT'),
                buttons: this.getDefaultButtons(),
            },
            {
                id: 'draw-step-canvas',
                attachTo: {
                    element: '.drawing-canvas',
                    on: 'bottom' as const,
                },
                title: this.translate.instant('DRAW.TOUR.CANVAS_TITLE'),
                text: this.translate.instant('DRAW.TOUR.CANVAS_TEXT'),
                buttons: this.getDefaultButtons(),
            },
            {
                id: 'draw-step-scroll',
                attachTo: {
                    element: '.drawing-canvas',
                    on: 'bottom' as const,
                },
                title: this.translate.instant('DRAW.TOUR.SCROLL_TITLE'),
                text: this.translate.instant('DRAW.TOUR.SCROLL_TEXT'),
                buttons: this.getDefaultButtons(),
            },
            {
                id: 'draw-step-connect',
                attachTo: {
                    element: '.drawing-canvas',
                    on: 'bottom' as const,
                },
                title: this.translate.instant('DRAW.TOUR.CONNECT_TITLE'),
                text: this.translate.instant('DRAW.TOUR.CONNECT_TEXT'),
                buttons: this.getDefaultButtons(),
            },
            {
                id: 'draw-step-upload',
                attachTo: {
                    element: 'app-upload',
                    on: 'left' as const,
                },
                title: this.translate.instant('DRAW.TOUR.UPLOAD_TITLE'),
                text: this.translate.instant('DRAW.TOUR.UPLOAD_TEXT'),
                buttons: this.getDefaultButtons(),
            },
            {
                id: 'draw-step-save',
                attachTo: {
                    element: 'app-save',
                    on: 'left' as const,
                },
                title: this.translate.instant('DRAW.TOUR.SAVE_TITLE'),
                text: this.translate.instant('DRAW.TOUR.SAVE_TEXT'),
                buttons: this.getDefaultButtons(),
            },
            {
                id: 'draw-step-clear',
                attachTo: {
                    element: 'app-clear-net-button',
                    on: 'left' as const,
                },
                title: this.translate.instant('DRAW.TOUR.CLEAR_TITLE'),
                text: this.translate.instant('DRAW.TOUR.CLEAR_TEXT'),
                buttons: this.getDefaultButtons(),
            },
            {
                id: 'draw-step-layout',
                attachTo: {
                    element: 'app-layout-button',
                    on: 'left' as const,
                },
                title: this.translate.instant('DRAW.TOUR.LAYOUT_TITLE'),
                text: this.translate.instant('DRAW.TOUR.LAYOUT_TEXT'),
                buttons: this.getDefaultButtons(),
            },
            {
                id: 'draw-step-example',
                attachTo: {
                    element: 'app-example-menu',
                    on: 'left' as const,
                },
                title: this.translate.instant('DRAW.TOUR.EXAMPLE_TITLE'),
                text: this.translate.instant('DRAW.TOUR.EXAMPLE_TEXT'),
                buttons: this.getDefaultButtons(),
            },
            {
                id: 'draw-step-language',
                attachTo: {
                    element: 'app-language-button',
                    on: 'left' as const,
                },
                title: this.translate.instant('DRAW.TOUR.LANGUAGE_TITLE'),
                text: this.translate.instant('DRAW.TOUR.LANGUAGE_TEXT'),
                buttons: this.getDefaultButtons(),
            },
            {
                id: 'draw-step-focus-mode',
                attachTo: {
                    element: '.tab-presentation-btn',
                    on: 'bottom' as const,
                },
                title: this.translate.instant('DRAW.TOUR.FOCUS_MODE_TITLE'),
                text: this.translate.instant('DRAW.TOUR.FOCUS_MODE_TEXT'),
                buttons: this.getDefaultButtons(),
            },
            {
                id: 'draw-step-finish',
                title: this.translate.instant('DRAW.TOUR.FINISH_TITLE'),
                text: this.translate.instant('DRAW.TOUR.FINISH_TEXT'),
                buttons: [
                    {
                        type: 'next',
                        classes: 'shepherd-button-primary',
                        text: this.translate.instant('DRAW.TOUR.BUTTON_DONE'),
                    },
                ],
            },
        ];
    }

    private getDefaultButtons() {
        return [
            {
                type: 'cancel',
                classes: 'shepherd-button-secondary',
                text: this.translate.instant('DRAW.TOUR.BUTTON_SKIP'),
            },
            {
                type: 'back',
                classes: 'shepherd-button-secondary',
                text: this.translate.instant('DRAW.TOUR.BUTTON_BACK'),
            },
            {
                type: 'next',
                classes: 'shepherd-button-primary',
                text: this.translate.instant('DRAW.TOUR.BUTTON_NEXT'),
            },
        ];
    }
}
