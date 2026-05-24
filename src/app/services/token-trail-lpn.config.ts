import { RegionsConfiguration } from '../../../ilpn-components/src/lib/utility/glpk/model/regions-configuration';
import { SynthesisConfiguration } from '../../../ilpn-components/src/lib/algorithms/pn/regions/classes/synthesis-configuration';
import { LpnGenerationDifficulty } from './token-trail-state.service';

export interface LpnGenerationConfiguration {
    splittingProbability: number;
    synthesisConfig: RegionsConfiguration & SynthesisConfiguration;
    traceLengthMultiplier: number;
    maxTracesMultiplier: number;
    maxEdgesMultiplier: number;
}

export const DIFFICULTY_CONFIGURATIONS: Record<LpnGenerationDifficulty, LpnGenerationConfiguration> = {
    easy: {
        splittingProbability: 0.25,
        synthesisConfig: { noShortLoops: true, noArcWeights: true },
        traceLengthMultiplier: 0.5,
        maxTracesMultiplier: 0.2,
        maxEdgesMultiplier: 1.0,
    },
    medium: {
        splittingProbability: 0.6,
        synthesisConfig: { noShortLoops: true },
        traceLengthMultiplier: 0.8,
        maxTracesMultiplier: 0.3,
        maxEdgesMultiplier: 1.5,
    },
    hard: {
        splittingProbability: 0.5,
        synthesisConfig: {},
        traceLengthMultiplier: 1.5,
        maxTracesMultiplier: 0.5,
        maxEdgesMultiplier: 2.5,
    },
};
