export interface ViewBox {
    minX: number;
    minY: number;
    width: number;
    height: number;
}

export const viewBoxValues: ViewBox = {
    minX: 200,
    minY: -50,
    width: 900,
    height: 450,
};

export const PLACE_RADIUS = 25;
export const TRANSITION_SIZE = 60;

export const VIEW_MODES = {
    SIMPLE: 'simple',
    DESCRIPTIVE: 'descriptive',
} as const;

export type ViewMode = (typeof VIEW_MODES)[keyof typeof VIEW_MODES];
