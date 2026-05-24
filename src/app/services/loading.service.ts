import { Injectable, signal } from '@angular/core';

@Injectable({
    providedIn: 'root',
})
export class LoadingService {
    private readonly _isLoading = signal<boolean>(false);
    public readonly isLoading = this._isLoading.asReadonly();

    /**
     * Set the loading state to true.
     */
    public show(): void {
        this._isLoading.set(true);
    }

    /**
     * Set the loading state to false.
     */
    public hide(): void {
        this._isLoading.set(false);
    }
}
