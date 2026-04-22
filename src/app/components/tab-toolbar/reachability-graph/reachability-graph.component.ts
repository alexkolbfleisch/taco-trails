import { Component, effect, inject, untracked } from '@angular/core';
import { ReachabilityGraphDisplayComponent } from './reachability-graph-display/reachability-graph-display.component';
import { ReachabilityGraphDrawDisplayComponent } from './reachability-graph-draw-display/reachability-graph-draw-display.component';
import { SplitViewComponent } from '../../split-view/split-view.component';
import { TabStateService } from '../../../services/tab-state.service';
import { Tab } from '../../../classes/tabs';
import { ReachabilityGraphService } from 'src/app/reachability-graph.service';
import { SourcePetriNetService } from '../../../services/source-petri-net.service';
import { toSignal } from '@angular/core/rxjs-interop';

@Component({
    selector: 'app-reachability-graph',
    standalone: true,
    imports: [ReachabilityGraphDisplayComponent, ReachabilityGraphDrawDisplayComponent, SplitViewComponent],
    templateUrl: './reachability-graph.component.html',
    styleUrls: ['./reachability-graph.component.css'],
})
export class ReachabilityGraphComponent {
    private _tabStateService = inject(TabStateService);
    private _reachabilityGraphService = inject(ReachabilityGraphService);
    private _sourcePetriNetService = inject(SourcePetriNetService);
    private _sourceNet = toSignal(this._sourcePetriNetService.sourceNet$);

    constructor() {
        this.initializeTabEffect();
    }

    private initializeTabEffect() {
        effect(() => {
            const currentTab = this._tabStateService.currentTab();
            this._sourceNet(); // Register dependency

            if (currentTab === Tab.REACHABILITY_GRAPH) {
                // Use untracked to prevent the effect from subscribing to signals
                // read inside the service method (like AppMode or internal state)
                untracked(() => {
                    this._reachabilityGraphService.initializeReachabilityGraphFirstStateNode();
                });
            }
        });
    }
}
