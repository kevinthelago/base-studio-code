// Blueprints (#513/#514): the model behind the Blueprints page. A blueprint is an
// ordered list of planning SECTIONS (stages) that seeds every new project. Each
// section owns its prompt module (the instructions Claude receives for that stage)
// and its PIPELINES — pluggable actions that run on the stage's output. Pure (no
// React/Tauri) so it's unit-testable and the store can seed from it directly.
//
// Mirrors design/base-studio-code-projects/Blueprints.html.
//
// Decomposed (#2148) into three colocated modules, re-exported here so this remains the
// single public entry point (every importer keeps `@/features/planner/stages/blueprints`):
//   • blueprintTypes.ts    — the pure type surface (SectionDef / Blueprint / status types).
//   • blueprintBuiltins.ts — the packaged stage defs + built-in library assembly (STAGE_DEFS,
//                            mkStage, makeBlueprints, CATEGORY_META, …).
//   • blueprintStages.ts   — the pure helpers (auth-lifecycle, filtering, the blueprint-driven
//                            stage status/progress engine, template-change detection).

export * from "./blueprintTypes";
export * from "./blueprintBuiltins";
export * from "./blueprintStages";
