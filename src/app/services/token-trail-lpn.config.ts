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
    [LpnGenerationDifficulty.Easy]: {
        splittingProbability: 0.25,
        synthesisConfig: { noShortLoops: true, noArcWeights: true },
        traceLengthMultiplier: 0.5,
        maxTracesMultiplier: 0.2,
        maxEdgesMultiplier: 1.0,
    },
    [LpnGenerationDifficulty.Medium]: {
        splittingProbability: 0.6,
        synthesisConfig: { noShortLoops: true, noArcWeights: true },
        traceLengthMultiplier: 0.8,
        maxTracesMultiplier: 0.3,
        maxEdgesMultiplier: 1.5,
    },
    [LpnGenerationDifficulty.Hard]: {
        splittingProbability: 0.1,
        synthesisConfig: { noArcWeights: true },
        traceLengthMultiplier: 1.2,
        maxTracesMultiplier: 0.5,
        maxEdgesMultiplier: 2.5,
    },
    [LpnGenerationDifficulty.Expert]: {
        splittingProbability: 0.1,
        synthesisConfig: { noArcWeights: true },
        traceLengthMultiplier: 1.6,
        maxTracesMultiplier: 0.7,
        maxEdgesMultiplier: 3.0,
    },
};
