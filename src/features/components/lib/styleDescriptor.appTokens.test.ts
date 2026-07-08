import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { StyleDescriptor } from "./styleContract";

// #2567 follow-up: the style descriptor (src-tauri/data/ui/style-descriptor.json) is the SoT that
// generates `tokens-contract.css` (the emit contract for a GENERATED app) AND backs `bsc ui tokens`.
// But base-studio-code's OWN live stylesheet is `src/styles/tokens.css` — a SEPARATE file that
// hand-defines the same semantic tokens. If the two drift, `bsc ui tokens` would describe values the
// running app doesn't actually use (an LLM tunes a token that no longer means what the tool says).
// This guard asserts the descriptor's tokens ARE the app's live BASE values, so the discovery surface
// stays truthful. (A later slice may generate the tokens.css token block from the descriptor outright;
// for now the guard is the reconciliation — the descriptor is authoritative, this catches divergence.)
const TOKENS_CSS = join(process.cwd(), "src/styles/tokens.css");
const DESCRIPTOR = join(process.cwd(), "src-tauri/data/ui/style-descriptor.json");

/** The FIRST `--token: value;` for each token — the base `:root` value the descriptor represents. A
 *  later surface/theme block re-declaring a token (e.g. the light surface) is a scoped override, not
 *  the base, so the first occurrence wins. Scans the whole file (declarations can share a line, e.g.
 *  `--r-sm: 4px; --r-md: 6px; --r-lg: 10px;`). */
function firstTokenValues(css: string): Map<string, string> {
  const m = new Map<string, string>();
  const re = /(--[a-z0-9-]+)\s*:\s*([^;]+);/g;
  for (let match = re.exec(css); match; match = re.exec(css)) {
    if (!m.has(match[1])) m.set(match[1], match[2].trim());
  }
  return m;
}

describe("style descriptor ↔ the app's live tokens.css (#2567)", () => {
  it("every descriptor token is defined in src/styles/tokens.css with the SAME base value", () => {
    const live = firstTokenValues(readFileSync(TOKENS_CSS, "utf8"));
    const d = JSON.parse(readFileSync(DESCRIPTOR, "utf8")) as StyleDescriptor;
    const expected: { name: string; value: string }[] = [
      ...d.base.map((b) => ({ name: b.name, value: b.value })),
      ...d.components.flatMap((c) => [
        ...c.tokens.map((t) => ({ name: t.name, value: t.default })),
        ...c.variants.flatMap((v) => v.tokens.map((t) => ({ name: t.name, value: t.default }))),
      ]),
    ];
    const missing = expected.filter((e) => !live.has(e.name)).map((e) => e.name);
    const mismatched = expected
      .filter((e) => live.has(e.name) && live.get(e.name) !== e.value)
      .map((e) => `${e.name}: descriptor='${e.value}' vs tokens.css='${live.get(e.name)}'`);
    expect(missing, `descriptor tokens absent from src/styles/tokens.css: ${missing.join(", ")}`).toEqual([]);
    expect(mismatched, `descriptor ↔ tokens.css drift:\n${mismatched.join("\n")}`).toEqual([]);
  });
});
