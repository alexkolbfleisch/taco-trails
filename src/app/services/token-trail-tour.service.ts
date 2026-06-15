import { inject, Injectable, signal } from '@angular/core';
import { ShepherdService } from 'angular-shepherd';
import { PetriNetLoaderService } from './petri-net-loader.service';
import { TokenTrailStateService, LpnDisplayMode } from './token-trail-state.service';
import { TranslateService } from '@ngx-translate/core';
import { Diagram } from '../classes/diagram/diagram';
import { DisplayService } from './display.service';
import { SourcePetriNetService } from './source-petri-net.service';
import { TabStateService } from './tab-state.service';
import { PanningService } from './panning.service';
import { TokenTrailLpnService } from './token-trail-lpn.service';
import { TokenTrailValidationService } from './token-trail-validation.service';

@Injectable({
    providedIn: 'root',
})
export class TokenTrailTourService {
    private shepherdService = inject(ShepherdService);
    private loaderService = inject(PetriNetLoaderService);
    private stateService = inject(TokenTrailStateService);
    private translate = inject(TranslateService);
    private displayService = inject(DisplayService);
    private sourceNetService = inject(SourcePetriNetService);
    private tabStateService = inject(TabStateService);
    private panningService = inject(PanningService);
    private lpnService = inject(TokenTrailLpnService);
    private validationService = inject(TokenTrailValidationService);

    private backedUpNet: Diagram | null = null;
    private backedUpText = '';

    readonly tokenCountChangedInTour = signal<boolean>(false);
    readonly elementDroppedInTour = signal<boolean>(false);
    readonly conditionMergedInTour = signal<boolean>(false);
    readonly conditionUnmergedInTour = signal<boolean>(false);
    readonly isTourRunning = signal<boolean>(false);
    readonly currentStepId = signal<string | null>(null);

