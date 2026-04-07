## Plan: Add Token Trail Tab & Labeled Net

Create a new "Token Trail" tab split into two sections (Petri net vs Labeled Net), similar to the existing Process Net tab. We will introduce new SVG components, extract connection logic, and handle drag-and-drop actions mapping transitions to tied events.

### Steps
1. Add `Token Trail` to `main-tab.component.html` and [main-tab.component.ts](src/app/components/main-tab/main-tab.component.ts).
2. Create `labeled-net.model.ts` in `src/app/classes` with `Condition` and `Event` classes. The `Event` class will store the ID of the transition it's linked to.
3. Build new SVG components: `svg-condition-node`, `svg-event-node`, and `svg-labeled-net-arc` inside `src/app/components/display`.
4. Add `TokenTrail` components mimicking process-net structure: `token-trail`, `token-trail-display`, and `token-trail-draw-display` under `src/app/components/tab-toolbar/token-trail`.
5. Create a `token-trail-state.service.ts` (mimicking `process-net-state.service.ts`) for canvas state management.
6. Extract the right-click connect logic from `process-net-draw-display.ts` into a dedicated `diagram-connection.util.ts` (or service) to share it with `token-trail-draw-display.ts`.
7. Implement custom drop logic in `token-trail-draw-display`: converting dropped transitions into `Event` nodes with matching labels and linked transition IDs.

### Further Considerations
1. Should `Event` node SVG look visually distinct from normal transitions (e.g., color or inner content), or identical for now? -> no they should identical at the moment
2. Do we want to reuse `DiagramPlace` for `Condition`, or strictly create a new `DiagramCondition` class for stricter typing? --> yes we should reuse `DiagramPlace` for `Condition` to avoid unnecessary duplication, but we can add a type property to differentiate them if needed.
