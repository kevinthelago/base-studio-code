import { describe, it, expect } from "vitest";
import { planDraftCommit } from "./draftTitle";
import { sanitizeProjectKey } from "@/shared/lib/core/projectPaths";

describe("planDraftCommit — the draft-title commit guard (#1222)", () => {
  const noKeys = new Set<string>();

  it("reverts on an empty / whitespace title (restores the saved name)", () => {
    expect(planDraftCommit("   ", "My app", noKeys)).toEqual({ kind: "revert" });
  });

  it("no-ops when the trimmed title is unchanged", () => {
    expect(planDraftCommit("  My app  ", "My app", noKeys)).toEqual({ kind: "noop" });
  });

  it("errors when the new name slugifies onto another project's key", () => {
    const others = new Set([sanitizeProjectKey("Other app")]);
    expect(planDraftCommit("Other app", "My app", others)).toEqual({
      kind: "error",
      message: expect.stringMatching(/already uses that name/i),
    });
  });

  it("commits a valid, unique, changed (trimmed) title", () => {
    expect(planDraftCommit("  Acme CRM  ", "My app", noKeys)).toEqual({ kind: "commit", title: "Acme CRM" });
  });
});
