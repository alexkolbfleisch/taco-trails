import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { Diagram } from '../classes/diagram/diagram';

@Injectable({
    providedIn: 'root',
})
/**
 * This service is responsible for holding the current source petri net.
 * The source petri net is the petri net that is currently being edited by the user.
 * It can be set from a file upload or from a template.
 * Other services can subscribe to the sourceNet$ observable to get updates when the source net changes.
 * The other services can then use the source net to generate other artifacts, like the reachability graph.
 */
export class SourcePetriNetService {
    private readonly _sourceNet$ = new BehaviorSubject<Diagram | null>(null);

    /**
     * Observable that emits the current source Petri net diagram.
     * Can be subscribed to fetch updates when the source net changes.
     */
    public readonly sourceNet$: Observable<Diagram | null> = this._sourceNet$.asObservable();

    private readonly _sourceText$ = new BehaviorSubject<string>('');

    /**
     * Observable that emits the current source text.
     * Can be subscribed to fetch updates when the source text changes.
     */
    public readonly sourceText$: Observable<string> = this._sourceText$.asObservable();

    private readonly _isDirty$ = new BehaviorSubject<boolean>(false);

    /**
     * Observable that emits whether the current source Petri net has unsaved changes.
     */
    public readonly isDirty$: Observable<boolean> = this._isDirty$.asObservable();

    private readonly _isOptimalLayoutCalculated$ = new BehaviorSubject<boolean>(false);
    private _lastChangeTriggeredByFiring = false;

    /**
     * Marks that the optimal layout has been calculated for the current source Petri net.
     */
    public optimalLayoutCalculated(): void {
        this._isOptimalLayoutCalculated$.next(true);
    }

    public resetOptimalLayoutCalculated(): void {
        this._isOptimalLayoutCalculated$.next(false);
    }

    /**
     * Loads a new petri net as the current source net.
     * Resets the dirty flag to false (no unsaved changes).
     * @param net
     *         the new petri net diagram
     * @param rawText
     *        the raw text representation of the petri net
     */
    public loadNewNet(net: Diagram, rawText: string): void {
        this._sourceNet$.next(net);
        this._sourceText$.next(rawText);
        this._isDirty$.next(false);
        this._isOptimalLayoutCalculated$.next(false);
        this._lastChangeTriggeredByFiring = false;
    }

    /**
     * Updates the currently stored source petri net with the modified net.
     * Marks the net as dirty (having unsaved changes).
     * Should be called whenever the user makes changes to the petri net.
     * @param modifiedNet
     *          the modified petri net diagram
     * @param options
     *         optional parameters
     */
    public updateEditedNet(modifiedNet: Diagram, options?: { triggeredByFiring?: boolean }): void {
        this._lastChangeTriggeredByFiring = !!options?.triggeredByFiring;
        this._sourceNet$.next(modifiedNet);
        this._isDirty$.next(true);
    }

    /**
     * Sets the current source text and petri net as clean (no unsaved changes).
     * @param newText
     *         the new source text
     * @param savedDiagram
     *         the saved petri net diagram
     */
    public setClean(newText: string, savedDiagram: Diagram): void {
        this._sourceText$.next(newText);
        this._sourceNet$.next(savedDiagram);
        this._isDirty$.next(false);
        this._isOptimalLayoutCalculated$.next(false);
    }

    /**
     * Returns the currently stored source text of the Petri net.
     * Reads the value synchronously from the internal BehaviorSubject.
     * @returns The current source text as a string.
     */
    public getSourceText() {
        return this._sourceText$.getValue();
    }

    /**
     * Gets the current source petri net.
     * @returns The current source petri net.
     */
    public getCurrentSourceNet(): Diagram | null {
        return this._sourceNet$.getValue();
    }

    /**
     * @returns true when the current source petri net has unsaved changes, false otherwise.
     */
    public isCurrentNetDirty(): boolean {
        return this._isDirty$.getValue();
    }

    /**
     * Clears the currently stored source petri net and its text representation.
     * Resets the dirty flag to false.
     */
    public clear(): void {
        this._sourceNet$.next(null);
        this._sourceText$.next('');
        this._isDirty$.next(false);
        this._isOptimalLayoutCalculated$.next(false);
        this._lastChangeTriggeredByFiring = false;
    }

    public setSourceText(rawText: string): void {
        this._sourceText$.next(rawText);
        this._sourceNet$.next(null);
        this._isDirty$.next(false);
        this._isOptimalLayoutCalculated$.next(false);
    }
}
