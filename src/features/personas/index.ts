// Personas feature (#2094) — the CRUD-able agent-identity library (behavior: start prompt + skills +
// model, over a referenced role). Public API barrel.
export { PersonasPanel } from "./PersonasPanel";
export { PersonaEditor } from "./PersonaEditor";
export { PersonaSummary } from "./PersonaSummary";
export { createPersonasSlice, type PersonasSlice } from "./store";
export { BUILTIN_PERSONAS, blankPersona, personaSlug, reconcilePersonas, type Persona } from "./lib/persona";
