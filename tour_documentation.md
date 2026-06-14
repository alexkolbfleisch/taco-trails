# LPN Token Trail Tour Documentation

This document describes the design, implementation, and quality improvements made to the interactive guided tour for the Labeled Petri Net (LPN) Token Trail validation tab.

## 1. Architecture Overview

The tour is managed by the `TokenTrailTourService` ([token-trail-tour.service.ts](file:///Users/alexanderkolbfleisch/Developer/taco-trails/src/app/services/token-trail-tour.service.ts)), which integrates [Shepherd.js](https://shepherdjs.dev/) (`angular-shepherd`) to provide a step-by-step interactive overlay walkthrough of the application's layout, modes, and controls.

Key responsibilities:

- **State Preservation**: Automatically backs up the user's current Petri net and raw text state upon tour start, loading a standardized example net for the duration of the tour, and restores the user's work when the tour is cancelled or finished.
  Ever- **Interactive Control**: Listens to custom signals (`tokenCountChangedInTour`, `elementDroppedInTour`, `conditionMergedInTour`, `conditionUnmergedInTour`) to enable/disable the "Next" step buttons dynamically, ensuring the user performs the corresponding interaction before advancing.
- **Active Step Tracking**: Exposes a `currentStepId` signal so that rendering components can conditionally display interactive helpers (like the scroll animation) during specific steps of the tour.
- **SVG Viewport Pan/Zoom Reset**: Automatically pans/zooms the SVG canvases to center elements during relevant tour steps.

---

## 2. Interactive Tour Steps

The tour guides the user through 15 distinct steps, alternating display modes and showcasing core features:

1. **Welcome Step (`step-welcome`)**: Welcome introduction explaining Token Trail validation.
2. **Split View Layout (`step-layout`)**: Explains the dual canvas layout (original Petri Net on the left, LPN drawing area on the right).
3. **Puzzle Mode Tokens (`step-puzzle`)**: Switches to Puzzle Mode, selects the first place, and prompts the user to edit LPN condition token counts using the scroll wheel. An animated mouse helper is displayed next to the condition.
4. **Synthesis & Difficulties (`step-synthesize`)**: Highlights the "Synthesize LPN" button and explains that solving puzzles unlocks higher difficulty levels (Easy, Medium, Hard).
5. **Puzzle Solution (`step-puzzle-solution`)**: Highlights the lightbulb button, explaining how it displays the correct token markings for all places in Puzzle Mode.
6. **Mode Switching (`step-mode-toggle`)**: Highlights the mode toggle button where the user can manually toggle between Puzzle Mode and Construction Mode.
7. **Drag & Drop (`step-construction`)**: Switches to Construction Mode, prompting the user to drag a place or transition from the left canvas and drop it onto the right LPN drawing canvas.
8. **Merging Conditions (`step-merge`)**: Preloads two conditions (`c1` and `c2`) on the LPN canvas and expects the user to drag one onto the other to visually merge them.
9. **Unmerging Conditions (`step-unmerge`)**: Expects the user to drag one of the visually merged conditions away from the anchor to split them back into separate nodes.
10. **Active Goals (`step-active-goals`)**: Highlights the active goals panel (`.goals-panel`) on the canvas and explains the custom structure and token requirements.
11. **Goal Difficulties (`step-goals-difficulty`)**: Highlights the trophy button (`emoji_events`), explaining how completing construction requirements unlocks the next level.
12. **Construction Solution (`step-construction-solution`)**: Highlights the lightbulb button in Construction Mode, explaining that it generates a complete LPN satisfying all goals.
13. **Upload Your Net (`step-upload`)**: Highlights the upload button for loading custom `.json`, `.xml`, or `.pnml` Petri Net files.
14. **Sample & Exam Nets (`step-examples`)**: Highlights the examples folder menu button for loading sample nets.
15. **Final Step (`step-finish`)**: Congratulates the user and ends the tour.

---

## 3. Implemented Improvements & Customizations

### A. Deactivating Mode Switching during the Tour

To prevent the user from switching display modes prematurely and breaking Shepherd's step assertions, the mode-switching toolbar toggle button is deactivated when the tour is running:

- **Code Implementation**: Updated the `isActive` attribute of the mode toggle toolbar action inside [token-trail-draw-display.ts](file:///Users/alexanderkolbfleisch/Developer/taco-trails/src/app/components/tab-toolbar/token-trail/token-trail-draw-display/token-trail-draw-display.ts):
    ```typescript
    isActive: !this.stateService.showingSolution() && !this.tourService.isTourRunning();
    ```

### B. Mode Toggle Button Highlighting

- Built a custom data attribute binder in [token-trail-draw-display.html](file:///Users/alexanderkolbfleisch/Developer/taco-trails/src/app/components/tab-toolbar/token-trail/token-trail-draw-display/token-trail-draw-display.html) that sets `[attr.data-tour]="action.icon"` on the toolbar buttons.
- Registered target step configurations in `TokenTrailTourService` using specific data selectors (e.g. `button[data-tour="construction"]`, `button[data-tour="science"]`, `button[data-tour="lightbulb_outline"]`, `button[data-tour="emoji_events"]`) to attach highlight bubbles cleanly.

### C. Bold Formatting Fixes in Shepherd Modals

Previously, the translatable tour step text values contained raw markdown syntax `**word**`, which rendered literally on the screen as `**word**` rather than rendering in bold.

- **Resolution**: Replaced the raw markdown bold markers with HTML `<strong>` tags in the translation assets:
    - [en.json](file:///Users/alexanderkolbfleisch/Developer/taco-trails/src/assets/i18n/en.json)
    - [de.json](file:///Users/alexanderkolbfleisch/Developer/taco-trails/src/assets/i18n/de.json)
- Because Shepherd.js naturally renders step texts containing HTML templates, this resolved the issue, and text inside `<strong>...</strong>` renders as bold text.

### D. Animated Mouse Wheel Scroll Helper

- During `step-puzzle`, an animated SVG overlay representing a mouse wheel scroll gesture is rendered next to the targeted condition node in the LPN canvas.
- The helper features a fading introduction, a scrolling mouse wheel dot animation, and bouncing top/bottom scroll arrows to intuitively guide the user on how to interact.

### E. Merge and Unmerge Interactive Validation

- During `step-merge` and `step-unmerge`, the tour preloads two conditions and disables the "Next" button.
- Hooked `TokenTrailMergeService` to notify `TokenTrailTourService` on merges/unmerges. The "Next" buttons only unlock once the user performs the requested merge/unmerge action.

### F. Asynchronous DOM Rendering via beforeShowPromise

- Switching display modes dynamically triggers Angular structural layout changes (swapping SVG elements, rendering different toolbar actions).
- To prevent Shepherd from failing to attach to elements that are not yet rendered in the DOM, `beforeShowPromise` is implemented for mode-sensitive steps. It sets the state, triggers change detection, and resolves after a 50ms delay, ensuring target buttons (like the emoji_events trophy or construction lightbulb) are successfully targeted and highlighted.

### G. Merge / Unmerge Duplicate ID Conflict Fix

- **The Issue**: Previously, when unmerging a finalized merged condition in `unmergeConditionGroup()`, the anchor node's `baseName` was temporarily released. However, because the first clone immediately reused the anchor ID, the released ID was recycled for the second clone. This resulted in both split conditions receiving the same ID (e.g., `c1`), causing both to show the blue badge (group size 2) and deleting one of them to delete both.
- **The Solution**: Modified `unmergeConditionGroup` in [token-trail-merge.service.ts](file:///Users/alexanderkolbfleisch/Developer/taco-trails/src/app/components/tab-toolbar/token-trail/token-trail-draw-display/token-trail-merge.service.ts) to prevent releasing the anchor node's `baseName` during the split, since the first clone retains that ID. This guarantees all split conditions receive unique IDs.
