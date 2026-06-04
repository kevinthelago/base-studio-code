import { describe, it, expect } from "vitest";
import { repoPromptKey } from "../lib/startupPrompt";

// Startup-prompt resolution moved to lib/assignments.ts (#324/#326); see
// assignments.test.ts for the cascade tests. Only the shared key helper remains.
describe("repoPromptKey", () => {
  it("scopes a repo to its project", () => {
    expect(repoPromptKey("P1", "acme/api")).toBe("P1::acme/api");
  });

  it("distinguishes the same repo across two projects", () => {
    expect(repoPromptKey("P1", "acme/api")).not.toBe(repoPromptKey("P2", "acme/api"));
  });
});
