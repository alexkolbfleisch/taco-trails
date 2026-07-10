import { inject, Injectable } from '@angular/core';
import { MatSnackBar, MatSnackBarConfig } from '@angular/material/snack-bar';
import { DEFAULT_TOAST_POSITION, ToastData, ToastDuration, ToastType, ToastOptions } from '../classes/toast';
import { ToasterComponent } from '../components/toaster/toaster.component';

@Injectable({
    providedIn: 'root',
})
export class ToasterNotificationService {
    private _snackBar = inject(MatSnackBar);

    public showToast(type: ToastType, heading: string, message: string, options?: ToastOptions) {
        const config: MatSnackBarConfig = {
            panelClass: ['custom-toast-container', `${type}-toast`],
            horizontalPosition: options?.toastPosition?.horizontal ?? DEFAULT_TOAST_POSITION.horizontal,
            verticalPosition: options?.toastPosition?.vertical ?? DEFAULT_TOAST_POSITION.vertical,
            duration:
                options?.duration !== undefined
                    ? options.duration
                    : options?.actions
                      ? undefined
                      : ToastDuration.MEDIUM,
        };

        const data: ToastData = {
            type,
            heading,
            message,
            headingParams: options?.headingParams,
            messageParams: options?.messageParams,
            list: options?.list,
            actions: options?.actions,
        };

        this._snackBar.openFromComponent(ToasterComponent, { ...config, data });
    }

    showSuccess(heading: string, message: string, options?: ToastOptions) {
        this.showToast('success', heading, message, options);
    }

    showInfo(heading: string, message: string, options?: ToastOptions) {
        this.showToast('info', heading, message, options);
    }

    showWarning(heading: string, message: string, options?: ToastOptions) {
        this.showToast('warning', heading, message, options);
    }

    showError(heading: string, message: string, options?: ToastOptions) {
        this.showToast('error', heading, message, options);
    }
}
