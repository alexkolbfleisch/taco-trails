import { inject, Injectable } from '@angular/core';

import { PlayService } from './play.service';
import { Diagram } from '../classes/diagram/diagram';

@Injectable({ providedIn: 'root' })
export class PlayValidationService {
    private _playService = inject(PlayService);

    /**
     * Finds valid firing sequences in a Petri net diagram beginning at its start marking.
     * @param diagram  - The Petri net diagram for which firing sequences are to be found.
     * @param minTransitionCount - The minimum number of transitions in the firing sequences.
     * @param maxSequencesCount - The maximum number of firing sequences to find.
     */
    findSequences(diagram: Diagram, minTransitionCount: number, maxSequencesCount: number): void {
        const visitedSequences = new Map<number, Set<string>>();
        const queue: { marking: Record<string, number>; sequence: string[] }[] = [];

        // Save the current marking so we can restore it after sequence generation
        const originalMarking = { ...diagram.marking };

        diagram.resetMarking();
        const startMarking = { ...diagram.marking };
        queue.push({ marking: startMarking, sequence: [] });
        let foundSequencesCount = 0;

        while (queue.length > 0 && foundSequencesCount < maxSequencesCount) {
            const { marking, sequence } = queue.shift()!;
            const currentLength = sequence.length;

            if (currentLength >= minTransitionCount) {
                const newSequenceStr = sequence.join(' ');
                const sequencesOfLength = visitedSequences.get(currentLength) || new Set<string>();
                if (!sequencesOfLength.has(newSequenceStr)) {
                    sequencesOfLength.add(newSequenceStr);
                    visitedSequences.set(currentLength, sequencesOfLength);
                    this._playService.addFiringEntry(newSequenceStr, currentLength, marking, true);
                    foundSequencesCount++;
                }
            }

            for (const transition of diagram.transitions) {
                if (foundSequencesCount >= maxSequencesCount) break;
                diagram.marking = { ...marking };

                if (transition.isActivated()) {
                    transition.fire(false);
                    diagram.updateMarking();
                    const currentMarking: Record<string, number> = { ...diagram.marking };
                    const newSequence = [...sequence, transition.label || transition.id];

                    queue.push({
                        marking: currentMarking,
                        sequence: newSequence,
                    });
                }
            }
        }

        // Restore the original marking after searching for sequences
        diagram.marking = originalMarking;
    }
}
