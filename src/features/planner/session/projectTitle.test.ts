import { describe, it, expect } from "vitest";
import { deriveProjectTitle } from "./projectTitle";

describe("deriveProjectTitle", () => {
  it("uses a published project's name, not the goal heading (the triage-tab '# Goal' bug)", () => {
    // STEM: no planning title; the goal prose starts with a markdown heading. The tab must be
    // named "STEM", not "# Goal".
    expect(deriveProjectTitle("", "# Goal\n\nBuild a STEM learning platform.", "STEM")).toBe("STEM");
  });

  it("an explicit planning title wins over everything", () => {
    expect(deriveProjectTitle("My Title", "# Goal\n\nx.", "STEM")).toBe("My Title");
  });

  it("when unnamed, skips the markdown heading and uses the first goal sentence", () => {
    expect(deriveProjectTitle("", "# Goal\n\nBuild a STEM learning platform. More text.", ""))
      .toBe("Build a STEM learning platform");
  });

  it("a heading-less goal still derives its first sentence", () => {
    expect(deriveProjectTitle("", "Ship the thing fast. Then iterate.", "")).toBe("Ship the thing fast");
  });

  it("falls back to a default when there is nothing to go on", () => {
    expect(deriveProjectTitle("", "", "")).toBe("New project");
    expect(deriveProjectTitle("", "# Goal\n\n", "")).toBe("New project");
  });
});
