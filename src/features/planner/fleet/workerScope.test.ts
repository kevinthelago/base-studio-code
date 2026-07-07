import { describe, it, expect } from "vitest";
import { buildWorkerScope, buildWorkerUiThemeBlock, toWorkerUiPairing } from "./workerScope";
import type { AgentStream } from "./planFleet";

const stream = (over: Partial<AgentStream> = {}): AgentStream => ({
  id: "auth-ui",
  name: "Auth UI",
  repo: "own/web",
  owns: ["src/auth/**", "src/login/**"],
  issues: ["#12", "#13"],
  dependsOn: ["api"],
  ...over,
});

describe("buildWorkerScope (#844)", () => {
  it("renders the stream's owned globs, issues, and dependencies", () => {
    const md = buildWorkerScope(stream());
    expect(md).toContain("# Your scope — Auth UI");
    expect(md).toContain("`src/auth/**`");
    expect(md).toContain("`src/login/**`");
    expect(md).toContain("#12, #13");
    expect(md).toContain("branch `auth-ui`");
    expect(md).toContain("**You build against the contracts of:** api");
  });

  it("is a scope, not the full plan — it points cross-cutting context at the director", () => {
    const md = buildWorkerScope(stream());
    expect(md).toContain("not the full plan");
    expect(md).toContain("defer to the director");
    // Sanity: it stays short (a lane, not a spec). The commons-ownership note (#851) is part of
    // the lane, so the budget accommodates it while still being far shy of the full plan.
    expect(md.length).toBeLessThan(1700);
  });

  it("tells the worker the director closes issues — not to run gh issue close (#906)", () => {
    const md = buildWorkerScope(stream());
    expect(md).toContain("director's job");
    expect(md).toContain("gh issue close");
    expect(md).toMatch(/let the director close it/i);
  });

  it("maintenance mode (#1957): leads with the stand-by banner, off by default", () => {
    const md = buildWorkerScope(stream(), [], true);
    expect(md).toContain("MAINTENANCE mode");
    expect(md).toContain("bsc-maintain");
    expect(md).toMatch(/do NOT[\s\S]*rebuild/i);
    expect(buildWorkerScope(stream())).not.toContain("MAINTENANCE mode"); // off by default
  });

  it("renders explicit placeholders for empty fields rather than leaving them blank", () => {
    const md = buildWorkerScope(stream({ owns: [], issues: [], dependsOn: [] }));
    expect(md).toContain("none assigned");
    expect(md).toContain("none yet");
    expect(md).toContain("**You build against the contracts of:** none");
  });

  it("appends the locked dependency manifest for the worker's repo when present (#1111)", () => {
    const md = buildWorkerScope(stream(), [
      { ecosystem: "npm", name: "zod", version: "^3.23", why: "validation" },
      { ecosystem: "cargo", name: "serde", version: "1" },
    ]);
    expect(md).toContain("## Dependencies (locked by the planner)");
    expect(md).toContain("`zod@^3.23`");
    expect(md).toContain("`serde@1`");
    expect(md).toMatch(/Do NOT add to or\s*\n?\s*edit/);
  });

  it("omits the dependency block entirely when the repo has no locked deps", () => {
    expect(buildWorkerScope(stream())).not.toContain("Dependencies (locked");
    expect(buildWorkerScope(stream(), [])).not.toContain("Dependencies (locked");
  });

  it("tells the worker the commons are the director's and to request changes (#851)", () => {
    const md = buildWorkerScope(stream());
    expect(md).toContain("Repo-root commons are the director's, not yours");
    expect(md).toContain("`bsc-ask`");
  });

  it("surfaces the commons-landed gate as a note, NOT as a peer contract dependency (#851)", () => {
    const md = buildWorkerScope(stream({ dependsOn: ["api", "commons"] }));
    // The contracts line lists real seams only — the commons sentinel is filtered out of it.
    expect(md).toMatch(/build against the contracts of:\*\* api\b/i);
    expect(md).not.toMatch(/contracts of:\*\* [^\n]*commons/i);
    // …and the commons note acknowledges it's already scaffolded.
    expect(md).toContain("already scaffolded on develop");
  });
});

describe("UI palette lock block (#2489)", () => {
  it("appends the palette lock when a pairing is present, mirroring the deps-lock guardrail", () => {
    const md = buildWorkerScope(stream(), [], false, { kit: { id: "bsc/react-ui", version: "1.0.0" }, themeId: "soft" });
    expect(md).toContain("## UI palette (locked by the planner)");
    expect(md).toContain("`bsc/react-ui@1.0.0` component kit");
    expect(md).toContain("`soft` theme");
    // The concrete emission command, the layer order, and the read-only guardrail.
    expect(md).toContain("ui emit-css --theme soft");
    expect(md).toMatch(/`tokens\.css`[\s\S]*`theme\.css`[\s\S]*app styles/);
    expect(md).toContain("Do NOT edit `tokens.css`");
    expect(md).toContain("one-file swap");
    expect(md).toContain("`bsc-ask`");
  });

  it("omits the block when no pairing is recorded; themeId falls back to `default`", () => {
    expect(buildWorkerScope(stream())).not.toContain("UI palette (locked");
    expect(buildWorkerUiThemeBlock(undefined)).toBe("");
    expect(buildWorkerUiThemeBlock({})).toBe("");
    const md = buildWorkerUiThemeBlock({ kit: { id: "a/b", version: "1.0.0" } });
    expect(md).toContain("`default` theme");
    expect(md).toContain("--theme default");
    // A theme-only pairing still locks the palette (kit named generically).
    expect(buildWorkerUiThemeBlock({ themeId: "warm" })).toContain("`warm` theme");
  });

  it("toWorkerUiPairing: plan.db's record wins per half, the blueprint pin fills the rest", () => {
    const pin = { id: "bsc/react-ui", version: "1.0.0", themeId: "warm" };
    // No plan.db record ⇒ the blueprint pin (kit + its default theme) is the pairing.
    expect(toWorkerUiPairing(null, pin)).toEqual({ kit: { id: "bsc/react-ui", version: "1.0.0" }, themeId: "warm" });
    // A theme-only record overrides the theme but keeps the pinned kit.
    expect(toWorkerUiPairing({ themeId: "contrast" }, pin))
      .toEqual({ kit: { id: "bsc/react-ui", version: "1.0.0" }, themeId: "contrast" });
    // A full record wins outright.
    expect(toWorkerUiPairing({ kit: { id: "acme/neon", version: "2.0.0" }, themeId: "soft" }, pin))
      .toEqual({ kit: { id: "acme/neon", version: "2.0.0" }, themeId: "soft" });
    // Malformed halves are ignored, not carried; nothing at all ⇒ undefined (no block).
    expect(toWorkerUiPairing({ kit: { id: "" }, themeId: "" }, undefined)).toBeUndefined();
    expect(toWorkerUiPairing(null, undefined)).toBeUndefined();
  });
});
