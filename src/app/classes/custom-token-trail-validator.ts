import { Observable } from 'rxjs';
import { GLPK } from 'glpk.js';
import { PetriNet } from '../../../ilpn-components/src/lib/models/pn/model/petri-net';
import { Place } from '../../../ilpn-components/src/lib/models/pn/model/place';
import { SubjectTo } from '../../../ilpn-components/src/lib/models/glpk/subject-to';
import { TokenTrailValidator } from '../../../ilpn-components/src/lib/algorithms/pn/validation/token-trails/token-trail-validator';

export class CustomTokenTrailValidator extends TokenTrailValidator {
    constructor(
        model: PetriNet,
        spec: PetriNet,
        solver$: Observable<GLPK>,
        private fixedMarkings: Record<string, Record<string, number>>,
    ) {
        super(model, spec, solver$);
    }

    protected override modelPlaceConstraints(place: Place, specNet: PetriNet): SubjectTo[] {
        const constraints = super.modelPlaceConstraints(place, specNet);

        // Lock already-filled conditions to their existing markings
        for (const [condId, markings] of Object.entries(this.fixedMarkings)) {
            const expectedValue = markings[place.getId()] ?? 0;
            const varId = this.getPlaceVariableId(0, condId);
            constraints.push(...this.equal(this.variable(varId), expectedValue).constraints);
        }

        return constraints;
    }
}
