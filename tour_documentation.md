# LPN Token Trail Tour Documentation

This document describes the design, implementation, and quality improvements made to the interactive guided tour for the Labeled Petri Net (LPN) Token Trail validation tab.

## 1. Architecture Overview

The tour is managed by the `TokenTrailTourService` ([token-trail-tour.service.ts](file:///Users/alexanderkolbfleisch/Developer/taco-trails/src/app/services/token-trail-tour.service.ts)), which integrates [Shepherd.js](https://shepherdjs.dev/) (`angular-shepherd`) to provide a step-by-step interactive overlay walkthrough of the application's layout, modes, and controls.

Key responsibilities:

- **State Preservation**: Automatically backs up the user's current Petri net and raw text state upon tour start, loading a standardized example net for the duration of the tour, and restores the user's work when the tour is cancelled or finished.
- **Interactive Control**: Listens to custom signals (`tokenCountChangedInTour`, `elementDroppedInTour`) to enable/disable the "Next" step buttons dynamically, ensuring the user performs the corresponding interaction before advancing.
- **SVG Viewport Pan/Zoom Reset**: Automatically pans/zooms the SVG canvases to center elements during relevant tour steps.

---

## 2. Interactive Tour Steps

The tour guides the user through 8 distinct steps, alternating display modes and showcasing core features:

1. **Welcome Step (`step-welcome`)**: Welcome introduction explaining Token Trail validation.
2. **Split View Layout (`step-layout`)**: Explains the dual canvas layout (original Petri Net on the left, LPN drawing area on the right).
3. **Puzzle Mode Tokens (`step-puzzle`)**: Switches to Puzzle Mode, selects the first place, and prompts the user to edit LPN condition token counts using the scroll wheel.
4. **Validation Info (`step-info`)**: Highlights the validation hint bubbles (`mat-icon` info triggers) which display specific trail violation details.
5. **Mode Switching (`step-mode-switch`)**: Highlights the toolbar action where the user can toggle between Puzzle Mode (fixed net structure) and Construction Mode (free drawing).
6. **Drag & Drop (`step-drag-drop`)**: Switches to Construction Mode, prompting the user to drag a place or transition from the left canvas and drop it onto the right LPN drawing canvas.
7. **Canvas Manipulation (`step-canvas`)**: Instructs the user on how to make connections (right-click to connect place and event), move elements, and delete elements (middle-click).
8. **Final Validation (`step-validation`)**: Directs the user to click the validation checklist icon in the toolbar to run the validation check.

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
- Registered the target step configuration in `TokenTrailTourService` using the selector `[data-tour="construction"]` (or `[data-tour="extension"]` depending on the current mode) to cleanly attach the highlight bubble.

### C. Bold Formatting Fixes in Shepherd Modals

Previously, the translatable tour step text values contained raw markdown syntax `**word**`, which rendered literally on the screen as `**word**` rather than rendering in bold.

- **Resolution**: Replaced the raw markdown bold markers with HTML `<strong>` tags in the translation assets:
    - [en.json](file:///Users/alexanderkolbfleisch/Developer/taco-trails/src/assets/i18n/en.json)
    - [de.json](file:///Users/alexanderkolbfleisch/Developer/taco-trails/src/assets/i18n/de.json)
- Because Shepherd.js naturally renders step texts containing HTML templates, this resolved the issue, and text inside `<strong>...</strong>` renders as bold text.