    startTour(restart = false) {
        if (!restart && localStorage.getItem('token-trail-tour-completed') === 'true') {
            return;
        }

        // Cancel any active tour first
        if (this.shepherdService.isActive) {
            this.shepherdService.cancel();
        }

        this.isTourRunning.set(true);
        this.tokenCountChangedInTour.set(false);
        this.conditionMergedInTour.set(false);
        this.conditionUnmergedInTour.set(false);

        // Back up the current net and text if they exist
        const currentNet = this.sourceNetService.getCurrentSourceNet();
        if (currentNet && currentNet.allNodes.length > 0) {
            this.backedUpNet = currentNet;
            this.backedUpText = this.sourceNetService.getSourceText();
        } else {
            this.backedUpNet = null;
            this.backedUpText = '';
        }

        // Always load the example net for the tour so the tour runs on a known net structure
        this.loaderService.loadFileFromUrl('assets/examples/example.json');

        // Configure shepherd options
        this.shepherdService.defaultStepOptions = {
            classes: 'shepherd-theme-custom',
            scrollTo: { behavior: 'smooth', block: 'center' },
            cancelIcon: {
                enabled: true,
            },
        };
        this.shepherdService.modal = true;
        this.shepherdService.confirmCancel = false;

        const steps = [
            {
                id: 'step-welcome',
                title: this.translate.instant('TOKEN_TRAIL.TOUR.STEP1_TITLE'),
                text: this.translate.instant('TOKEN_TRAIL.TOUR.STEP1_TEXT'),
                buttons: [
                    {
                        type: 'cancel',
                        classes: 'shepherd-button-secondary',
                        text: this.translate.instant('TOKEN_TRAIL.TOUR.BUTTON_SKIP'),
                    },
                    {
                        type: 'next',
                        classes: 'shepherd-button-primary',
                        text: this.translate.instant('TOKEN_TRAIL.TOUR.BUTTON_NEXT'),
                    },
                ],
            },
            {
                id: 'step-layout',
                attachTo: {
                    element: 'app-split-view',
                    on: 'bottom' as const,
                },
                title: this.translate.instant('TOKEN_TRAIL.TOUR.STEP2_TITLE'),
                text: this.translate.instant('TOKEN_TRAIL.TOUR.STEP2_TEXT'),
                buttons: [
                    {
                        type: 'cancel',
                        classes: 'shepherd-button-secondary',
                        text: this.translate.instant('TOKEN_TRAIL.TOUR.BUTTON_SKIP'),
                    },
                    {
                        type: 'back',
                        classes: 'shepherd-button-secondary',
                        text: this.translate.instant('TOKEN_TRAIL.TOUR.BUTTON_BACK'),
                    },
                    {
                        type: 'next',
                        classes: 'shepherd-button-primary',
                        text: this.translate.instant('TOKEN_TRAIL.TOUR.BUTTON_NEXT'),
                    },
                ],
            },
            {
                id: 'step-puzzle',
                attachTo: {
                    element: 'app-split-view',
                    on: 'top' as const,
                },
                title: this.translate.instant('TOKEN_TRAIL.TOUR.STEP3_TITLE'),
                text: this.translate.instant('TOKEN_TRAIL.TOUR.STEP3_TEXT'),
                when: {
                    show: () => {
                        this.stateService.setDisplayMode(LpnDisplayMode.Puzzle);
                        this.tokenCountChangedInTour.set(false);

                        // Regenerate LPN if it was cleared during the tour steps
                        const sourceNet = this.validationService.resolveSourceNetForValidation();
                        if (sourceNet && this.stateService.drawnElements().length === 0) {
                            this.lpnService.createLPNWithSynthesis(sourceNet);
                        }

                        // Auto pre-select the first place from the diagram if none is currently selected
                        const currentSelect = this.stateService.selectedPetriPlaceId();
                        if (!currentSelect) {
                            const diag = this.displayService.diagram;
                            if (diag && diag instanceof Diagram) {
                                const places = diag.places;
                                if (places && places.length > 0) {
                                    this.stateService.setSelectedPetriPlaceId(places[0].id);
                                }
                            }
                        }

                        // Force button to be disabled initially (even if we returned from a later step)
                        setTimeout(() => {
                            const step = this.shepherdService.tourObject?.getCurrentStep();
                            if (step) {
                                step.updateStepOptions({
                                    buttons: this.getStepPuzzleButtons(true),
                                });
                            }
                        }, 50);
                    },
                },
                buttons: this.getStepPuzzleButtons(true),
            },
            {
                id: 'step-synthesize',
                attachTo: {
                    element: 'button[data-tour="science"]',
                    on: 'bottom' as const,
                },
                title: this.translate.instant('TOKEN_TRAIL.TOUR.STEP_SYNTHESIZE_TITLE'),
                text: this.translate.instant('TOKEN_TRAIL.TOUR.STEP_SYNTHESIZE_TEXT'),
                beforeShowPromise: () => {
                    return new Promise<void>((resolve) => {
                        this.stateService.setDisplayMode(LpnDisplayMode.Puzzle);
                        // Regenerate LPN if it was cleared
                        const sourceNet = this.validationService.resolveSourceNetForValidation();
                        if (sourceNet && this.stateService.drawnElements().length === 0) {
                            this.lpnService.createLPNWithSynthesis(sourceNet);
                        }
                        setTimeout(() => {
                            resolve();
                        }, 50);
                    });
                },
                buttons: [
                    {
                        type: 'cancel',
                        classes: 'shepherd-button-secondary',
                        text: this.translate.instant('TOKEN_TRAIL.TOUR.BUTTON_SKIP'),
                    },
                    {
                        type: 'back',
                        classes: 'shepherd-button-secondary',
                        text: this.translate.instant('TOKEN_TRAIL.TOUR.BUTTON_BACK'),
                    },
                    {
                        type: 'next',
                        classes: 'shepherd-button-primary',
                        text: this.translate.instant('TOKEN_TRAIL.TOUR.BUTTON_NEXT'),
                    },
                ],
            },
            {
                id: 'step-puzzle-solution',
                attachTo: {
                    element: 'button[data-tour="lightbulb_outline"]',
                    on: 'bottom' as const,
                },
                title: this.translate.instant('TOKEN_TRAIL.TOUR.STEP_PUZZLE_SOLUTION_TITLE'),
                text: this.translate.instant('TOKEN_TRAIL.TOUR.STEP_PUZZLE_SOLUTION_TEXT'),
                beforeShowPromise: () => {
                    return new Promise<void>((resolve) => {
                        this.stateService.setDisplayMode(LpnDisplayMode.Puzzle);
                        const sourceNet = this.validationService.resolveSourceNetForValidation();
                        if (sourceNet && this.stateService.drawnElements().length === 0) {
                            this.lpnService.createLPNWithSynthesis(sourceNet);
                        }
                        setTimeout(() => {
                            resolve();
                        }, 50);
                    });
                },
                buttons: [
                    {
                        type: 'cancel',
                        classes: 'shepherd-button-secondary',
                        text: this.translate.instant('TOKEN_TRAIL.TOUR.BUTTON_SKIP'),
                    },
                    {
                        type: 'back',
                        classes: 'shepherd-button-secondary',
                        text: this.translate.instant('TOKEN_TRAIL.TOUR.BUTTON_BACK'),
                    },
                    {
                        type: 'next',
                        classes: 'shepherd-button-primary',
                        text: this.translate.instant('TOKEN_TRAIL.TOUR.BUTTON_NEXT'),
                    },
                ],
            },
            {
                id: 'step-mode-toggle',
                attachTo: {
                    element: 'button[data-tour="construction"]',
                    on: 'bottom' as const,
                },
                title: this.translate.instant('TOKEN_TRAIL.TOUR.STEP_MODE_TOGGLE_TITLE'),
                text: this.translate.instant('TOKEN_TRAIL.TOUR.STEP_MODE_TOGGLE_TEXT'),
                beforeShowPromise: () => {
                    return new Promise<void>((resolve) => {
                        this.stateService.setDisplayMode(LpnDisplayMode.Puzzle);
                        const sourceNet = this.validationService.resolveSourceNetForValidation();
                        if (sourceNet && this.stateService.drawnElements().length === 0) {
                            this.lpnService.createLPNWithSynthesis(sourceNet);
                        }
                        setTimeout(() => {
                            resolve();
                        }, 50);
                    });
                },
                buttons: [
                    {
                        type: 'cancel',
                        classes: 'shepherd-button-secondary',
                        text: this.translate.instant('TOKEN_TRAIL.TOUR.BUTTON_SKIP'),
                    },
                    {
                        type: 'back',
                        classes: 'shepherd-button-secondary',
                        text: this.translate.instant('TOKEN_TRAIL.TOUR.BUTTON_BACK'),
                    },
                    {
                        type: 'next',
                        classes: 'shepherd-button-primary',
                        text: this.translate.instant('TOKEN_TRAIL.TOUR.BUTTON_NEXT'),
                    },
                ],
            },
            {
                id: 'step-construction',
                attachTo: {
                    element: 'app-split-view',
                    on: 'top' as const,
                },
                title: this.translate.instant('TOKEN_TRAIL.TOUR.STEP4_TITLE'),
                text: this.translate.instant('TOKEN_TRAIL.TOUR.STEP4_TEXT'),
                beforeShowPromise: () => {
                    return new Promise<void>((resolve) => {
                        this.stateService.clear();
                        this.stateService.setDisplayMode(LpnDisplayMode.Construction);
                        this.elementDroppedInTour.set(false);
                        setTimeout(() => {
                            const step = this.shepherdService.tourObject?.getCurrentStep();
                            if (step) {
                                step.updateStepOptions({
                                    buttons: this.getStepConstructionButtons(true),
                                });
                            }
                            resolve();
                        }, 50);
                    });
                },
                buttons: this.getStepConstructionButtons(true),
            },
            {
                id: 'step-merge',
                attachTo: {
                    element: 'app-split-view',
                    on: 'top' as const,
                },
                title: this.translate.instant('TOKEN_TRAIL.TOUR.STEP_MERGE_TITLE'),
                text: this.translate.instant('TOKEN_TRAIL.TOUR.STEP_MERGE_TEXT'),
                beforeShowPromise: () => {
                    return new Promise<void>((resolve) => {
                        this.stateService.clear();
                        this.stateService.setDisplayMode(LpnDisplayMode.Construction);
                        (this.stateService as unknown as { conditionCounter: number }).conditionCounter = 2;
                        this.conditionMergedInTour.set(false);

                        // Preload c1 and c2
                        const c1 = this.stateService.buildCondition('c1', 'c1', 0, { baseName: 'c1' });
                        c1.x = 200;
                        c1.y = 200;
                        c1.trailMarkings = { p1: 1 };
                        c1.updateDynamicLabel();

                        const c2 = this.stateService.buildCondition('c2', 'c2', 0, { baseName: 'c2' });
                        c2.x = 300;
                        c2.y = 200;
                        c2.trailMarkings = { p2: 1 };
                        c2.updateDynamicLabel();

                        this.stateService.addDrawnElement(c1);
                        this.stateService.addDrawnElement(c2);

                        setTimeout(() => {
                            const step = this.shepherdService.tourObject?.getCurrentStep();
                            if (step) {
                                step.updateStepOptions({
                                    buttons: this.getStepMergeButtons(true),
                                });
                            }
                            resolve();
                        }, 50);
                    });
                },
                buttons: this.getStepMergeButtons(true),
            },
            {
                id: 'step-unmerge',
                attachTo: {
                    element: 'app-split-view',
                    on: 'top' as const,
                },
                title: this.translate.instant('TOKEN_TRAIL.TOUR.STEP_UNMERGE_TITLE'),
                text: this.translate.instant('TOKEN_TRAIL.TOUR.STEP_UNMERGE_TEXT'),
                beforeShowPromise: () => {
                    return new Promise<void>((resolve) => {
                        this.stateService.setDisplayMode(LpnDisplayMode.Construction);
                        this.conditionUnmergedInTour.set(false);
                        setTimeout(() => {
                            const step = this.shepherdService.tourObject?.getCurrentStep();
                            if (step) {
                                step.updateStepOptions({
                                    buttons: this.getStepUnmergeButtons(true),
                                });
                            }
                            resolve();
                        }, 50);
                    });
                },
                buttons: this.getStepUnmergeButtons(true),
            },
            {
                id: 'step-active-goals',
                attachTo: {
                    element: '.goals-panel',
                    on: 'left' as const,
                },
                title: this.translate.instant('TOKEN_TRAIL.TOUR.STEP_ACTIVE_GOALS_TITLE'),
                text: this.translate.instant('TOKEN_TRAIL.TOUR.STEP_ACTIVE_GOALS_TEXT'),
                beforeShowPromise: () => {
                    return new Promise<void>((resolve) => {
                        this.stateService.setDisplayMode(LpnDisplayMode.Construction);
                        setTimeout(() => {
                            resolve();
                        }, 50);
                    });
                },
                buttons: [
                    {
                        type: 'cancel',
                        classes: 'shepherd-button-secondary',
                        text: this.translate.instant('TOKEN_TRAIL.TOUR.BUTTON_SKIP'),
                    },
                    {
                        type: 'back',
                        classes: 'shepherd-button-secondary',
                        text: this.translate.instant('TOKEN_TRAIL.TOUR.BUTTON_BACK'),
                    },
                    {
                        type: 'next',
                        classes: 'shepherd-button-primary',
                        text: this.translate.instant('TOKEN_TRAIL.TOUR.BUTTON_NEXT'),
                    },
                ],
            },
            {
                id: 'step-goals-difficulty',
                attachTo: {
                    element: 'button[data-tour="emoji_events"]',
                    on: 'bottom' as const,
                },
                title: this.translate.instant('TOKEN_TRAIL.TOUR.STEP_GOALS_DIFFICULTY_TITLE'),
                text: this.translate.instant('TOKEN_TRAIL.TOUR.STEP_GOALS_DIFFICULTY_TEXT'),
                beforeShowPromise: () => {
                    return new Promise<void>((resolve) => {
                        this.stateService.setDisplayMode(LpnDisplayMode.Construction);
                        setTimeout(() => {
                            resolve();
                        }, 50);
                    });
                },
                buttons: [
                    {
                        type: 'cancel',
                        classes: 'shepherd-button-secondary',
                        text: this.translate.instant('TOKEN_TRAIL.TOUR.BUTTON_SKIP'),
                    },
                    {
                        type: 'back',
                        classes: 'shepherd-button-secondary',
                        text: this.translate.instant('TOKEN_TRAIL.TOUR.BUTTON_BACK'),
                    },
                    {
                        type: 'next',
                        classes: 'shepherd-button-primary',
                        text: this.translate.instant('TOKEN_TRAIL.TOUR.BUTTON_NEXT'),
                    },
                ],
            },
            {
                id: 'step-construction-solution',
                attachTo: {
                    element: 'button[data-tour="lightbulb_outline"]',
                    on: 'bottom' as const,
                },
                title: this.translate.instant('TOKEN_TRAIL.TOUR.STEP_CONSTRUCTION_SOLUTION_TITLE'),
                text: this.translate.instant('TOKEN_TRAIL.TOUR.STEP_CONSTRUCTION_SOLUTION_TEXT'),
                beforeShowPromise: () => {
                    return new Promise<void>((resolve) => {
                        this.stateService.setDisplayMode(LpnDisplayMode.Construction);
                        setTimeout(() => {
                            resolve();
                        }, 50);
                    });
                },
                buttons: [
                    {
                        type: 'cancel',
                        classes: 'shepherd-button-secondary',
                        text: this.translate.instant('TOKEN_TRAIL.TOUR.BUTTON_SKIP'),
                    },
                    {
                        type: 'back',
                        classes: 'shepherd-button-secondary',
                        text: this.translate.instant('TOKEN_TRAIL.TOUR.BUTTON_BACK'),
                    },
                    {
                        type: 'next',
                        classes: 'shepherd-button-primary',
                        text: this.translate.instant('TOKEN_TRAIL.TOUR.BUTTON_NEXT'),
                    },
                ],
            },
            {
                id: 'step-upload',
                attachTo: {
                    element: 'app-upload button',
                    on: 'left' as const,
                },
                title: this.translate.instant('TOKEN_TRAIL.TOUR.STEP5_TITLE'),
                text: this.translate.instant('TOKEN_TRAIL.TOUR.STEP5_TEXT'),
                buttons: [
                    {
                        type: 'cancel',
                        classes: 'shepherd-button-secondary',
                        text: this.translate.instant('TOKEN_TRAIL.TOUR.BUTTON_SKIP'),
                    },
                    {
                        type: 'back',
                        classes: 'shepherd-button-secondary',
                        text: this.translate.instant('TOKEN_TRAIL.TOUR.BUTTON_BACK'),
                    },
                    {
                        type: 'next',
                        classes: 'shepherd-button-primary',
                        text: this.translate.instant('TOKEN_TRAIL.TOUR.BUTTON_NEXT'),
                    },
                ],
            },
            {
                id: 'step-examples',
                attachTo: {
                    element: 'app-example-menu button',
                    on: 'left' as const,
                },
                title: this.translate.instant('TOKEN_TRAIL.TOUR.STEP6_TITLE'),
                text: this.translate.instant('TOKEN_TRAIL.TOUR.STEP6_TEXT'),
                buttons: [
                    {
                        type: 'cancel',
                        classes: 'shepherd-button-secondary',
                        text: this.translate.instant('TOKEN_TRAIL.TOUR.BUTTON_SKIP'),
                    },
                    {
                        type: 'back',
                        classes: 'shepherd-button-secondary',
                        text: this.translate.instant('TOKEN_TRAIL.TOUR.BUTTON_BACK'),
                    },
                    {
                        type: 'next',
                        classes: 'shepherd-button-primary',
                        text: this.translate.instant('TOKEN_TRAIL.TOUR.BUTTON_NEXT'),
                    },
                ],
            },
            {
                id: 'step-finish',
                title: this.translate.instant('TOKEN_TRAIL.TOUR.STEP8_TITLE'),
                text: this.translate.instant('TOKEN_TRAIL.TOUR.STEP8_TEXT'),

                buttons: [
                    {
                        type: 'next',
                        classes: 'shepherd-button-primary',
                        text: this.translate.instant('TOKEN_TRAIL.TOUR.BUTTON_DONE'),
                    },
                ],
            },
        ];

        this.shepherdService.addSteps(steps);

        // Track completion or cancellation
        const cleanup = () => {
            this.isTourRunning.set(false);
            this.currentStepId.set(null);
            localStorage.setItem('token-trail-tour-completed', 'true');
            this.stateService.setDisplayMode(LpnDisplayMode.Puzzle); // Ensure we return to puzzle mode

            // Restore the user's backed up net if it exists
            if (this.backedUpNet) {
                this.sourceNetService.loadNewNet(this.backedUpNet, this.backedUpText);
                this.tabStateService.setAllLastMarkings(this.backedUpNet.marking);
                this.displayService.display(this.backedUpNet, { triggeredByFiring: false });
                this.panningService.fitViewToGraph(this.backedUpNet);

                // Reset backups
                this.backedUpNet = null;
                this.backedUpText = '';
            } else {
                // If there was no backed up net, regenerate LPN from the example net so puzzle mode functions correctly
                const sourceNet = this.validationService.resolveSourceNetForValidation();
                if (sourceNet) {
                    this.lpnService.createLPNWithSynthesis(sourceNet);
                }
            }
        };

        const tour = this.shepherdService.tourObject;
        if (tour) {
            tour.on('show', () => {
                const step = tour.getCurrentStep();
                if (step) {
                    this.currentStepId.set(step.id);
                }
            });
            tour.on('complete', cleanup);
            tour.on('cancel', cleanup);
        }

        this.shepherdService.start();
    }

