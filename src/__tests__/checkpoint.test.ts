import { describe, it, expect } from "vitest";
import { composeStartupPrompt, checkpointDocRelpath, CHECKPOINT_HEADING } from "../lib/checkpoint";

describe("composeStartupPrompt", () => {
  it("returns the base unchanged when there's no checkpoint", () => {
    expect(composeStartupPrompt("triage this repo", undefined)).toBe("triage this repo");
    expect(composeStartupPrompt("triage this repo", null)).toBe("triage this repo");
    expect(composeStartupPrompt("triage this repo", "   \n  ")).toBe("triage this repo");
  });

  it("appends a non-empty checkpoint under the heading", () => {
    const out = composeStartupPrompt("triage this repo", "Closed #12. Next: wire the webhook.");
    expect(out).toBe(
      `triage this repo\n\n${CHECKPOINT_HEADING}\n\nClosed #12. Next: wire the webhook.`,
    );
  });

  it("trims surrounding whitespace from the checkpoint", () => {
    const out = composeStartupPrompt("base", "\n\n  done some work \n");
    expect(out).toBe(`base\n\n${CHECKPOINT_HEADING}\n\ndone some work`);
  });
});

describe("checkpointDocRelpath", () => {
  it("builds projects/{key}/prompts/{repo}-checkpoint.md from the repo name segment", () => {
    expect(checkpointDocRelpath("WoTos", "acme/web")).toBe("projects/WoTos/prompts/web-checkpoint.md");
  });

  it("uses the bare name when the repo has no owner segment", () => {
    expect(checkpointDocRelpath("proj", "standalone")).toBe("projects/proj/prompts/standalone-checkpoint.md");
  });

  it("slugs unsafe characters in the repo name", () => {
    expect(checkpointDocRelpath("proj", "acme/My App!")).toBe("projects/proj/prompts/my-app--checkpoint.md");
  });
});
