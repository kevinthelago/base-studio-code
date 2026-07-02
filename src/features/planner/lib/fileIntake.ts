// File-intake pipeline core (#604). Pure helpers for the drag-and-drop intake: classify
// a dropped file into a coarse KIND (a routing hint for the planner) and build the
// `intake.json` manifest the planner reads to route files to the right repo/stage.
// Free of React/Tauri so it's unit-testable; the drop-zone screen + Rust writes wrap it.

/** Coarse classification — a hint, not a contract. The planner does the real routing. */
export type IntakeKind = "image" | "vector" | "markup" | "style" | "component" | "data" | "doc" | "other";

/** One staged file in the intake manifest. */
export interface IntakeEntry {
  /** Original file name (also the relpath under `.intake/`). */
  name: string;
  /** Coarse kind (routing hint). */
  kind: IntakeKind;
  /** Byte size. */
  size: number;
  /** MIME type if the browser provided one. */
  mime?: string;
  /** #2097 — content hash of the staged file, so a re-drop of an edited file is detectable. */
  hash: string;
  /** #2097 — the `hash` value at the last time this file was ROUTED to the project (on triage).
   *  Undefined ⇒ never routed. `hash !== routedHash` ⇒ new or changed since the last route. */
  routedHash?: string;
}

const EXT_KIND: Record<string, IntakeKind> = {
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", avif: "image", bmp: "image", ico: "image",
  svg: "vector",
  html: "markup", htm: "markup",
  css: "style", scss: "style", sass: "style", less: "style",
  jsx: "component", tsx: "component", vue: "component", svelte: "component",
  json: "data", yaml: "data", yml: "data", toml: "data", csv: "data",
  md: "doc", mdx: "doc", txt: "doc", pdf: "doc",
};

/** Classify a file by extension first, then MIME family. Unknown ⇒ "other". */
export function classifyFile(name: string, mime?: string): IntakeKind {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  if (ext && EXT_KIND[ext]) return EXT_KIND[ext];
  if (mime) {
    if (mime === "image/svg+xml") return "vector";
    if (mime.startsWith("image/")) return "image";
    if (mime === "text/html") return "markup";
    if (mime === "text/css") return "style";
    if (mime === "application/json") return "data";
    if (mime.startsWith("text/")) return "doc";
  }
  return "other";
}

/** Whether a file should be staged via the binary (base64) write vs text. Images,
 *  vectors-as-binary, fonts, pdfs, and anything non-text go binary; markup/style/
 *  component/data/doc are text. */
export function isBinaryKind(kind: IntakeKind): boolean {
  return kind === "image" || kind === "other";
}

/** A fast, deterministic content hash (FNV-1a, 32-bit → hex) — enough to detect a file changed
 *  between drops; not cryptographic. Text files hash their text; binary files hash their base64. */
export function hashContent(content: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    h ^= content.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Build one manifest entry from a file's metadata + its content hash. */
export function intakeEntry(name: string, size: number, hash: string, mime?: string): IntakeEntry {
  return { name, kind: classifyFile(name, mime), size, hash, ...(mime ? { mime } : {}) };
}

/** Merge new entries into an existing manifest, de-duping by name (newest content wins), preserving
 *  order (existing first, then new names). A re-dropped file keeps its prior `routedHash` so the
 *  change vs the last route is preserved (a new `hash` different from `routedHash` ⇒ needs routing). */
export function mergeIntake(existing: IntakeEntry[], added: IntakeEntry[]): IntakeEntry[] {
  const byName = new Map(existing.map((e) => [e.name, e]));
  for (const e of added) {
    const prev = byName.get(e.name);
    byName.set(e.name, prev ? { ...e, routedHash: prev.routedHash } : e);
  }
  return [...byName.values()];
}

/** The staged files that are new or changed since their last route (`hash !== routedHash`). */
export function changedDesignFiles(entries: IntakeEntry[]): IntakeEntry[] {
  return entries.filter((e) => e.hash !== e.routedHash);
}

/** Stamp every entry as routed at its current content (`routedHash = hash`) — called after a route. */
export function markRouted(entries: IntakeEntry[]): IntakeEntry[] {
  return entries.map((e) => ({ ...e, routedHash: e.hash }));
}

/** #2097 — the design-routing lead prepended to a triage prompt when design files changed, mirroring
 *  `renderTriageDelta`. Empty when nothing changed (so triage does its normal issue pass untouched).
 *  `routeInstruction` is the UI stage's `routePrompt` (the classify-and-route directive). */
export function renderDesignDelta(changed: IntakeEntry[], routeInstruction: string): string {
  if (changed.length === 0) return "";
  const names = changed.map((e) => e.name).join(", ");
  return (
    `DESIGN ROUTING: ${changed.length} design file(s) changed since the last route — ${names}. ` +
    `Route ONLY these changed files (the rest are already in place): ${routeInstruction} ` +
    `Then continue with the issue triage below. `
  );
}

/** Serialize the manifest exactly as it's stored (stable, pretty, trailing newline). */
export function serializeIntake(entries: IntakeEntry[]): string {
  return JSON.stringify(entries, null, 2) + "\n";
}

/** Parse a stored `intake.json` tolerantly (bad/blank ⇒ []). */
export function parseIntake(raw: string): IntakeEntry[] {
  if (!raw || !raw.trim()) return [];
  try {
    const j: unknown = JSON.parse(raw);
    if (!Array.isArray(j)) return [];
    return j.filter((e): e is IntakeEntry => !!e && typeof e === "object" && typeof (e as IntakeEntry).name === "string")
      .map((e) => ({
        name: e.name, kind: e.kind ?? "other", size: typeof e.size === "number" ? e.size : 0,
        hash: typeof e.hash === "string" ? e.hash : "", ...(e.routedHash ? { routedHash: e.routedHash } : {}),
        ...(e.mime ? { mime: e.mime } : {}),
      }));
  } catch {
    return [];
  }
}

/** Where intake stages files within the project hub — a visible `design/` directory so
 *  dropped design assets are easy to find (#829), not a hidden `.intake/`. */
export const INTAKE_DIR = "design";
export const INTAKE_MANIFEST = "design/intake.json";

/** The built-in pipeline id (matches its PIPELINE_LIB entry + screen registration). */
export const FILE_INTAKE_ID = "file-intake";

// The file-intake "Route" instruction now lives in the UI stage's DATA
// (`src-tauri/data/stages/ui.json` → `routePrompt`), read via `STAGE_DEFS.ui.routePrompt` — not
// hardcoded here, so the prompt is editable alongside the rest of the stage (#604).