    notifyTokenAdjusted() {
        if (!this.isTourRunning()) {
            return;
        }
        this.tokenCountChangedInTour.set(true);
        const step = this.shepherdService.tourObject?.getCurrentStep();
        if (step && step.id === 'step-puzzle') {
            step.updateStepOptions({
                buttons: this.getStepPuzzleButtons(false),
            });
        }
    }

    notifyElementDropped() {
        if (!this.isTourRunning()) {
            return;
        }
        this.elementDroppedInTour.set(true);
        const step = this.shepherdService.tourObject?.getCurrentStep();
        if (step && step.id === 'step-construction') {
            step.updateStepOptions({
                buttons: this.getStepConstructionButtons(false),
            });
        }
    }

    notifyConditionMerged() {
        if (!this.isTourRunning()) {
            return;
        }
        this.conditionMergedInTour.set(true);
        const step = this.shepherdService.tourObject?.getCurrentStep();
        if (step && step.id === 'step-merge') {
            step.updateStepOptions({
                buttons: this.getStepMergeButtons(false),
            });
        }
    }

    notifyConditionUnmerged() {
        if (!this.isTourRunning()) {
            return;
        }
        this.conditionUnmergedInTour.set(true);
        const step = this.shepherdService.tourObject?.getCurrentStep();
        if (step && step.id === 'step-unmerge') {
            step.updateStepOptions({
                buttons: this.getStepUnmergeButtons(false),
            });
        }
    }

