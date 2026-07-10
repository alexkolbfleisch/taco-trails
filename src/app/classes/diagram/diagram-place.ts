import { DiagramNode, SHAPE } from './diagram-node';
import { Signal, signal } from '@angular/core';

export type DiagramPlaceLabelPlacement = 'inside' | 'below';

export interface DiagramPlaceOptions {
    labelPlacement?: DiagramPlaceLabelPlacement;
    hideTokens?: boolean;
    innerLabel?: string;
    isStartPlace?: boolean;
}

export class DiagramPlace extends DiagramNode {
    private _tokens = signal<number>(0);
    private _label = signal<string | undefined>(undefined); // original label (place id) for display
    private _labelPlacement: DiagramPlaceLabelPlacement = 'below';
    private _hideTokens = signal<boolean>(false);
    private _innerLabel?: string;
    private _isStartPlace = signal<boolean>(false);

    constructor(id: string, initialTokens = 0, label?: string, options?: DiagramPlaceOptions) {
        super(id);
        this._tokens.set(initialTokens);
        this._label.set(label);
        this._labelPlacement = options?.labelPlacement ?? 'below';
        this._hideTokens.set(options?.hideTokens ?? false);
        this._innerLabel = options?.innerLabel;
        this._isStartPlace.set(options?.isStartPlace ?? false);
    }

    override get tokenCount(): Signal<number> {
        return this._tokens;
    }

    set tokens(value: number) {
        this._tokens.set(value);
    }

    override get shape(): SHAPE {
        return SHAPE.CIRCLE;
    }

    set label(value: string | undefined) {
        this._label.set(value);
    }

    // Expose original label (place id) if available
    get label(): string | undefined {
        return this._label();
    }

    get labelPlacement(): DiagramPlaceLabelPlacement {
        return this._labelPlacement;
    }

    get hideTokens(): boolean {
        return this._hideTokens();
    }

    set hideTokens(value: boolean) {
        this._hideTokens.set(value);
    }

    get innerLabel(): string | undefined {
        return this._innerLabel;
    }

    get isStartPlace(): boolean {
        return this._isStartPlace();
    }

    set isStartPlace(value: boolean) {
        this._isStartPlace.set(value);
    }

    override get displayLabel(): string {
        return this._label() ?? this.id;
    }
}
