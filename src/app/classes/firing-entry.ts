/**
 * Representing a transition firing sequence in the Petri net.
 */
export class FiringEntry {
    private _delimiters = /\s+|,|;|, |; /;

    constructor(
        public id: number,
        public firingSequence: string,
        public transitionCount: number,
        public endMarking: Record<string, number>,
        public isClosed: boolean,
        public isValid: boolean | undefined,
        public isPlaying = false,
        public error: FiringSequenceError | null = null,
    ) {}

    /**
     * Returns the labels of the transitions in the firing sequence as an array of strings.
     * @return The array of transition labels.
     */
    get labels(): string[] {
        return this.firingSequence
            .trim()
            .split(this._delimiters)
            .filter((label) => label.length > 0);
    }
}

/**
 * Represents an error in a firing sequence, including the translatable error type (e.g., 'PLAY.NOT_ACTIVATED'),
 * the invalid label, and the sequence context (visited labels until the error occured).
 */
export interface FiringSequenceError {
    type: string;
    invalidLabel: string;
    visitedLabels: string[];
}
