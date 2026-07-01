import { describe, it, expect } from "vitest";
import {
  buildSectionConfirmMessage, buildSectionSkipMessage,
  scriptDocRelpath,
} from "./planningSession";

describe("buildSectionConfirmMessage", () => {
  it("references the section title and instructs to continue", () => {
    const msg = buildSectionConfirmMessage("Goal");
    expect(msg).toContain('"Goal"');
    expect(msg.toLowerCase()).toContain("continue to the next section");
  });

  it("is a single line (no embedded newline that would submit early)", () => {
    expect(buildSectionConfirmMessage("API")).not.toContain("\n");
  });
});

describe("buildSectionSkipMessage (#921)", () => {
  it("names the skipped stage and tells the planner not to work on it", () => {
    const msg = buildSectionSkipMessage("UI Design");
    expect(msg).toContain('"UI Design"');
    expect(msg.toLowerCase()).toContain("skip");
    expect(msg.toLowerCase()).toContain("do not work on it");
  });

  it("is a single line (no embedded newline that would submit early)", () => {
    expect(buildSectionSkipMessage("MCP Servers")).not.toContain("\n");
  });
});

describe("scriptDocRelpath", () => {
  it("roots a project-relative path under the sanitized project hub", () => {
    expect(scriptDocRelpath("my_project", "prompts/web-kickoff.md"))
      .toBe("projects/my_project/prompts/web-kickoff.md");
  });

  it("leaves an already-rooted projects/ path untouched", () => {
    expect(scriptDocRelpath("k", "projects/k/prompts/x.md")).toBe("projects/k/prompts/x.md");
  });

  it("normalizes backslashes and strips leading slashes", () => {
    expect(scriptDocRelpath("k", "\\prompts\\web.md")).toBe("projects/k/prompts/web.md");
  });
});
