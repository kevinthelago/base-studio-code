// GENERATOR + drift guard for `src-tauri/data/ui/primitives.json` (#3485, slice 3a of #3484).
//
// WHY THIS FILE EXISTS. The general node validator (`generalNode.ts`) derives its rules from the TS
// manifest. But `bsc ui validate` is a Rust CLI — it cannot import TypeScript, and the *generated*
// `react-ui.json` is no use here because it flattens each prop's type to a TS type STRING
// (`"\"dim\" | \"muted\""`), losing the structured `PropType` + `values` the validator needs.
//
// So the structured subset is emitted as its own contract file, read by Rust via `include_str!`
// exactly like `kit-nodes.json`. The manifest stays the single source of truth; this is a projection
// of it, never hand-edited.
//
//   UPDATE_KITS=1 npx vitest run primitives.gen     # (re)write the file
//   npx vitest run primitives.gen                   # assert it has not drifted
//
// Same mechanism as `reactUiKit.gen.test.ts`, deliberately — one regeneration command for every
// manifest-derived artifact.
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { UI_KIT } from "../manifest";

const FILE = join(process.cwd(), "src-tauri/data/ui/primitives.json");

/** The validation-relevant projection of a `PropSpec`. Deliberately NOT the whole spec: `description`
 *  and `default` are prose/runtime concerns that would enlarge the drift surface without making a
 *  single validation decision. Keys are emitted in a fixed order so the bytes are stable. */
function projectProp(p: (typeof UI_KIT)[number]["props"][number]) {
  const out: Record<string, unknown> = { name: p.name, type: p.type };
  if (p.required) out.required = true;
  if (p.values && p.values.length > 0) out.values = [...p.values];
  return out;
}

/** The contract Rust embeds: every primitive's name, its passthrough flag, and its structured props. */
export function buildPrimitivesContract() {
  return {
    version: 1,
    note:
      "GENERATED from src/shared/ui/manifest.ts — do not edit by hand. The structured prop contract " +
      "`bsc ui validate` enforces for general nodes ({ type, props, children }). `values` is the closed " +
      "set for `type: enum`. `passthrough` primitives forward arbitrary DOM props, so unknown props are " +
      "NOT an error on them. Regenerate: UPDATE_KITS=1 npx vitest run primitives.gen",
    primitives: UI_KIT.map((p) => {
      const out: Record<string, unknown> = { name: p.name };
      if (p.passthrough) out.passthrough = true;
      out.props = p.props.map(projectProp);
      return out;
    }),
  };
}

/** LF + trailing newline, matching the other generated artifacts (pinned `eol=lf` in .gitattributes)
 *  so the committed bytes are identical on every platform and the drift guard is not OS-dependent. */
const serialised = `${JSON.stringify(buildPrimitivesContract(), null, 2)}\n`;

describe("primitives.json — the Rust-readable prop contract (#3485)", () => {
  it("stays in sync with the manifest (UPDATE_KITS=1 to regenerate)", () => {
    if (process.env.UPDATE_KITS) writeFileSync(FILE, serialised);
    expect(
      existsSync(FILE),
      "primitives.json missing — run `UPDATE_KITS=1 npx vitest run primitives.gen`",
    ).toBe(true);
    expect(
      readFileSync(FILE, "utf8").replace(/\r\n/g, "\n"),
      "primitives.json drifted from the manifest — run `UPDATE_KITS=1 npx vitest run primitives.gen`",
    ).toBe(serialised);
  });

  it("carries the STRUCTURED prop data the TS type strings lose", () => {
    // The whole reason this file exists: `react-ui.json` renders an enum as the string
    // `"\"dim\" | \"muted\" | …"`, which Rust would have to parse to use. Here it stays structured.
    const c = buildPrimitivesContract();
    const text = c.primitives.find((p) => p.name === "Text") as { props: Array<Record<string, unknown>> };
    const tone = text.props.find((p) => p.name === "tone")!;
    expect(tone.type).toBe("enum");
    expect(tone.values).toContain("accent");
  });

  it("marks passthrough primitives, so Rust can skip the unknown-prop check exactly as TS does", () => {
    const c = buildPrimitivesContract();
    const text = c.primitives.find((p) => p.name === "Text")!;
    expect(text.passthrough).toBe(true);
    // And a non-passthrough primitive must NOT carry the flag — the two validators branch on it, so a
    // wrong value here would make them disagree silently.
    const strict = UI_KIT.find((p) => !p.passthrough)!;
    expect(c.primitives.find((p) => p.name === strict.name)!.passthrough).toBeUndefined();
  });

  it("covers every primitive — Rust and TS validate the same vocabulary", () => {
    expect(buildPrimitivesContract().primitives.length).toBe(UI_KIT.length);
  });
});
