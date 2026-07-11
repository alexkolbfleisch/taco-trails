import { inject, Injectable, signal } from '@angular/core';

import { TabStateService } from './tab-state.service';
import { Tab } from '../classes/tabs';
import { DiagramTransition } from '../classes/diagram/diagram-transition';
import { FiringEntry } from '../classes/firing-entry';

@Injectable({ providedIn: 'root' })
export class PlayService {
    private _tabStateService = inject(TabStateService);

    private _currentFiringEntry: FiringEntry | undefined;
    private _idCounter = 0;

    firingEntries = signal<FiringEntry[]>([]);

    /**
     * Checks if a transition can be fired in the current tab and activation state.
     * @param node - The transition to be checked
     * @returns true if the transition can be fired, else false.
     */
    canBeFired(node: DiagramTransition): boolean {
        return (
            (this._tabStateService.currentTab() === Tab.PLAY ||
                this._tabStateService.currentTab() === Tab.REACHABILITY_GRAPH ||
                this._tabStateService.currentTab() === Tab.PROCESS_NET) &&
            node.isActivated()
        );
    }

    /**
     * Adds a predefined firing entry to the firing table.
     * @param firingSequence - The firing sequence.
     * @param transitionCount - The transition count.
     * @param endMarking - The end marking.
     * @param isValid - Indicates whether the firing entry is valid.
     */
    addFiringEntry(
        firingSequence: string,
        transitionCount: number,
        endMarking: Record<string, number>,
        isValid: boolean | undefined,
    ) {
        if (this._currentFiringEntry) this.closeCurrentFiringEntry();
        const newEntry = new FiringEntry(this.getNewId(), firingSequence, transitionCount, endMarking, true, isValid);
        this.firingEntries.update((entries) => {
            entries.push(newEntry);
            return entries;
        });
    }

    /**
     * Closes the current firing entry in the firing table, preventing further updates to it.
     */
    closeCurrentFiringEntry(): void {
        if (this._currentFiringEntry)
            this.firingEntries.update((entries) => {
                this._currentFiringEntry!.isClosed = true;
                return entries;
            });
        this._currentFiringEntry = undefined;
    }

    /**
     * Generates a new unique ID for a firing entry.
     * @returns The new ID
     */
    getNewId(): number {
        return this._idCounter++;
    }
}
