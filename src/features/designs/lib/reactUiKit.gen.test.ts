import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { REACT_UI_KIT, REACT_UI_COMPONENTS, REACT_UI_KIT_STORE_ID, REACT_UI_KIT_VERSION } from "@/features/designs/lib/reactUiKit";

// The `react-ui` kit is GENERATED from the shared-UI manifest (slice 1), then COMMITTED as data
// (#2305 slice 1b) — a self-contained, gist-distributable JSON file under src-tauri/data/components/
// that the frontend seed + the `bsc ui` store read. This test is the generator + the drift
// guard: `UPDATE_KITS=1 npx vitest run reactUiKit.gen` (re)writes the file; CI asserts it stays in
// sync with the manifest, so the JSON can't silently drift from the registry.
//
// #2465 stamps the packaged kit's GLOBAL-store identity (`bsc/react-ui@1.0.0`) into the artifact and
// additionally generates a hash SIDECAR (`src-tauri/data/ui/react-ui-kit.meta.json` — under data/ui/,
// NOT data/components/, so the builtinKits `@data/components/*.json` glob never mistakes it for a
// kit): `{ id, version, kind, sha256 }` where sha256 is the hash of the artifact's exact bytes. The
// sidecar can't live inside the artifact (a file can't contain its own hash), and both files are
// pinned `eol=lf` in .gitattributes so the bytes — and therefore the hash — are identical on every
// platform (the Rust `bsc ui kit` store embeds both as the packaged fallback entry; the frontend
// default-pin reads the sidecar via `@data/ui/react-ui-kit.meta.json`).
const FILE = join(process.cwd(), "src-tauri/data/components/react-ui.json");
const META_FILE = join(process.cwd(), "src-tauri/data/ui/react-ui-kit.meta.json");

/** Bundle each component's VERBATIM implementation into the artifact (#2794, epic #2793): read the
 *  `.tsx` at its `src` path, LF-normalized so the escaped-newline bytes — and therefore the hash
 *  sidecar — are identical on every platform (the artifact is pinned `eol=lf`). A component whose `src`
 *  has no standalone file (a pure stub) simply carries no `source`. This is what gives `bsc ui … emit`
 *  real code to write; the mutable component store deliberately drops it (`builtinKits.withoutSource`). */
const withSource = (components: typeof REACT_UI_COMPONENTS) =>
  components.map((c) => {
    const source = readSrc(c.src);
    return source === null ? c : { ...c, source };
  });

const SRC = join(process.cwd(), "src");
/** The generated tree `scripts/emit-records.mjs` materializes retired modules into (mirroring `src/`). */
const RECORDS = join(process.cwd(), ".bsc-records");

/** The two-step resolve — `src/` first, then the emitted record tree — for a path relative to `src/`.
 *
 *  The kit generator is the FIFTH consumer that has to know about retired modules, after tsc
 *  (`tsconfig.paths`), vite + vitest (`vite/bscRecords.ts`) and the e2e config. It reads `src/<c.src>`
 *  directly to bundle each component's verbatim implementation, so retiring `Button.tsx` made it throw
 *  ENOENT on a path the app resolves perfectly well. Every such reader needs the fallback, and the shape
 *  is always the same: the file wins while it exists, and the record answers only what `src/` no longer
 *  has. Returns LF-normalized source, or `null` when neither has it (a pure stub legitimately has none). */
function readSrc(rel: string): string | null {
  for (const root of [SRC, RECORDS]) {
    const p = join(root, rel);
    if (existsSync(p)) return readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  }
  return null;
}

/** Does `rel` (relative to `src/`) exist in either tree? The `existsSync` half of {@link readSrc}. */
const hasSrc = (rel: string) => existsSync(join(SRC, rel)) || existsSync(join(RECORDS, rel));

/** Resolve a FIRST-PARTY import specifier — a `@/…` OR a RELATIVE (`./`,`../`) path — to a path relative
 *  to `src/` (with extension), trying TS module-resolution order. `fromRel` is the src/-relative path of
 *  the IMPORTING module (needed to resolve a relative specifier). `null` when it isn't a resolvable
 *  first-party file (an external npm dep — react/node/d3 — or a type-only path with no `.ts(x)` on disk). */
