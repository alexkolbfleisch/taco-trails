import { inject, Injectable } from '@angular/core';
import { FileReaderService } from './file-reader.service';
import { ParserService } from './parser.service';
import { DisplayService } from './display.service';
import { catchError, of, take } from 'rxjs';
import { HttpClient } from '@angular/common/http';
import { ModeService } from './mode.service';
import { SourcePetriNetService } from './source-petri-net.service';
import { ToasterNotificationService } from './toaster-notification.service';
import { TabStateService } from './tab-state.service';
import { Tab } from '../classes/tabs';
import { SerializationService } from './serialization.service';
import { PanningService } from './panning.service';
import { DiagramNode } from '../classes/diagram/diagram-node';
import { applyParallelOffsetsToArcs } from './arc-parallel-offset.util';
import { TokenTrailLpnService } from './token-trail-lpn.service';

@Injectable({
    providedIn: 'root',
})
export class PetriNetLoaderService {
    private _fileReader = inject(FileReaderService);
    private _toasterService = inject(ToasterNotificationService);
    private _parser = inject(ParserService);
    private _displayService = inject(DisplayService);
    private _http = inject(HttpClient);
    private _sourcePetriNetService = inject(SourcePetriNetService);
    private _modeService = inject(ModeService);
    private _tabStateService = inject(TabStateService);
    private _serializationService = inject(SerializationService);
    private _panningService = inject(PanningService);
    private _lpnService = inject(TokenTrailLpnService);

    private _customLpnService?: TokenTrailLpnService;

    /**
     * Registers a custom TokenTrailLpnService (e.g. from the component-scoped injector).
     */
    public registerLpnService(lpnService: TokenTrailLpnService | undefined): void {
        this._customLpnService = lpnService;
    }

    /**
     * Gets the currently registered TokenTrailLpnService.
     */
    public getRegisteredLpnService(): TokenTrailLpnService | undefined {
        return this._customLpnService;
    }

    /**
     * Processes an uploaded file (File object).
     * Reads, parses and loads the net into the DisplayService.
     *
     * @param file The file coming from the input field
     */
    public loadFile(file: File): void {
        this._fileReader
            .readFile(file)
            .pipe(take(1))
            .subscribe((content) => {
                if (content) {
                    this.parseAndDisplay(content);
                } else {
                    this._toasterService.showWarning(
                        'TOASTER.HEADER.READ_ERROR',
                        'TOASTER.BODY.FILE_EMPTY_OR_UNREADABLE',
                    );
                }
            });
    }

    /**
     * Processes a file from a URL
     * Fetches, parses and loads the net into the DisplayService.
     *
     * @param url The URL to the file
     */
    public loadFileFromUrl(url: string): void {
        this._http
            .get(url, { responseType: 'text' })
            .pipe(
                catchError((err) => {
                    const details = err?.message ? ` Grund: ${err.message}` : '';
                    this._toasterService.showError('TOASTER.HEADER.DOWNLOAD_FAILED', 'TOASTER.BODY.DOWNLOAD_FAILED', {
                        messageParams: { url, details },
                    });
                    return of(undefined);
                }),
                take(1),
            )
            .subscribe((content) => {
                if (content) {
                    this.parseAndDisplay(content);
                } else {
                    this._toasterService.showWarning('TOASTER.HEADER.EMPTY_RESPONSE', 'TOASTER.BODY.EMPTY_RESPONSE', {
                        messageParams: { url },
                    });
                }
            });
    }

    /**
     * Central parsing and update logic.
     */
    private parseAndDisplay(content: string): void {
        try {
            const parsedNet = this._parser.parse(content);

            if (parsedNet) {
                // If we import an LPN as a normal source net,
                // we should show the c1 to cx naming schema (the place ID) instead of the combined labels.
                for (const place of parsedNet.places) {
                    if (/^c\d+$/.test(place.id)) {
                        place.label = place.id;
                    }
                }

                const inDrawTab = this._tabStateService.currentTab() === Tab.DRAW;
                this._sourcePetriNetService.loadNewNet(parsedNet, content);
                this._tabStateService.setAllLastMarkings(parsedNet.marking);
                this._displayService.display(parsedNet, { triggeredByFiring: false });
                this._panningService.fitViewToGraph(parsedNet);
                if (inDrawTab) {
                    this._panningService.nudgeViewBox(0, -80);
                    this._panningService.expandViewBox(1.1);
                }
                if (this._modeService.isExamMode(Tab.DRAW) && inDrawTab) {
                    this._toasterService.showSuccess(
                        'TOASTER.HEADER.SUCCESS',
                        'TOASTER.BODY.NET_LOADED_SUCCESSFULLY_HIDDEN',
                    );
                } else {
                    this._toasterService.showSuccess('TOASTER.HEADER.SUCCESS', 'TOASTER.BODY.NET_LOADED_SUCCESSFULLY');
                }
                // Build node map and apply parallel offsets to arcs
                const nodeMap = new Map<string, DiagramNode>();
                parsedNet.allNodes.forEach((node: DiagramNode) => nodeMap.set(node.id, node));
                applyParallelOffsetsToArcs(parsedNet.arcs, nodeMap);
            } else {
                this._toasterService.showWarning('TOASTER.HEADER.PARSER_ERROR', 'TOASTER.BODY.FILE_NOT_INTERPRETABLE');
            }
        } catch (error) {
            this._toasterService.showError('TOASTER.HEADER.PROCESSING_ERROR', 'TOASTER.BODY.CRITICAL_PARSING_ERROR');
        }
    }

    /**
     * Processes an LPN file (File object) and loads it into the LPN canvas.
     * Uses the same path as drag-and-drop on the token-trail tab.
     */
    public loadLpnFile(file: File): void {
        this._fileReader
            .readFile(file)
            .pipe(take(1))
            .subscribe((content) => {
                if (!content) {
                    this._toasterService.showWarning(
                        'TOASTER.HEADER.READ_ERROR',
                        'TOASTER.BODY.FILE_EMPTY_OR_UNREADABLE',
                    );
                    return;
                }

                try {
                    const parsedDiagram = this._parser.parse(content);
                    if (parsedDiagram) {
                        const targetLpnService = this._customLpnService || this._lpnService;
                        targetLpnService.loadLpnFromDiagram(parsedDiagram);
                        this._toasterService.showSuccess(
                            'TOASTER.HEADER.SUCCESS',
                            'TOASTER.BODY.NET_LOADED_SUCCESSFULLY',
                        );
                    } else {
                        this._toasterService.showWarning(
                            'TOASTER.HEADER.PARSER_ERROR',
                            'TOASTER.BODY.FILE_NOT_INTERPRETABLE',
                        );
                    }
                } catch (err) {
                    console.error('Error importing LPN file:', err);
                    this._toasterService.showError(
                        'TOASTER.HEADER.PROCESSING_ERROR',
                        'TOASTER.BODY.CRITICAL_PARSING_ERROR',
                    );
                }
            });
    }
}