    private getStepPuzzleButtons(disabled: boolean) {
        return [
            {
                type: 'cancel',
                classes: 'shepherd-button-secondary',
                text: this.translate.instant('TOKEN_TRAIL.TOUR.BUTTON_SKIP'),
            },
            {
                type: 'back',
                classes: 'shepherd-button-secondary',
                text: this.translate.instant('TOKEN_TRAIL.TOUR.BUTTON_BACK'),
            },
            {
                classes: 'shepherd-button-primary shepherd-next-button',
                text: this.translate.instant('TOKEN_TRAIL.TOUR.BUTTON_NEXT'),
                action: () => {
                    if (this.tokenCountChangedInTour()) {
                        this.shepherdService.next();
                    }
                },
                disabled,
            },
        ];
    }

    private getStepConstructionButtons(disabled: boolean) {
        return [
            {
                type: 'cancel',
                classes: 'shepherd-button-secondary',
                text: this.translate.instant('TOKEN_TRAIL.TOUR.BUTTON_SKIP'),
            },
            {
                type: 'back',
                classes: 'shepherd-button-secondary',
                text: this.translate.instant('TOKEN_TRAIL.TOUR.BUTTON_BACK'),
            },
            {
                classes: 'shepherd-button-primary shepherd-next-button',
                text: this.translate.instant('TOKEN_TRAIL.TOUR.BUTTON_NEXT'),
                action: () => {
                    if (this.elementDroppedInTour()) {
                        this.shepherdService.next();
                    }
                },
                disabled,
            },
        ];
    }

