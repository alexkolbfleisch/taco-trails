import { Diagram } from '../classes/diagram/diagram';
import { PetriNet as IlpnPetriNet } from '../../../ilpn-components/src/lib/models/pn/model/petri-net';
import { LabeledNetNode, LabeledNetEdge } from '../classes/labeled-net.model';
import { TokenTrailValidationResult } from '../../../ilpn-components/src/lib/algorithms/pn/validation/classes/validation-result';
import { JsonPetriNetParserService } from '../../../ilpn-components/src/lib/models/pn/io/parser/json-petri-net-parser.service';
import { SerializationService } from '../services/serialization.service';

export function convertSourceNetToIlpn(
    sourceNet: Diagram,
    serializationService: SerializationService,
    jsonParser: JsonPetriNetParserService,
): IlpnPetriNet {
    return parseAndEnsureLabels(serializationService.serializeJson(sourceNet), jsonParser);
}

export function convertLpnToIlpn(
    drawnElements: LabeledNetNode[],
    connections: LabeledNetEdge[],
    serializationService: SerializationService,
    jsonParser: JsonPetriNetParserService,
): IlpnPetriNet {
    const jsonStr = serializationService.serializeLpn(drawnElements, connections, 'json');
    try {
        const raw = JSON.parse(jsonStr);
        if (raw.places && raw.labels) {
            for (const placeId of raw.places) {
                delete raw.labels[placeId];
            }
        }
        return parseAndEnsureLabels(JSON.stringify(raw), jsonParser);
    } catch {
        return parseAndEnsureLabels(jsonStr, jsonParser);
    }
}

export function parseAndEnsureLabels(jsonStr: string, jsonParser: JsonPetriNetParserService): IlpnPetriNet {
    const net = jsonParser.parse(jsonStr)!;
    net.getTransitions().forEach((t) => {
        if (t.label === undefined) {
            t.label = t.getId();
        }
    });
    return net;
}

export function mapValidatorResultsToSolvedTrails(
    results: TokenTrailValidationResult[],
): Map<string, Record<string, number>> {
    const solvedTrailsMap = new Map<string, Record<string, number>>();
    for (const res of results) {
        const markingRecord: Record<string, number> = {};
        for (const key of res.tokenTrail.getKeys()) {
            const prefix = 'n0_';
            if (key.startsWith(prefix)) {
                const elId = key.substring(prefix.length);
                markingRecord[elId] = res.tokenTrail.get(key) ?? 0;
            }
        }
        solvedTrailsMap.set(res.placeId, markingRecord);
    }
    return solvedTrailsMap;
}
