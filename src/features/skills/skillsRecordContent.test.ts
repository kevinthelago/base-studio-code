// What the Skills page RENDERS (#4179).
//
// The record ↔ file parity guard lives in `src/app/runtime/graphParity.test.ts` and covers every page in
// one place. This is the part it cannot do: parity only proves the two copies AGREE, so a change that
// reverted both would sail through it. These assertions pin the CONTENT of the two changes that spent
// months in one copy each, on the record, because the record is what renders.
import { describe, it, expect } from "vitest";
import pageRecord from "@data/components/app/features/skills/skillspage.json";
import digestRecord from "@data/components/app/features/skills/skills-digest.json";

describe("the Skills page carries both changes that landed on 2026-07-26 (#4179)", () => {
  it("has #3826/#3833's pill-switch rail facets", () => {
    expect(pageRecord.srcText).toContain('<Toggle on={on} size="xs" />');
    // …with the pressed state on the row's own <button>, where a screen reader will find it.
    expect(pageRecord.srcText).toContain("aria-pressed={on}");
  });

  it("has #3854's search-led header, and not the KPI strip it replaced", () => {
    expect(pageRecord.srcText).toContain('aria-label="Search skills"');
    expect(pageRecord.srcText).toContain("SkillsDigestToggle");
    expect(pageRecord.srcText, "the always-on KPI strip #3854 removed").not.toContain("SkillsDigestBar");
    expect(pageRecord.srcText, "search no longer sits in the rail's tools slot").not.toContain("tools={");
    // The digest module exports the toggle, not the bar — deleting the bar outright would have deleted
    // the only way to reach the digest PANEL, which #3854 explicitly kept.
    expect(digestRecord.srcText).toContain("SkillsDigestToggle");
    expect(digestRecord.srcText).not.toContain("SkillsDigestBar");
  });
});
