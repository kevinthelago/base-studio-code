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

/** Build one manifest entry from a file's metadata. */
export function intakeEntry(name: string, size: number, mime?: string): IntakeEntry {
  return { name, kind: classifyFile(name, mime), size, ...(mime ? { mime } : {}) };
}

/** Merge new entries into an existing manifest, de-duping by name (newest wins),
 *  preserving order (existing first, then new names). */
export function mergeIntake(existing: IntakeEntry[], added: IntakeEntry[]): IntakeEntry[] {
  const byName = new Map(existing.map((e) => [e.name, e]));
  for (const e of added) byName.set(e.name, e);
  return [...byName.values()];
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
      .map((e) => ({ name: e.name, kind: e.kind ?? "other", size: typeof e.size === "number" ? e.size : 0, ...(e.mime ? { mime: e.mime } : {}) }));
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