    private getStepMergeButtons(disabled: boolean) {
        return [
            {
                type: 'cancel',
                classes: 'shepherd-button-secondary',
                text: this.translate.instant('TOKEN_TRAIL.TOUR.BUTTON_SKIP'),
            },
            {
                type: 'back',
                classes: 'shepherd-button-secondary',
                text: this.translate.instant('TOKEN_TRAIL.TOUR.BUTTON_BACK'),
            },
            {
                classes: 'shepherd-button-primary shepherd-next-button',
                text: this.translate.instant('TOKEN_TRAIL.TOUR.BUTTON_NEXT'),
                action: () => {
                    if (this.conditionMergedInTour()) {
                        this.shepherdService.next();
                    }
                },
                disabled,
            },
        ];
    }

    private getStepUnmergeButtons(disabled: boolean) {
        return [
            {
                type: 'cancel',
                classes: 'shepherd-button-secondary',
                text: this.translate.instant('TOKEN_TRAIL.TOUR.BUTTON_SKIP'),
            },
            {
                type: 'back',
                classes: 'shepherd-button-secondary',
                text: this.translate.instant('TOKEN_TRAIL.TOUR.BUTTON_BACK'),
            },
            {
                classes: 'shepherd-button-primary shepherd-next-button',
                text: this.translate.instant('TOKEN_TRAIL.TOUR.BUTTON_NEXT'),
                action: () => {
                    if (this.conditionUnmergedInTour()) {
                        this.shepherdService.next();
                    }
                },
                disabled,
            },
        ];
    }
}
