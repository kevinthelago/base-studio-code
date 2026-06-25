import { describe, it, expect } from "vitest";
import { authoringChecks } from "./BlueprintAuthorViews";
import { mkSection, type Blueprint } from "../stages/blueprints";

describe("authoringChecks (#923 — Review-stage lint)", () => {
  const base = (over: Partial<Blueprint>): Blueprint =>
    ({ id: "x", name: "", desc: "", sections: [], ...over }) as Blueprint;

  it("flags each missing requirement and passes a complete blueprint", () => {
    const empty = authoringChecks(base({}));
    expect(empty.every((c) => !c.ok)).toBe(true);
    expect(empty.map((c) => c.id)).toEqual(["name", "tags", "count", "prompts"]);

    const complete = authoringChecks(base({
      name: "Realtime API", pitch: "ship a realtime backend", tags: ["api", "realtime"],
      sections: [{ ...mkSection("purpose"), prompt: "do x" }, { ...mkSection("bp_stages"), prompt: "do y" }],
    }));
    expect(complete.every((c) => c.ok)).toBe(true);
  });

  it("fails the prompts check when any stage has an empty prompt module", () => {
    const checks = authoringChecks(base({
      name: "BP", pitch: "p", tags: ["api"],
      sections: [{ ...mkSection("purpose"), prompt: "x" }, { ...mkSection("bp_stages"), prompt: "  " }],
    }));
    const prompts = checks.find((c) => c.id === "prompts")!;
    expect(prompts.ok).toBe(false);
    expect(prompts.detail).toBe("1 empty");
  });
});
