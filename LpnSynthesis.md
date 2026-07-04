# Labeled Petri Net (LPN) Synthesis & Verification Guide

This document describes the design, implementation, and verification approach for **Labeled Petri Net (LPN) Synthesis** in the Token Trail tab. It details both the simplified Easy Mode sequence net approach and the standard region synthesis route for higher difficulties.

---

## 1. Core Synthesis Process

The LPN is generated from an original Petri net in `TokenTrailLpnService.createLPNWithSynthesis`:

### 1.1 Trace Generation

- The play validation service calculates all possible execution paths (firing sequences/traces) from the original Petri net up to a difficulty-defined depth.
- Valid firing sequences containing non-empty transition labels are filtered.

### 1.2 Easy Mode (Direct Sequence Net Synthesis)

- **Bypass region synthesis**: Easy Mode does not use the GLPK region miner.
- **Trace Selection**: We select a random firing sequence from the pool of valid traces (seeding it with the active sequence goal `A -> B` if possible).
- **Sequence Net Construction**: We convert this single random firing entry directly into a sequence net path:
  $$c_1 \rightarrow t_1 \rightarrow c_2 \rightarrow t_2 \rightarrow \dots \rightarrow c_{n+1}$$
- **Validation & Marking**: The candidate is validated against the source Petri net to determine the unique token trail markings.

### 1.3 Medium, Hard, and Expert Modes (GLPK Region Synthesis)

- **Trace Seeding**: Traces are seeded to satisfy active capability-based goals:
    - **Concurrency**: Seeding interleaving traces (Medium difficulty).
    - **Conflict**: Seeding prefix-aligned conflict traces (Hard difficulty).
    - **Loop**: Seeding loop traces where the loop transition occurs exactly 0, 1, 2, and 3 times (Expert difficulty).
    - **Repeat**: Seeding only the trace containing exactly 2 occurrences of the repeat label to prevent complex branching and keep the synthesized LPN simple and linear.
- **Flat Trace Synthesis**: All selected traces (concurrency, conflict, loop) are compiled into a flat array of sequence nets and passed to `PetriNetRegionSynthesisService.synthesise` in a single run. This flat trace combination avoids GLPK solver contradictions.
- **Configured Splitting**: Transitions that should not be split (such as loop and conflict transitions) are protected in the input net construction, while other transitions use the difficulty's `splittingProbability` to resolve concurrent dependencies.
- **Retry Variation**: On the first attempt, only the minimal goal traces (`mustHave`) are sent to keep the net as clean as possible. On subsequent retry attempts, random additional traces are introduced to guide GLPK out of deterministic local minima.

### 1.4 Trace Selection & Seeding Details

To satisfy specific LPN validation goals, the trace selection explicitly includes:

- **Sequence**: A trace that executes transition $A$ before transition $B$.
- **Concurrency**: A pair of traces showing $A$ before $B$ and $B$ before $A$ ($AB$ and $BA$).
- **Loop**: A trace where the loop transition fires multiple times or at least once.
- **Conflict**: A pair of prefix-aligned conflict traces showing branch choices ($Y$ and $Z$), generalized to support choice branches within loops.
- **Hash-Based Variation**: The remaining traces are filled randomly up to the maximum trace budget. A hash of the chosen trace sequence set is checked against the previous run's hash to ensure each retry run synthesizes from a different variation of traces.

### 1.5 Transition Splitting & Protection Rules

During sequence net construction, if a trace contains duplicate transition labels, splitting behavior is defined strictly by the active goals:

- **Repeat Transitions (Split Probability = 1.0)**: Repeat transitions are ALWAYS split into separate unique instances (`_instance1`, `_instance2`, etc.) to prevent GLPK from trying to make an invalid cycle. Even if a transition is part of a conflict goal, it is split if it is also the active repeat target.
- **True Loop & Conflict Transitions (Split Probability = 0.0)**: We explicitly shield and protect loop and conflict transitions (unless they are the repeat target) from splitting, forcing GLPK to merge them into unified cycle or decision structures.
- **Other Transitions**: Split based on the difficulty configuration's `splittingProbability`.

---

## 2. Structure Reduction & Simplification

To prevent LPN layouts from becoming overly complex, three levels of optimization are applied:

### 2.1 Arc Weight Minimization

- Enabled `noArcWeights: true` in synthesis configuration across all difficulties to ensure single-weighted arcs (weight = 1).

### 2.2 Submodule Place Removers

- Apply `ImplicitPlaceRemoverService`, `DuplicatePlaceRemoverService`, and `DanglingPlaceRemoverService` in sequence to structurally simplify the synthesized net by removing redundant or dangling places.

### 2.3 Silent Conditions Pruning

- Manually prune any remaining LPN conditions that have no trail markings (unmapped `cX` places) along with their incoming/outgoing arcs, ensuring only basis conditions representing source net places (`px + py`) are shown in the UI.

---

## 3. Validation & The Retry Loop

To guarantee that any synthesized LPN presented to the user is 100% correct, a validation check is executed:

- **Validation Check**: `validatorService.validate(ilpnSource, ilpnSpec)` computes the solved token trails for all places.
- **Goal Verification**:
    - **Graph Cycle Loop Check**: The loop invariant check (`checkTInvariant`) is implemented as a directed cycle search in the LPN graph. This ensures the loop goal is satisfied robustly without being derailed by GLPK composite/redundant places or boundary start/sink places.
- **Retry Logic**: If the LPN fails validation or does not meet active difficulty goals, synthesis is retried with a different trace selection (capped at 50 attempts in Construction Mode, and 15 attempts in Puzzle Mode).
- **Consolidated Finalization**: Validated candidate LPNs are populated with their solved markings, checked for goals, and applied to the canvas.

---

## 4. Puzzle Mode vs. Construction Mode Solution Presentation

### 4.1 Puzzle Mode

- **Unmarked by Default**: The generated LPN initially displays no token markings.
- **Generic Labeling**: Conditions are always labeled generically (`c1`, `c2`, ... `cx`).
- **Show Solution**: Toggling the solution displays the solved token counts inside the conditions while retaining the generic `c1`, `c2`, ... labeling (the place labels are hidden).

### 4.2 Construction Mode

- **Show Solution**: When showing the solution, the canvas is populated with the solved LPN structure.
- **Dynamic Labeling**: Conditions display the place names (`p1 + p5` or `p2 + 2*p3`) to represent their active token trail markings.

---

## 5. Caching & Tab-Switch Preservation

### 5.1 Solution Cache

- On successful validation, the solved token trails are saved in `solutionCache` to bypass the solver when toggling the solution display.
- Any structural edits to the canvas invalidate the cache.

### 5.2 Structural Signatures

- We compute a structural signature of the source Petri net (`nodes::markings::arcs`).
- If the signature matches upon tab re-entry, regeneration is bypassed to preserve the user's active drawing/progress.
