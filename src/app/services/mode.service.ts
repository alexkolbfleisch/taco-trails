import { computed, inject, Injectable, Injector, signal } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { ConfirmDialogComponent } from '../components/confirm-dialog/confirm-dialog.component';
import { AppMode } from '../classes/app-mode';
import { Tab } from '../classes/tabs';
import { ToasterNotificationService } from './toaster-notification.service';
import { DrawService } from './draw.service';
import { ProcessNetStateService } from './process-net-state.service';
import { ReachabilityGraphService } from '../reachability-graph.service';
import { TokenTrailStateService } from './token-trail-state.service';

@Injectable({ providedIn: 'root' })
export class ModeService {
    private _toasterService = inject(ToasterNotificationService);
    private _dialog = inject(MatDialog);
    private _injector = inject(Injector);
    private _tabModeSignals = new Map<
        Tab,
        { mode: ReturnType<typeof signal<AppMode>>; isExamMode: ReturnType<typeof computed<boolean>> }
    >();

    constructor() {
        const tabs: Tab[] = [Tab.DRAW, Tab.PLAY, Tab.REACHABILITY_GRAPH, Tab.PROCESS_NET, Tab.TOKEN_TRAIL];
        tabs.forEach((tab) => {
            this._tabModeSignals.set(tab, {
                mode: signal<AppMode>(AppMode.LEARN),
                isExamMode: computed(() => this.getModeSignal(tab)!() === AppMode.EXAM),
            });
        });
    }

    getModeSignal(tab: Tab): ReturnType<typeof signal<AppMode>> | undefined {
        return this._tabModeSignals.get(tab)?.mode;
    }

    getIsExamModeSignal(tab: Tab): ReturnType<typeof computed<boolean>> | undefined {
        return this._tabModeSignals.get(tab)?.isExamMode;
    }

    getMode(tab: Tab): AppMode {
        return this._tabModeSignals.get(tab)?.mode() || AppMode.LEARN;
    }

    isExamMode(tab: Tab): boolean {
        return this.getMode(tab) === AppMode.EXAM;
    }

    toggleMode(tab: Tab): void {
        const tabSignals = this._tabModeSignals.get(tab);
        if (!tabSignals) return;

        if (this.hasDataToDelete(tab)) {
            this._dialog.open(ConfirmDialogComponent, {
                data: {
                    title: 'CONFIRM_DIALOG.TITLE',
                    tab: tab,
                    message: tab === Tab.DRAW ? 'CONFIRM_DIALOG.MESSAGE_DRAW' : 'CONFIRM_DIALOG.MESSAGE_DEFAULT',
                },
            });
        }
        const newMode = tabSignals.mode() === AppMode.LEARN ? AppMode.EXAM : AppMode.LEARN;
        tabSignals.mode.set(newMode);

        this._toasterService.showInfo(
            'TOASTER.HEADER.MODE_SWITCHED',
            newMode === AppMode.EXAM ? 'TOASTER.BODY.MODE_SWITCHED_EXAM' : 'TOASTER.BODY.MODE_SWITCHED_LEARN',
        );
    }

    private hasDataToDelete(tab: Tab): boolean {
        switch (tab) {
            case Tab.DRAW:
                return this._injector.get(DrawService).drawnElements().length > 0;
            case Tab.PROCESS_NET:
                return this._injector.get(ProcessNetStateService).drawnElements().length > 0;
            case Tab.REACHABILITY_GRAPH:
                return this._injector.get(ReachabilityGraphService).reachabilityGraphSignal().nodes.length > 1;
            case Tab.TOKEN_TRAIL:
                return this._injector.get(TokenTrailStateService).drawnElements().length > 0;
            default:
                return false;
        }
    }
}
