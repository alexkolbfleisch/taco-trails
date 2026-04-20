This reference guide provides a combined overview of **Token Trail Semantics** (the theory) and its **Validation Algorithm** (the implementation), based on research by Kovář and Bergenthum and the `ILPN-Components` library.

---

## 1. Theoretical Foundation

Token trail semantics defines whether a **labeled net** (specification) is in the **net language** of a **marked Petri net** (model). Unlike legacy semantics (like firing sequences or state graphs), it can simultaneously handle concurrency, merging of conflicts, and loops.

### 1.1 Core Definitions

- **Marked Petri Net ($N$):** A model $(P, T, W, m_0)$ where $P$ is a set of places and $T$ is a set of transitions.
- **Marked Labelled Net ($L$):** A specification $(C, E, F, A, \lambda, m_i)$ where $E$ (events) are labeled with actions from $A$.
- **Net Language ($\mathcal{N}(N)$):** The set of all labeled nets where a valid "token trail" exists for every place in the original Petri net.

### 1.2 The Token Trail Conditions

A marking $x$ of a labeled net $L$ is a token trail for a place $p \in P$ if it satisfies the following mathematical constraints:

1.  **Enabling Condition (I):** For every event $e \in E$, the tokens in its pre-set (level) must satisfy the weight required by place $p$:
    $$\forall e \in E : e^k(x) \ge W(p, \lambda(e))$$
2.  **Flow/Rise Condition (II):** The change in tokens (rise) at each event must match the change in the Petri net's place $p$:
    $$\forall e \in E : e^\Delta(x) = W(\lambda(e), p) - W(p, \lambda(e))$$
3.  **Initial Marking Condition (III):** The weighted sum of tokens in the labeled net must equal the initial marking of $p$:
    $$\sum_{c \in C} m_i(c) \cdot x(c) = m_0(p)$$

---

## 2. Validation Algorithm Implementation

To decide **Net Language Inclusion**, the implementation iterates over all places of the Petri net and solves an **Integer Linear Programming (ILP)** problem for each.

### 2.1 The Validation System

The following TypeScript-inspired logic (derived from the `ILPN-Components` validation algorithms) implements the check for a place $p$:

```typescript
/**
 * Logic adapted from ILPN-Components validation module.
 * Represents the Net Language Inclusion check using ILP.
 */
export class TokenTrailValidator {
    /**
     * Validates if a Labelled Net is in the Net Language of a Petri Net.
     */
    public validate(petriNet: PetriNet, specification: LabelledNet): ValidationResult {
        const result = new ValidationResult();

        // Iterate over all places of the marked Petri net N
        for (const place of petriNet.getPlaces()) {
            // Solve the token trail problem for the current place
            const trail = this.findTokenTrailForPlace(place, petriNet, specification);

            if (trail) {
                result.markPlaceValid(place, trail); // Place is highlighted green
            } else {
                result.markPlaceInvalid(place); // Place is highlighted red
                // Net language inclusion fails early if one place has no trail
                result.setInclusion(false);
            }
        }
        return result;
    }

    private findTokenTrailForPlace(p: Place, N: PetriNet, L: LabelledNet): Marking | undefined {
        const solver = new LpSolver();

        // Condition (1): Ix >= w_I (Enabling)
        // Condition (2): (O - I)x = w_O - w_I (Flow/Rise)
        // Condition (3): mi' * x = m0(p) (Initial Marking)

        const system = this.constructILPSystem(p, N, L);
        return solver.solveInteger(system);
    }
}
```

### 2.2 Algorithm Complexity

- **Search Space:** Solving general ILP is NP-hard.
- **Optimization:** Petri net matrices are typically sparse, and the problem structure is block-structured, allowing for efficient fixed-parameter tractable solving.

---

## 3. Summary of Simulation Properties

The importance of this validation logic lies in the following proven properties:

- **Simulation:** If a labeled net passes validation, the Petri net simulates its state-transition behavior.
- **Step Language Inclusion:** If $L \in \mathcal{N}(N)$, then the step language of $L$ is a subset of the step language of $N$ ($\mathcal{L}(L) \subseteq \mathcal{L}(N)$).
- **Morphisms:** Token trail semantics covers synchronous net morphisms and finite unfoldings.

> **Agent Note:** When using this for validation tasks, remember that a place is considered "invalid" in the tool if no marking in the specification net can consistently represent the token flow of that specific place from the model.
