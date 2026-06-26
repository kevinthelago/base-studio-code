// The store's shape — re-export barrel for the per-domain store type modules.
//
// Formerly a ~817-line monolith (the AppStore interface + every value/config type). Split into
// focused per-domain modules under `store/types/` (#1634); this barrel re-exports them all so every
// existing `@/store/types` (and `../types`) import keeps resolving unchanged. Types-only; no runtime
// change — `AppStore` still `extends` the per-feature slice interfaces exactly as before.
export * from "./types/github";
export * from "./types/perf";
export * from "./types/log";
export * from "./types/console";
export * from "./types/shell";
export * from "./types/llm";
export * from "./types/projects";
export * from "./types/plan";
export * from "./types/session";
export * from "./types/appStore";
