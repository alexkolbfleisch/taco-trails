export interface ToastData {
    type: ToastType;
    heading: string;
    message: string;
    headingParams?: TranslationParams;
    messageParams?: TranslationParams;
    list?: ToastList[];
    actions?: {
        accept: {
            label: string;
            action: () => void;
        };
        dismiss: {
            label: string;
            action: () => void;
        };
    };
}

export type TranslationParams = Record<string, string | number>;

export interface ToastList {
    message: string;
    messageParams?: TranslationParams;
}

export type ToastType = 'success' | 'info' | 'warning' | 'error';

export const TOAST_ICONS: Record<ToastType, string> = {
    success: 'check',
    info: 'info',
    warning: 'warning',
    error: 'error',
};

export interface ToastPosition {
    horizontal: 'start' | 'center' | 'end' | 'left' | 'right';
    vertical: 'top' | 'bottom';
}

export const TOAST_POSITIONS = {
    TOP_LEFT: {
        horizontal: 'left',
        vertical: 'top',
    },
    TOP_CENTER: {
        horizontal: 'center',
        vertical: 'top',
    },
    TOP_RIGHT: {
        horizontal: 'right',
        vertical: 'top',
    },
    BOTTOM_LEFT: {
        horizontal: 'left',
        vertical: 'bottom',
    },
    BOTTOM_CENTER: {
        horizontal: 'center',
        vertical: 'bottom',
    },
    BOTTOM_RIGHT: {
        horizontal: 'right',
        vertical: 'bottom',
    },
} satisfies Record<string, ToastPosition>;

export const DEFAULT_TOAST_POSITION: ToastPosition = TOAST_POSITIONS.TOP_RIGHT;

export enum ToastDuration {
    SHORT = 3000,
    MEDIUM = 5000,
    LONG = 10000,
}

export interface ToastOptions {
    duration?: ToastDuration | number;
    toastPosition?: ToastPosition;
    headingParams?: TranslationParams;
    messageParams?: TranslationParams;
    list?: ToastList[];
    actions?: {
        accept: {
            label: string;
            action: () => void;
        };
        dismiss: {
            label: string;
            action: () => void;
        };
    };
}
