# Taco Trails - AI Agent Guidelines

## Architektur & State Management

- **Zustandsverwaltung via Services**: Der globale Zustand wird stark durch Singleton-Services (wie `SourcePetriNetService`, `TokenTrailStateService` und `PlayService`) in `src/app/services/` gesteuert.
- **Signals & RxJS**: Die Applikation verwendet eine moderne Mischung aus Angular Signals (`signal`, `computed`) für leichtgewichtige reaktive Daten sowie klassische RxJS `BehaviorSubject` für Streams (typischerweise in der Konvention `private _mySubject$` und public `mySubject$`). Bevorzuge die Nutzung der neuen `inject()`-Funktion für Dependency Injection.
- **Domain-Trennung**: Die Simulationsverwaltung des Token-Spiels und die Netz-Bearbeitung sind streng getrennt. `SourcePetriNetService` ist die Single Source of Truth für das Haupt-Graphen-Objekt.

## Kritische Entwickler-Workflows

- **Testen & Formatieren**: Die Code-Richtlinien sind strikt. Vor Abschluss von Änderungen muss stets `npm run prettier:fix` sowie `npm run lint:fix` ausgeführt werden, um CI-Fehlern vorzubeugen.
- **Build-Prozesse**: Das Projekt ist ein Template für das Fachpraktikum Programmiersysteme (Angular 20). Für lokale Builds und Tests gelten die regulären Angular CLI Befehle (`ng serve`, `ng build`, `ng test`).

## Projektspezifische Konventionen und Muster

- **Datenmodelle als Klassen**: Die Petri-Netz-Modelle (zu finden in `src/app/classes/`, z.B. `Diagram`, `DiagramTransition`) sind keine reinen Datenstrukturen/Interfaces, sondern OOP-Klassen, welche direkte Geschäftslogik kapseln (z.B. `node.fire()`).
- **Referenzdaten**: Das Parsen und Einlesen von Graphen verlässt sich auf standardisierte Formate, die in `src/reference-models/` zur Verfügung stehen (`ilpn_reference_model.json` und `woped_reference_model.pnml`).
- **UI & Layouting**: Das Projekt stützt sich primär auf CSS Flexbox für Strukturierungen und Angular Material Module (sowie `RxJs`) für Interaktionen und UI-Komponenten.

## Integrationen

- Das Parsen der XML-Dateiformate (PNML) stützt sich auf `fast-xml-parser`. Die Trennung zwischen Parser-Logik (`src/app/services/parser.service.ts`) und Diagramm-Darstellung (`src/app/classes/diagram/`) muss beibehalten werden.

## Anwendungsstruktur (Tabs)

Die Anwendung ist in 5 Tabs mit spezifischen Semantiken unterteilt:

1. **Zeichnen**: Erstellung und Bearbeitung von Petri-Netzen.
2. **Spielen**: Ausprobieren von Transitionsschaltungen (Interaktives Token-Spiel).
3. **Erreichbarkeitsgraph**: Generierung und Analyse des Erreichbarkeitsgraphen (geteilte Ansicht).
4. **Prozessnetze**: Erzeugung und Validierung von Prozessnetzen aus dem Petri-Netz.
5. **Token Trail Semantiks**: Aktueller Fokus des Projekts, siehe Details unten.

## Token Trail Semantiks (Tab 5)

- **Konzept**: Der LPN (Labeled Petri Net) Token Trail Tab beschäftigt sich mit der Token Trail Validation. Anhand einer mathematischen ILP-Lösung (siehe `TokenTrails.md`) wird validiert, ob ein LPN die Trail-Bedingungen für jede Stelle im Original-Petrinetz erfüllt. Die Ansicht ist zweigeteilt: links das Petri-Netz, rechts das LPN.
- **Modi**:
    - _Puzzle-Modus_: Ein unmarkiertes LPN wird automatisch aus dem linken Petri-Netz auf das rechte Canvas generiert. Der Nutzer wählt links eine Stelle im Petri-Netz aus, befüllt dann rechts manuell die zugehörigen Token im LPN für den speziellen Trail und geht dann zur nächsten Stelle über. Anschließend können wahlweise einzelne Stellen oder alle gleichzeitig über einen Button validiert werden.
    - _Drag & Drop Modus_: Nutzer können Stellen und Transitionen per Drag & Drop direkt aus dem Petri-Netz links in das LPN-Canvas rechts ziehen. So können sie sich völlig frei ein eigenes LPN aufbauen, das die Token Trail-Eigenschaften erfüllen muss.
- **Labeling-Logik**: Die LPN-Conditions (also die Stellen im neu gebauten LPN) tragen die Labels aus dem Petri-Netz in sich. Wenn in einem legitimen Trail Marken auf einer LPN-Stelle liegen, spiegelt das Label diese Historie wider. Eine Condition erhält als dynamisches Label die Summe aller Petri-Netz-Stellen (inkl. Vielfachheit), die hier einen (oder mehrere) Token platziert haben (Beispiel: aus `c1` wird `p1 + p5` oder `p2 + 2*p3 + p4 + p5`).
