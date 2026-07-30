import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Structural guard for `glance.css` (#4038).
 *
 * #4032 removed a keyframe by splicing to the first `}` — which closes the keyframe's INNER block, not
 * the rule — leaving `50% { opacity: .78; } }` stranded after a comment. `50% { … }` parses as a rule
 * with an invalid selector, the stray `}` drops the parser into error recovery, and recovery skips to
 * the next `}` — swallowing `.glance-kit-band-bg` with it. The UI-kit band silently lost its wash.
 *
 * Nothing could catch that: `tsc` does not see CSS, eslint does not parse it, and a browser treats a
 * malformed stylesheet as VALID INPUT — it just quietly drops rules, so the symptom surfaces somewhere
 * unrelated to the edit. A structural check is the only cheap defence.
 */
const CSS = readFileSync(join(process.cwd(), "src/features/glance/glance.css"), "utf8");

/** Strip comments, then count braces — a comment may legally contain an unbalanced one. */
function braceBalance(css: string): number {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let depth = 0;
  for (const ch of bare) {
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    if (depth < 0) return depth; // a close before an open — the #4038 shape
  }
  return depth;
}

describe("glance.css is structurally sound (#4038)", () => {
  it("has balanced braces", () => {
    expect(braceBalance(CSS)).toBe(0);
  });

  it("has no orphaned declaration block after a comment", () => {
    // The exact #4038 shape: a comment terminator immediately followed by a keyframe stop.
    expect(CSS).not.toMatch(/\*\/\s*\d+%\s*\{/);
  });

  it("still carries the UI-kit band rules — the ones error recovery ate", () => {
    // The band (#3007) is the dashed grouping across the top of the graph. Its rules were never
    // deleted; they simply stopped applying, which is why the failure was so hard to attribute.
    expect(CSS).toContain(".glance-kit-band-bg");
    expect(CSS).toContain(".glance-kit-band-divider");
    expect(CSS).toContain(".glance-kit-band-label");
    // The divider's DASH is the thing the user sees — pin it, since a silent loss reads as a redesign.
    expect(CSS).toMatch(/\.glance-kit-band-divider\s*\{[^}]*stroke-dasharray/);
  });

  it("keeps the keyframes the canvas still declares inline styles against", () => {
    expect(CSS).toContain("@keyframes glance-dashmove");
    expect(CSS).toContain("@keyframes glance-softpulse");
    // …and NOT the one that became authored motion data (#4032), or it would be dead weight.
    expect(CSS).not.toContain("glance-buildpulse");
  });
});
