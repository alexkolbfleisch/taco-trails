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

Progression uses three levels: `easy`, `medium`, and `hard`.

- **Difficulty Unlock Storage**: Difficulty progression states are loaded and saved to `localStorage` under the keys `token-trail-unlocked-puzzle` and `token-trail-unlocked-construction`.
- **Locked Difficulty Grey-Out**: Modified the `MenuAction` list inside the toolbar actions so that menu items bind to the unlocked sets (`disabled: !this.goalsService.unlockedPuzzle().has('medium')`). This greys out and locks higher difficulties natively in the Material menus.

---

## 3. Real-Time vs Delayed Evaluation & Auto-Unlock

- **Learn Mode**: Goal evaluations are executed in real-time as the user draws or connects items.
- **Exam Mode**: Goal evaluations only trigger when the user clicks the explicit **Validate LPN** toolbar button.
- **Automatic Unlocking**: In Learn Mode, the moment the LPN drawing becomes correct (valid token trails and all goals met), the next difficulty is **automatically unlocked** in the background, firing a congratulations toast notification. The user does not need to click the Validate button to progress.

---

## 4. Pool-Based Goal Randomization

To prevent static goals, they are generated randomly from pools when a net is loaded or difficulty is toggled:

### Easy Mode:

- **Event Count**: LPN must contain at least $T'$ events, where $T'$ is a random integer in $[T - 1, T + 1]$ (min 1).
- **Condition Count**: LPN must contain at most $P'$ conditions, where $P'$ is a random integer in $[P + 1, P + 3]$.
- **Random Constraint**: Either requires event label $X$ (randomly selected from transitions) to appear at least once, or requires the LPN to contain at least 1 start condition (initial marking $> 0$).

### Medium Mode:

- **Event Count**: LPN must contain at least $T'$ events, where $T'$ is random in $[T, T + 2]$.
- **Condition Count**: LPN must contain at most $P'$ conditions, where $P'$ is random in $[P, P + 1]$.
- **Random Constraint**: Picked randomly from:
    1. Event label $X$ must appear at least 2 times (duplicate event).
    2. Event label $X$ must have at least one incoming and one outgoing connection (flow check).
    3. LPN must contain at least 2 start conditions.

### Hard Mode:

- **Event Count**: LPN must contain at least $T'$ events, where $T'$ is random in $[T + 1, T + 2]$.
- **Condition Count**: LPN must contain at most $P'$ conditions, where $P'$ is random in $[P - 1, P]$ (min 1).
- **Random Constraint**: Picked randomly from:
    1. Two random event labels $X$ and $Y$ must be executable in parallel.
    2. Event label $X$ must appear at least 3 times.
    3. LPN must contain exactly a random number of start conditions (e.g. 1 or 2).

---

## 5. Lightweight State Space Explorer

To evaluate behavioral parallelism (e.g., transitions firing concurrently), the service builds a local representation of the constructed LPN and runs a Breadth-First Search (BFS) state space generator.

- **Enabled Check**: Two transitions $T_1$ and $T_2$ are concurrent in marking $M$ if they are enabled individually and their combined requirements do not exceed current tokens: $M(p) \ge Preset(p, T_1) + Preset(p, T_2)$ for all places $p$.
- **Performance Cap**: Traversal is capped at 500 states to prevent memory issues on cyclic/unbounded LPN drawings, completing in less than 1ms.

---

## 6. Premium Minimizable Goals Panel UI

- **Location**: Absolute positioned overlay at the top-right of the LPN canvas.
- **Aesthetic**: Glassmorphism card backdrop (`blur(10px)`) matching the rest of the application.
- **Font Uniformity**: Enforced the global `'Courier New', sans-serif` font family override.
- **Icon Rendering Fix**: Excluded `mat-icon` and `.material-icons` from the font override (`*:not(mat-icon):not(.material-icons)`) to ensure Google Material Icons render correctly instead of printing raw text glyph names.
- **Accessibility Linting**: Replaced the outer container div with a focusable HTML `<button>` and used clean status icons (`check_circle` vs `radio_button_unchecked`) for a robust interactive collapse/expand toggle.

---

## 7. Construction Mode LPN Solution Synthesis

To assist users when they are stuck in Construction Mode, a dynamic LPN solution synthesis system has been implemented:

### Solution Generation & Validation

- **Trigger**: When the user clicks the "Show Solution" lightbulb button in Construction Mode, the canvas is temporarily replaced with a synthesized LPN.
- **Synthesis Process**: An LPN is generated from valid firing sequences of the source Petri net via region synthesis.
- **Goal Post-Processing**: The service adjusts the synthesized LPN to ensure it satisfies active goals:
    - **Duplicated/Triplicated Events**: Parallel duplicates of events with the same label are added (with identical presets/postsets and weights), preserving LPN correctness under token trail validation while satisfying count constraints.
    - **Minimum Events Goal**: If the synthesized LPN has fewer events than the goal requires, random events are duplicated in parallel until the threshold is met.
- **Layouting**: The Sugiyama layout algorithm is run on the adjusted LPN structure, aligning the parallel transitions and conditions beautifully.

### Drawing Backup & Restoration

- **State Preservation**: Before displaying the solution, the user's active drawing (elements and connections) is deep-cloned and stored in backup fields (`backedUpDrawnElements`, `backedUpConnections`) using `TokenTrailMergeService`'s clone methods.
- **Toggle Off**: When the user hides the solution, the backup is restored, putting the user's drawing back on the canvas.
- **Failure Recovery**: If the region synthesis fails (e.g. error or all 15 attempts exhausted), the backup is automatically restored, ensuring no user progress is lost.
- **Canvas Read-Only Constraint**: All canvas interactions and drawing actions are disabled when the solution mode is active, preventing accidental modifications of the solution LPN.
