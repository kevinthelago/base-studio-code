import { describe, it, expect } from "vitest";
import { resolveProfileSettings } from "./profileEnforcement";
import { findProfile } from "./agentProfiles";

const profile = (id: string) => {
  const p = findProfile(id);
  if (!p) throw new Error(`missing profile ${id}`);
  return p;
};

describe("resolveProfileSettings", () => {
  it("maps allow/deny tool tiers to tool rules (ask is left to prompt)", () => {
    const s = resolveProfileSettings(profile("pf_sandbox"));
    // read/grep/glob allow → allowed tools
    expect(s.allowToolRules).toEqual(expect.arrayContaining(["Read", "Grep", "Glob"]));
    // web/task deny → denied tools
    expect(s.denyToolRules).toEqual(expect.arrayContaining(["WebFetch", "WebSearch", "Task"]));
    // edit/write are "ask" → neither allowed nor denied (Claude prompts)
    expect(s.allowToolRules).not.toContain("Edit");
    expect(s.denyToolRules).not.toContain("Edit");
  });

  it("never blanket-denies Bash (would kill guaranteed gh/git)", () => {
    // pf_sandbox sets bash: "deny" — but Bash must not be denied wholesale.
    const s = resolveProfileSettings(profile("pf_sandbox"));
    expect(s.denyToolRules).not.toContain("Bash");
  });

  it("scopes file-write tools by path globs (deny wins)", () => {
    const s = resolveProfileSettings(profile("pf_sandbox")); // paths.deny: ["**/*"]
    for (const t of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
      expect(s.denyToolRules).toContain(`${t}(**/*)`);
    }
  });

  it("carries the command allowlist + per-glob allows for a build profile", () => {
    const s = resolveProfileSettings(profile("pf_build"));
    expect(s.allowedCommands).toEqual(["cargo", "npm", "pnpm", "pytest", "make", "node"]);
    expect(s.allowToolRules).toEqual(
      expect.arrayContaining(["Edit", "Write", "MultiEdit", "NotebookEdit", "Edit(src/**)", "Write(tests/**)"]),
    );
    // paths.deny → denied write globs
    expect(s.denyToolRules).toEqual(expect.arrayContaining(["Edit(**/.env)", "Write(.git/**)"]));
  });

  it("denies the edit tools when a profile sets edit/write to deny", () => {
    const s = resolveProfileSettings(profile("pf_review")); // edit:deny, write:deny, task:allow
    expect(s.denyToolRules).toEqual(expect.arrayContaining(["Edit", "MultiEdit", "NotebookEdit", "Write"]));
    expect(s.allowToolRules).toContain("Task");
  });

  it("dedupes repeated rules", () => {
    const s = resolveProfileSettings(profile("pf_auto")); // paths.allow: ["**/*"]
    const editAll = s.allowToolRules.filter((r) => r === "Edit(**/*)");
    expect(editAll).toHaveLength(1);
  });
});
