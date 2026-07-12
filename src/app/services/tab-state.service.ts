import { inject, Injectable, signal } from '@angular/core';
import { Tab } from '../classes/tabs';
import { Diagram } from '../classes/diagram/diagram';
import { DisplayService } from './display.service';
import { SourcePetriNetService } from './source-petri-net.service';

export interface TourService {
    startTour(restart?: boolean): void;
}

@Injectable({ providedIn: 'root' })
export class TabStateService {
    private _displayService: DisplayService = inject(DisplayService);
    private _sourcePetriNetService: SourcePetriNetService = inject(SourcePetriNetService);
    readonly currentTab = signal<Tab>(Tab.DRAW);
    activeTourService: TourService | null = null;

    private _tabLastMarkings: Map<Tab, Record<string, number> | undefined> = new Map<
        Tab,
        Record<string, number> | undefined
    >([
        [Tab.DRAW, undefined],
        [Tab.TOKEN_TRAIL, undefined],
        [Tab.PRACTICE, undefined],
    ]);

    switchTo(newTab: Tab) {
        const previousTab = this.currentTab();
        this.currentTab.set(newTab);

        const diagram = this._displayService.diagram;
        if (!diagram || !(diagram instanceof Diagram)) return;

        this.setLastMarking(previousTab, diagram.marking);
        const lastMarking = this._tabLastMarkings.get(newTab);
        if (lastMarking) diagram.marking = { ...lastMarking };

        this._sourcePetriNetService.updateEditedNet(diagram, { triggeredByFiring: false });
    }

    getLastMarking(tab: Tab): Record<string, number> | undefined {
        return this._tabLastMarkings.get(tab);
    }

    setLastMarking(tab: Tab, marking: Record<string, number> | undefined): void {
        this._tabLastMarkings.set(tab, marking);
    }

    setAllLastMarkings(marking: Record<string, number> | undefined): void {
        for (const [key, value] of Object.entries(Tab)) this._tabLastMarkings.set(value as Tab, marking);
    }
}
