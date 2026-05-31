import { describe, it, expect } from "vitest";
import { interpretGithubReadiness, type GithubProbe } from "../lib/githubReadiness";

const probe = (p: Partial<GithubProbe>): GithubProbe => ({
  ghOnPath: true,
  gitOnPath: true,
  ghAuthed: true,
  ...p,
});

describe("interpretGithubReadiness", () => {
  it("reports ready when all three checks pass", () => {
    const r = interpretGithubReadiness(probe({}));
    expect(r.status).toBe("ready");
    expect(r.ok).toBe(true);
    expect(r.message).toBe("");
  });

  it("flags git-missing first — the most fundamental failure", () => {
    // git missing AND gh missing AND unauthed: git wins (worst-first precedence).
    const r = interpretGithubReadiness(probe({ gitOnPath: false, ghOnPath: false, ghAuthed: false }));
    expect(r.status).toBe("git-missing");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/git is not on this session's PATH/);
  });

  it("flags gh-missing when git is present but gh is not", () => {
    const r = interpretGithubReadiness(probe({ ghOnPath: false, ghAuthed: false }));
    expect(r.status).toBe("gh-missing");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/GitHub CLI \(gh\) is not on this session's PATH/);
  });

  it("flags gh-unauthed when gh is present on PATH but not authenticated", () => {
    const r = interpretGithubReadiness(probe({ ghAuthed: false }));
    expect(r.status).toBe("gh-unauthed");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/installed but not authenticated/);
  });

  it("every non-ready status carries a non-empty actionable message", () => {
    for (const p of [
      { gitOnPath: false },
      { ghOnPath: false },
      { ghAuthed: false },
    ]) {
      const r = interpretGithubReadiness(probe(p));
      expect(r.ok).toBe(false);
      expect(r.message.length).toBeGreaterThan(0);
    }
  });
});
