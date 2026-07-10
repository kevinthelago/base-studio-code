import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { REACT_UI_KIT, REACT_UI_COMPONENTS, REACT_UI_KIT_STORE_ID, REACT_UI_KIT_VERSION } from "./reactUiKit";

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
    const path = join(process.cwd(), "src", c.src);
    return existsSync(path) ? { ...c, source: readFileSync(path, "utf8").replace(/\r\n/g, "\n") } : c;
  });

const kitFile = {
  order: 0,
  id: REACT_UI_KIT_STORE_ID,
  version: REACT_UI_KIT_VERSION,
  kit: REACT_UI_KIT,
  components: withSource(REACT_UI_COMPONENTS),
};
const serialised = JSON.stringify(kitFile, null, 2) + "\n";
const meta = {
  id: REACT_UI_KIT_STORE_ID,
  version: REACT_UI_KIT_VERSION,
  kind: "component-kit",
  sha256: createHash("sha256").update(serialised, "utf8").digest("hex"),
};
const metaSerialised = JSON.stringify(meta, null, 2) + "\n";

describe("data/components/react-ui.json ↔ manifest (#2305 slice 1b)", () => {
  it("stays in sync with the manifest-generated kit (UPDATE_KITS=1 to regenerate)", () => {
    if (process.env.UPDATE_KITS) writeFileSync(FILE, serialised);
    expect(existsSync(FILE), "react-ui.json missing — run `UPDATE_KITS=1 npx vitest run reactUiKit.gen`").toBe(true);
    // Round-trip the expected value so the comparison ignores `undefined` fields JSON drops.
    expect(JSON.parse(readFileSync(FILE, "utf8"))).toEqual(JSON.parse(JSON.stringify(kitFile)));
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
      const onDisk = readFileSync(join(process.cwd(), "src", c!.src), "utf8").replace(/\r\n/g, "\n");
      expect(c!.source, `${id} bundles its verbatim source`).toBe(onDisk);
    }
    // Most components resolve to a real file — the artifact is now source-bearing, not just a catalog
    // of path pointers. (A few templates/stubs legitimately have no standalone file → no `source`.)
    const withRealSource = artifact.components.filter((c) => (c.source ?? "").length > 0).length;
    expect(withRealSource).toBeGreaterThan(artifact.components.length / 2);
  });
});
