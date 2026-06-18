# LPN Token Trail Goals & Progression System Documentation

This document describes the design, implementation, and optimizations of the Goals and Difficulty Progression system built for the Labeled Petri Net (LPN) Token Trail validation view.

---

## 1. Architecture & Reactive Sync

The progression system is powered by the `TokenTrailGoalsService` ([token-trail-goals.service.ts](file:///Users/alexanderkolbfleisch/Developer/taco-trails/src/app/services/token-trail-goals.service.ts)).

### Reactive Synchronization

Since the primary Petri net diagram state is held inside `SourcePetriNetService` as an RxJS `BehaviorSubject`, it is not tracked reactively by default inside Angular `effects`. To solve this:

- We declared a reactive signal `sourceNet = signal<Diagram | null>(null)` in `TokenTrailGoalsService`.
- We subscribed to the `sourceNet$` RxJS stream in the constructor to keep the signal in sync.
- We read `this.sourceNet()` inside the service's goal-generation and goal-evaluation effects. This ensures that the goals are dynamically regenerated whenever the user loads a new Petri net.

---

## 2. Difficulty Unlocking & Persistence

Progression uses four levels: `easy`, `medium`, `hard`, and `expert`.

- **Difficulty Unlock Storage**: Difficulty progression states are loaded and saved to `localStorage` under the keys `token-trail-unlocked-puzzle` and `token-trail-unlocked-construction`.
- **Locked Difficulty Grey-Out**: Modified the `MenuAction` list inside the toolbar actions so that menu items bind to the unlocked sets (`disabled: !this.goalsService.unlockedPuzzle().has('medium')`). This greys out and locks higher difficulties natively in the Material menus.

---

## 3. Real-Time vs Delayed Evaluation & Auto-Unlock

- **Learn Mode**: Goal evaluations are executed in real-time as the user draws or connects items.
- **Exam Mode**: Goal evaluations only trigger when the user clicks the explicit **Validate LPN** toolbar button.
- **Automatic Unlocking**: In Learn Mode, the moment the LPN drawing becomes correct (valid token trails and all goals met), the next difficulty is **automatically unlocked** in the background, firing a congratulations toast notification. The user does not need to click the Validate button to progress.

---

## 4. Generalized Pre-Flight Capability Checks

Upon loading any arbitrary source Petri net $N = (P, T, F, W, M_0)$, the `TokenTrailGoalsService` analyzes its topology and state space to discover which process behaviors are possible using a lightweight BFS State Space Explorer:

1. **`hasDirectSequence(A, B)`**:
    - _Logic_: Check if transition $A$ can be followed directly by $B$.
    - _Implementation_: Find if there is a place $p \in P$ such that $(A, p) \in F$ and $(p, B) \in F$, and there is a reachable marking where firing $A$ enables $B$.
2. **`hasConflict(Y, Z)`**:
    - _Logic_: Check if two transitions $Y$ and $Z$ represent a choice/conflict (alternative branches).
    - _Implementation_: Structural check ($\bullet Y \cap \bullet Z \neq \emptyset$) paired with a state-space check confirming both are reachable from $M_0$, but there is no reachable marking $M$ where they can fire concurrently.
3. **`hasConcurrency(A, B)`**:
    - _Logic_: Check if transitions $A$ and $B$ can fire in parallel.
    - _Implementation_: Find a reachable marking $M$ where $M(p) \ge W(p, A) + W(p, B)$ for all $p \in \bullet A \cup \bullet B$.

---

## 5. Dynamic & Fallback Goal Formulation

For Construction Mode, use the results of the pre-flight checks to assign active goals. If a required capability is missing in the arbitrary net, a structural fallback is applied.

To ensure that clicking the difficulty switch or selecting a level yields different goals every time, candidate selections (such as direct sequence pairs, conflict pairs, concurrent pairs, and loop labels) are collected into pools and chosen at random rather than deterministically choosing the first match:

### Easy Mode (Focus: Causal Sequences)

- **Goal 1 (Sequence Net Topology)**: The LPN must satisfy the Sequence Net Topology properties (no cycles, single source place, single sink place, etc.).
- **Goal 2 (Causal Sequence)**: "Create a sequence where event $A$ strictly precedes event $B$."
    - _Dynamic Mapping_: Select a pair $(A, B)$ where `hasDirectSequence(A, B) === true`.
    - _Fallback_: "Ensure there is a path from a start place to any active transition" (checked via LPN BFS/DFS path traversal from start conditions to all active events).
    - _Evaluation_: Graph traversal (BFS/DFS) on the user's LPN from event node $A$ to event node $B$.

### Medium Mode (Focus: Concurrency & Loops)

- **Goal 1 (Partial Order Net Topology)**: The LPN must satisfy the Partial Order Net Topology properties (acyclic, start/end conditions, etc.).
- **Goal 2 (True Concurrency)**: "Ensure that event $A$ and event $B$ can fire concurrently."
    - _Dynamic Mapping_: Select a pair $(A, B)$ where `hasConcurrency(A, B) === true`.
    - _Fallback_: "Model a loop where event $A$ can be repeated infinitely." (Checked via T-invariant $C \cdot y = 0$ on the user's LPN where the entry for $A$ is greater than 0).
    - _Evaluation_: Use LPN BFS Explorer to find a reachable marking $M$ in the user's LPN where $M(p) \ge W_{in}(p, A) + W_{in}(p, B)$ for all $p \in P_L$.

### Hard Mode (Focus: Alternatives / Conflicts)

- **Goal 1 (State Graph Net Topology)**: The LPN must satisfy the State Graph Net Topology properties.
- **Goal 2 (Alternative Branching)**: "Ensure that event $Y$ and event $Z$ are mutually exclusive."
    - _Dynamic Mapping_: Select a pair $(Y, Z)$ where `hasConflict(Y, Z) === true`.
    - _Fallback_: "Ensure there is a causal path from $Y$ to $Z$." (Sequence fallback).
    - _Evaluation_: Verify structurally that $Y$ and $Z$ share a preset Condition, and verify behaviorally that no reachable marking in the user's LPN enables $Y$ and $Z$ at the same time.

### Expert Mode (Focus: Random Multi-Constraint Complexity)

- **Selection Logic**: Instead of showing a fixed topology goal plus all possible behavior goals, Expert Mode dynamically analyzes the source net capabilities (Concurrency, Conflicts, Loops), instantiates the corresponding goals, randomly shuffles them, and displays exactly **two** active goals.
- **Goals Offered**:
    - **True Concurrency**: Evaluates if $A$ and $B$ are concurrent in the LPN (if concurrency is possible in the source net).
    - **Alternative Branching**: Evaluates if $Y$ and $Z$ represent a choice/conflict and share a preset Condition (if conflict is possible in the source net).
    - **Loop Invariant**: Evaluates if loop label $A$ can be executed repeatedly (if loops are possible in the source net).
    - **Causal Sequence (Fallback)**: If the source net doesn't support at least two of the primary properties, sequence path fallbacks are populated to guarantee exactly two goals are shown.

## 6. Lightweight State Space Explorer

To evaluate behavioral properties (e.g., transitions firing concurrently), the service builds a local representation of the constructed LPN and runs a Breadth-First Search (BFS) state space generator.

- **Enabled Check**: Two transitions $T_1$ and $T_2$ are concurrent in marking $M$ if they are enabled individually and their combined requirements do not exceed current tokens: $M(p) \ge Preset(p, T_1) + Preset(p, T_2)$ for all places $p$.
- **Performance Cap**: Traversal is capped at 500 states to prevent memory issues on cyclic/unbounded LPN drawings, completing in less than 1ms.

---

## 7. Premium Minimizable Goals Panel UI

- **Location**: Absolute positioned overlay at the top-right of the LPN canvas.
- **Aesthetic**: Glassmorphism card backdrop (`blur(10px)`) matching the rest of the application.
- **Font Uniformity**: Enforced the global `'Courier New', sans-serif` font family override.
- **Icon Rendering Fix**: Excluded `mat-icon` and `.material-icons` from the font override (`*:not(mat-icon):not(.material-icons)`) to ensure Google Material Icons render correctly instead of printing raw text glyph names.
- **Accessibility Linting**: Replaced the outer container div with a focusable HTML `<button>` and used clean status icons (`check_circle` vs `radio_button_unchecked`) for a robust interactive collapse/expand toggle.

---

## 8. Construction Mode LPN Solution Synthesis

To assist users when they are stuck in Construction Mode, a dynamic LPN solution synthesis system has been implemented:

### Solution Generation & Validation

- **Trigger**: When the user clicks the "Show Solution" lightbulb button in Construction Mode, the canvas is temporarily replaced with a synthesized LPN.
- **Synthesis Process**: An LPN is generated from valid firing sequences of the source Petri net via region synthesis.
- **Verification Loop**: Reruns active goal checking (`evaluateGoals(L_sol)`) within the 15-attempt validation loop. A solution is only accepted if it is semantically valid AND all three active goals are completed.
- **No Artificial Event Duplication**: If the "Label Splitting" goal is active, transition $X$ is programmatically split into duplicate nodes $X_1$ and $X_2$ while copying their exact preset/postset arcs, maintaining mathematically valid token flows. Disconnected, floating, or random duplicate transitions are never appended.
- **Layouting**: The Sugiyama layout algorithm is run on the adjusted LPN structure, aligning the transitions and conditions beautifully.

### Drawing Backup & Restoration

- **State Preservation**: Before displaying the solution, the user's active drawing (elements and connections) is deep-cloned and stored in backup fields (`backedUpDrawnElements`, `backedUpConnections`).
- **Toggle Off**: When the user hides the solution, the backup is restored, putting the user's drawing back on the canvas.
- **Failure Recovery**: If the region synthesis fails (e.g. error or all 15 attempts exhausted), the backup is automatically restored, ensuring no user progress is lost.
- **Canvas Read-Only Constraint**: All canvas interactions and drawing actions are disabled when the solution mode is active, preventing accidental modifications of the solution LPN.

---

## 9. Puzzle Mode LPN Synthesis & Parameter Tuning

To ensure generated LPNs in Puzzle Mode remain readable and appropriately difficult, we adjust synthesis parameters and enforce goal checks during synthesis:

- **Difficulty Configurations**:
    - **Easy**: Uses shorter trace lengths and fewer traces to keep the net simple, with no short loops and no arc weights.
    - **Medium**: Moderate trace lengths and count with no short loops.
    - **Hard**: Longer trace lengths and a wider trace search space to synthesize conflicts.
    - **Expert**: Maximum trace lengths and traces to encompass all concurrency, loops, and conflict combinations possible.
- **Goals Verification**:
    - We run the goals check dynamically on candidate LPNs during the retry loop. If a candidate LPN does not meet all active difficulty goals, we reject it and retry synthesis, guaranteeing that the puzzle is solvable and contains the expected behavioral patterns.
