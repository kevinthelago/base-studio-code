import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { REACT_UI_KIT, REACT_UI_COMPONENTS } from "./reactUiKit";

// The `react-ui` kit is GENERATED from the shared-UI manifest (slice 1), then COMMITTED as data
// (#2305 slice 1b) — a self-contained, gist-distributable JSON file under src-tauri/data/components/
// that the frontend seed + the `bsc component` store read. This test is the generator + the drift
// guard: `UPDATE_KITS=1 npx vitest run reactUiKit.gen` (re)writes the file; CI asserts it stays in
// sync with the manifest, so the JSON can't silently drift from the registry.
const FILE = join(process.cwd(), "src-tauri/data/components/react-ui.json");
const kitFile = { order: 0, kit: REACT_UI_KIT, components: REACT_UI_COMPONENTS };
const serialised = JSON.stringify(kitFile, null, 2) + "\n";

describe("data/components/react-ui.json ↔ manifest (#2305 slice 1b)", () => {
  it("stays in sync with the manifest-generated kit (UPDATE_KITS=1 to regenerate)", () => {
    if (process.env.UPDATE_KITS) writeFileSync(FILE, serialised);
    expect(existsSync(FILE), "react-ui.json missing — run `UPDATE_KITS=1 npx vitest run reactUiKit.gen`").toBe(true);
    // Round-trip the expected value so the comparison ignores `undefined` fields JSON drops.
    expect(JSON.parse(readFileSync(FILE, "utf8"))).toEqual(JSON.parse(JSON.stringify(kitFile)));
  });
});
