import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { DisplayableGraph } from '../classes/displayable-graph.interface';

@Injectable({
    providedIn: 'root',
})
export class DisplayService implements OnDestroy {
    private _diagram$: BehaviorSubject<DisplayableGraph | undefined>;
    private _triggeredByFiring = false;

    constructor() {
        this._diagram$ = new BehaviorSubject<DisplayableGraph | undefined>(undefined);
    }

    ngOnDestroy(): void {
        this._diagram$.complete();
    }

    public get diagram$(): Observable<DisplayableGraph | undefined> {
        return this._diagram$.asObservable();
    }

    public get diagram(): DisplayableGraph | undefined {
        return this._diagram$.getValue();
    }

    /**
     * Displays the given graph in the display area.
     *
     * @param graph
     *          the graph to be displayed
     */
    public display(graph: DisplayableGraph, options?: { triggeredByFiring?: boolean }) {
        this._triggeredByFiring = !!options?.triggeredByFiring;
        this._diagram$.next(graph);
    }

    /**
     * Clears the currently displayed diagram.
     */
    public clear() {
        this._triggeredByFiring = false;
        this._diagram$.next(undefined);
    }
}
