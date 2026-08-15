// The shadow catalogue registers this feature's graph-platform modules by importing
// `./graphPlatform` DIRECTLY and calling its register function (see `shadowPages.ts`). This barrel
// therefore has NO import-time side effect — it is re-exports only, which is what lets it be a
// record rather than a file that must run to be correct.

// Personas feature (#2094) — the CRUD-able agent-identity library (behavior: start prompt + skills +
// model, over a referenced role). Public API barrel.
export { PersonasPanel } from "./PersonasPanel";
export { PersonaEditor } from "./PersonaEditor";
export { PersonaSummary } from "./PersonaSummary";
export { createPersonasSlice, type PersonasSlice } from "@/features/personas/store";
export { BUILTIN_PERSONAS, blankPersona, personaSlug, reconcilePersonas, type Persona } from "./lib/persona";