function resolveImport(spec: string, fromRel: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) {
    base = spec.slice(2); // drop "@/"
  } else if (spec.startsWith("./") || spec.startsWith("../")) {
    // Resolve relative to the IMPORTING module's dir, normalising `.`/`..` segments (#2954).
    const fromDir = fromRel.includes("/") ? fromRel.slice(0, fromRel.lastIndexOf("/")) : "";
    const out: string[] = [];
    for (const seg of (fromDir ? fromDir.split("/") : []).concat(spec.split("/"))) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") out.pop();
      else out.push(seg);
    }
    base = out.join("/");
  } else {
    return null; // external npm dep (react, node, d3, …)
  }
  for (const cand of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (hasSrc(cand)) return cand;
  }
  return null;
}

/** Every FIRST-PARTY specifier a source imports/re-exports/dynamically imports — the `@/…` AND the
 *  RELATIVE (`./`, `../`) ones (#2954: relative imports were silently dropped before, so a relatively-
 *  imported support module never vendored). External npm specifiers are left for `resolveImport` to drop. */
function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const re = /(?:from|import)\s*\(?\s*["']((?:@\/|\.\.?\/)[^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) specs.push(m[1]);
  return specs;
}

/** The transitive NON-COMPONENT support closure the components import (#2798) — the `_kit/` runtime the
 *  vendored-source emit (②·2) needs so an emitted file compiles standalone: `{ <path rel. to src/> :
 *  <verbatim LF source> }`. Seeded from every component's real source and walked through first-party
 *  `@/…` imports; a resolved path that is a KIT COMPONENT (a `src` in the kit) is skipped — that's a
 *  `composes` edge, emitted as a sibling file, not runtime — as are external (non-`@/`) deps (react,
 *  d3), which stay npm dependencies. Deterministic (sorted) so the artifact bytes are stable. */
function collectRuntime(components: typeof REACT_UI_COMPONENTS): Record<string, string> {
  const componentSrc = new Set(components.map((c) => c.src)); // e.g. "shared/ui/data/Card.tsx"
  const collected = new Map<string, string>();
  const visited = new Set<string>();
  const walk = (relPath: string) => {
    if (visited.has(relPath)) return;
    visited.add(relPath);
    const source = readSrc(relPath);
    if (source === null) return;
    for (const spec of importSpecifiers(source)) {
      const resolved = resolveImport(spec, relPath);
      if (!resolved || componentSrc.has(resolved)) continue; // external, unresolved, or a kit component
      if (!collected.has(resolved)) collected.set(resolved, readSrc(resolved) ?? "");
      walk(resolved);
    }
  };
  for (const c of components) walk(c.src); // seed the walk from each component's real source
  return Object.fromEntries([...collected.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

const kitFile = {
  order: 0,
  id: REACT_UI_KIT_STORE_ID,
  version: REACT_UI_KIT_VERSION,
  kit: REACT_UI_KIT,
  components: withSource(REACT_UI_COMPONENTS),
  runtime: collectRuntime(REACT_UI_COMPONENTS),
};
const serialised = JSON.stringify(kitFile, null, 2) + "\n";
const meta = {
  id: REACT_UI_KIT_STORE_ID,
  version: REACT_UI_KIT_VERSION,
  kind: "component-kit",
  sha256: createHash("sha256").update(serialised, "utf8").digest("hex"),
};
const metaSerialised = JSON.stringify(meta, null, 2) + "\n";

/** Deterministic stringify — keys sorted recursively — so two objects built with the same content in a
 *  different key order compare equal (JSON.parse/`toEqual` already ignore order; a raw `JSON.stringify`
 *  comparison would not). Used only to detect WHETHER an entry differs; `toEqual` below still owns the
 *  real assertion. */
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    const keys = Object.keys(v as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** Name the FILE that caused kit drift, instead of leaving a reader to spot one changed string inside a
 *  toEqual diff of two ~86,000-line objects (request #171 — hit three times in one day with no clue which
 *  of ~100+ components or dozens of runtime modules moved). Compares the on-disk artifact against the
 *  freshly generated `kitFile` component-by-component and runtime-entry-by-entry, returning one line per
 *  drifted/added/removed component (by id + its `src`) or runtime module (by path). Empty when nothing
 *  drifted structurally (a `kit`/`id`/`version` change is still reported, just without a file to name). */
function describeDrift(onDisk: typeof kitFile, fresh: typeof kitFile): string[] {
  const reasons: string[] = [];
  for (const key of ["id", "version", "kit"] as const) {
    if (stableStringify(onDisk[key]) !== stableStringify(fresh[key])) reasons.push(`"${key}" changed`);
  }
  const onDiskById = new Map(onDisk.components.map((c) => [c.id, c]));
  const freshById = new Map(fresh.components.map((c) => [c.id, c]));
  for (const [id, freshC] of freshById) {
    const onDiskC = onDiskById.get(id);
    if (!onDiskC) reasons.push(`component "${id}" (${freshC.src}) added to the manifest`);
    else if (stableStringify(onDiskC) !== stableStringify(freshC)) {
      reasons.push(
        onDiskC.source !== freshC.source
          ? `component "${id}" — ${freshC.src} changed on disk since react-ui.json was last generated`
          : `component "${id}" (${freshC.src}) metadata changed (not its source)`,
      );
    }
  }
  for (const id of onDiskById.keys()) {
    if (!freshById.has(id)) reasons.push(`component "${id}" removed from the manifest`);
  }
  const onDiskOrder = onDisk.components.map((c) => c.id);
  const freshOrder = fresh.components.map((c) => c.id);
  if (onDiskOrder.length === freshOrder.length && stableStringify(onDiskOrder) !== stableStringify(freshOrder)) {
    reasons.push(`component order changed (same set, different sequence)`);
  }
  const runtimePaths = new Set([...Object.keys(onDisk.runtime), ...Object.keys(fresh.runtime)]);
  for (const path of runtimePaths) {
    const before = onDisk.runtime[path];
    const after = fresh.runtime[path];
    if (before === undefined) reasons.push(`runtime module ${path} added to the manifest closure`);
    else if (after === undefined) reasons.push(`runtime module ${path} dropped from the manifest closure`);
    else if (before !== after) reasons.push(`runtime module ${path} changed on disk since react-ui.json was last generated`);
  }
  return reasons;
}

describe("data/components/react-ui.json ↔ manifest (#2305 slice 1b)", () => {
  it("stays in sync with the manifest-generated kit (UPDATE_KITS=1 to regenerate)", () => {
    if (process.env.UPDATE_KITS) writeFileSync(FILE, serialised);
    expect(existsSync(FILE), "react-ui.json missing — run `UPDATE_KITS=1 npx vitest run reactUiKit.gen`").toBe(true);
    // Round-trip the expected value so the comparison ignores `undefined` fields JSON drops.
    const onDisk = JSON.parse(readFileSync(FILE, "utf8"));
    const fresh = JSON.parse(JSON.stringify(kitFile));
    const drift = describeDrift(onDisk, fresh);
    expect(
      drift,
      `kit drifted from the manifest — run \`UPDATE_KITS=1 npx vitest run reactUiKit.gen\` to regenerate:\n${drift.join("\n")}`,
    ).toEqual([]);
    expect(onDisk).toEqual(fresh);
  });

  it("keeps the packaged-kit hash sidecar in sync (#2465; UPDATE_KITS=1 to regenerate)", () => {
    if (process.env.UPDATE_KITS) writeFileSync(META_FILE, metaSerialised);
    expect(existsSync(META_FILE), "react-ui-kit.meta.json missing — run `UPDATE_KITS=1 npx vitest run reactUiKit.gen`").toBe(true);
    expect(JSON.parse(readFileSync(META_FILE, "utf8"))).toEqual(meta);
    // The sidecar's hash must be the hash of the artifact's exact bytes (CRLF-normalized: a
    // pre-.gitattributes checkout may still hold the artifact CRLF; LF is the canonical byte form).
    const artifact = readFileSync(FILE, "utf8").replace(/\r\n/g, "\n");
    expect(createHash("sha256").update(artifact, "utf8").digest("hex")).toBe(meta.sha256);
  });

  it("bundles each component's verbatim implementation source (#2794)", () => {
    const artifact = JSON.parse(readFileSync(FILE, "utf8")) as {
      components: { id: string; src: string; source?: string }[];
    };
    const byId = new Map(artifact.components.map((c) => [c.id, c]));
    // Real primitives carry their exact on-disk `.tsx` (not the usage-snippet `srcText`).
    for (const id of ["card", "button"]) {
      const c = byId.get(id);
      expect(c, `${id} present in the artifact`).toBeTruthy();
      const onDisk = readSrc(c!.src);
      expect(c!.source, `${id} bundles its verbatim source`).toBe(onDisk);
    }
    // Most components resolve to a real file — the artifact is now source-bearing, not just a catalog
    // of path pointers. (A few templates/stubs legitimately have no standalone file → no `source`.)
    const withRealSource = artifact.components.filter((c) => (c.source ?? "").length > 0).length;
    expect(withRealSource).toBeGreaterThan(artifact.components.length / 2);
  });

  it("bundles the transitive non-component support closure as `runtime` (#2798)", () => {
    const artifact = JSON.parse(readFileSync(FILE, "utf8")) as {
      components: { src: string }[];
      runtime: Record<string, string>;
    };
    const rt = artifact.runtime;
    expect(rt && Object.keys(rt).length, "runtime is non-empty").toBeTruthy();
    // A known support module the components import (`core/format`) is vendored, verbatim.
    const fmtKey = Object.keys(rt).find((k) => k.startsWith("shared/lib/core/format"));
    expect(fmtKey, "core/format is in the runtime closure").toBeTruthy();
    expect(rt[fmtKey!]).toBe(readSrc(fmtKey!));
    // No COMPONENT module leaked into `runtime` — those are `source` (emitted via `composes`), never
    // the support runtime. And every runtime entry resolves to a real on-disk file.
    const componentSrc = new Set(artifact.components.map((c) => c.src));
    for (const path of Object.keys(rt)) {
      expect(componentSrc.has(path), `${path} is a support module, not a component`).toBe(false);
      // EITHER tree: a retired module still exists as a file, just in the generated record mirror rather
      // than `src/`. Asserting `src/` alone would fail the moment the closure reaches a retired module —
      // which is what happened when `FocusedFeaturesBody.tsx` went — and the assertion's real point is
      // that the closure names something real, not which of the two trees holds it.
      expect(hasSrc(path), `${path} exists on disk (src/ or .bsc-records/)`).toBe(true);
    }
  });

  it("the emit closure is COMPLETE — every first-party import resolves to a component or runtime (#2798)", () => {
    // The guarantee that makes ②·2 emit COMPILABLE source: across everything emit would write (each
    // component's `source` + each runtime module), every `@/…` import must resolve to either a kit
    // component (a `composes` edge → sibling file) or a bundled runtime module. Any unresolved
    // first-party import is a hole the emitted app couldn't build around.
    const artifact = JSON.parse(readFileSync(FILE, "utf8")) as {
      components: { src: string; source?: string }[];
      runtime: Record<string, string>;
    };
    const componentSrc = new Set(artifact.components.map((c) => c.src));
    const runtimeKeys = new Set(Object.keys(artifact.runtime));
    const sources: [string, string][] = [
      ...artifact.components.filter((c) => c.source).map((c) => [c.src, c.source!] as [string, string]),
      ...Object.entries(artifact.runtime),
    ];
    const gaps: string[] = [];
    for (const [file, src] of sources) {
      for (const spec of importSpecifiers(src)) {
        const resolved = resolveImport(spec, file);
        if (!resolved) continue; // external / type-only → an npm dep, not vendored
        if (componentSrc.has(resolved) || runtimeKeys.has(resolved)) continue; // composes edge or runtime
        gaps.push(`${file} → ${spec}`);
      }
    }
    expect(gaps, `unresolved first-party imports would break an emitted file:\n${gaps.join("\n")}`).toEqual([]);
  });
});

describe("describeDrift diagnostic (request #171 — kit drift should name the file that caused it)", () => {
  // A small, self-contained fixture shaped like `kitFile` — NOT read from the real 86,000-line
  // artifact, so each case isolates exactly one kind of drift instead of depending on which real
  // component happens to exist today.
  const baseline = {
    order: 0,
    id: "bsc/react-ui@1.0.0",
    version: "1.0.0",
    kit: { name: "react-ui" },
    components: [
      { id: "button", src: "shared/ui/controls/Button.tsx", name: "Button", source: "export const Button = () => null;\n" },
      { id: "card", src: "shared/ui/data/Card.tsx", name: "Card", source: "export const Card = () => null;\n" },
    ],
    runtime: { "shared/lib/core/format.ts": "export const fmt = (n: number) => String(n);\n" },
  } as unknown as typeof kitFile;
  const clone = () => JSON.parse(JSON.stringify(baseline)) as typeof kitFile;

  it("passes clean when the artifact matches the manifest", () => {
    expect(describeDrift(clone(), clone())).toEqual([]);
  });

  it("names the component id + its src path when a bundled source is stale", () => {
    const fresh = clone();
    const onDisk = clone();
    (onDisk.components[0] as { source?: string }).source = "// stale — edited on disk since react-ui.json was generated\n";
    const drift = describeDrift(onDisk, fresh);
    expect(drift).toEqual([`component "button" — shared/ui/controls/Button.tsx changed on disk since react-ui.json was last generated`]);
  });

  it("names the runtime module path when a vendored support file is stale", () => {
    const fresh = clone();
    const onDisk = clone();
    onDisk.runtime["shared/lib/core/format.ts"] = "// stale — edited on disk since react-ui.json was generated\n";
    const drift = describeDrift(onDisk, fresh);
    expect(drift).toEqual(["runtime module shared/lib/core/format.ts changed on disk since react-ui.json was last generated"]);
  });

  it("names an added and a dropped runtime module distinctly", () => {
    const fresh = clone();
    fresh.runtime["shared/lib/core/newHelper.ts"] = "export const helper = () => 1;\n";
    const onDisk = clone();
    const drift = describeDrift(onDisk, fresh);
    expect(drift).toEqual(["runtime module shared/lib/core/newHelper.ts added to the manifest closure"]);

    const fresh2 = clone();
    const onDisk2 = clone();
    onDisk2.runtime["shared/lib/core/newHelper.ts"] = "export const helper = () => 1;\n";
    expect(describeDrift(onDisk2, fresh2)).toEqual(["runtime module shared/lib/core/newHelper.ts dropped from the manifest closure"]);
  });

  it("names a component removed from — or added to — the manifest by id and src", () => {
    const fresh = clone();
    const onDisk = clone();
    onDisk.components = onDisk.components.filter((c) => c.id !== "card");
    expect(describeDrift(onDisk, fresh)).toEqual(['component "card" (shared/ui/data/Card.tsx) added to the manifest']);

    const fresh2 = clone();
    fresh2.components = fresh2.components.filter((c) => c.id !== "card");
    const onDisk2 = clone();
    expect(describeDrift(onDisk2, fresh2)).toEqual(['component "card" removed from the manifest']);
  });

  it("distinguishes a metadata-only edit from a source drift, for the same component", () => {
    const fresh = clone();
    const onDisk = clone();
    (onDisk.components[0] as { name?: string }).name = "ButtonRenamed";
    const drift = describeDrift(onDisk, fresh);
    expect(drift).toEqual(['component "button" (shared/ui/controls/Button.tsx) metadata changed (not its source)']);
  });
});
