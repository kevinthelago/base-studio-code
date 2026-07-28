import { describe, it, expect } from "vitest";
import {
  isAgentWorktreeCwd,
  agentWorktreeCwd,
  sanitizeProjectKey,
  projectSlug,
  repoShortName,
  projectRepoCwd,
  findProjectTabIdx,
  deriveTabIdentity,
  findByTitle,
} from "./projectPaths";

describe("sanitizeProjectKey", () => {
  it("replaces spaces and slashes with underscores", () => {
    expect(sanitizeProjectKey("World of Tanks Strategy")).toBe("World_of_Tanks_Strategy");
    expect(sanitizeProjectKey("acme/payments v2")).toBe("acme_payments_v2");
  });

  it("keeps ASCII alphanumerics and dashes", () => {
    expect(sanitizeProjectKey("my-project-123")).toBe("my-project-123");
  });

  it("replaces other punctuation and unicode letters with underscores", () => {
    expect(sanitizeProjectKey("café.dot!")).toBe("caf__dot_");
  });

  it("caps the result at 80 characters", () => {
    const long = "a".repeat(120);
    expect(sanitizeProjectKey(long)).toHaveLength(80);
  });
});

describe("projectSlug (#2409)", () => {
  it("is a readable, lowercase slug of the name", () => {
    expect(projectSlug("Video Game")).toBe("video-game");
    expect(projectSlug("Acme Payments v2!")).toBe("acme-payments-v2");
    expect(projectSlug("  Trim  Me  ")).toBe("trim-me");
  });

  it("is slug-safe so the backend sanitizeProjectKey is a no-op on it", () => {
    for (const name of ["Video Game", "café.dot!", "a/b c", "MiXeD CaSe 123"]) {
      const key = projectSlug(name);
      expect(key).toMatch(/^[a-z0-9-]+$/);
      expect(sanitizeProjectKey(key)).toBe(key); // backend leaves it byte-for-byte
    }
  });

  it("caps at 60 chars and falls back to 'project' for emoji-only / non-latin names", () => {
    expect(projectSlug("x".repeat(100))).toHaveLength(60);
    expect(projectSlug("🎮🎮")).toBe("project");
    expect(projectSlug("")).toBe("project");
  });

  it("is deterministic — the SAME name yields the SAME key (a collision the create modal resolves)", () => {
    // Under #2409 the name IS the identity, so two same-named projects DO collide (by design) — the
    // creation modal blocks the duplicate rather than minting a distinct opaque id like #1741 did.
    expect(projectSlug("Video Game")).toBe(projectSlug("video game"));
  });
});

describe("repoShortName", () => {
  it("returns the part after the last slash", () => {
    expect(repoShortName("owner/name")).toBe("name");
  });

  it("handles deeper paths by taking the last segment", () => {
    expect(repoShortName("org/group/repo")).toBe("repo");
  });

  it("returns the input unchanged when there is no slash", () => {
    expect(repoShortName("standalone")).toBe("standalone");
  });
});

describe("projectRepoCwd", () => {
  it("builds <base>/projects/<key>/<repo> with a posix base", () => {
    expect(projectRepoCwd("/home/me/.base-studio-code", "WoToS", "acme/wotos-ui")).toBe(
      "/home/me/.base-studio-code/projects/WoToS/wotos-ui",
    );
  });

  it("uses backslashes for a Windows base", () => {
    expect(
      projectRepoCwd("C:\\Users\\me\\.base-studio-code", "My Project", "acme/api"),
    ).toBe("C:\\Users\\me\\.base-studio-code\\projects\\My_Project\\api");
  });

  it("sanitizes the project name into the path", () => {
    expect(projectRepoCwd("/base", "a b/c", "o/r")).toBe("/base/projects/a_b_c/r");
  });

  it("returns an empty string for an empty base dir", () => {
    expect(projectRepoCwd("", "p", "o/r")).toBe("");
  });
});


describe("findProjectTabIdx (#457 — match on stable key, not name)", () => {
  const tabs = [
    { name: "tab-1", layout: "1×1" }, // ad-hoc, no identity
    { name: "Beta · build", layout: "2×2", projectKey: "k1", kind: "build" as const, seq: 0 },
    { name: "Beta · build 2", layout: "2×2", projectKey: "k1", kind: "build" as const, seq: 1 },
    { name: "Beta · triage", layout: "2×1", projectKey: "k1", kind: "triage" as const, seq: 0 },
    { name: "Other · build", layout: "1×1", projectKey: "k2", kind: "build" as const, seq: 0 },
  ];
  it("finds the primary build tab by key + seq 0", () => {
    expect(findProjectTabIdx(tabs, "k1", "build", 0)).toBe(1);
  });
  it("finds an overflow build tab by its seq", () => {
    expect(findProjectTabIdx(tabs, "k1", "build", 1)).toBe(2);
  });
  it("finds the triage tab regardless of seq", () => {
    expect(findProjectTabIdx(tabs, "k1", "triage")).toBe(3);
    expect(findProjectTabIdx(tabs, "k1", "triage", 5)).toBe(3);
  });
  it("does not match a different project's key, or a name-only ad-hoc tab", () => {
    expect(findProjectTabIdx(tabs, "k9", "build")).toBe(-1);
    expect(findProjectTabIdx(tabs, "k1", "build", 9)).toBe(-1);
  });
  it("ignores the display name entirely (a renamed tab still matches its key)", () => {
    const renamed = [{ name: "WHATEVER", layout: "2×2", projectKey: "k1", kind: "build" as const, seq: 0 }];
    expect(findProjectTabIdx(renamed, "k1", "build")).toBe(0);
  });
});

describe("deriveTabIdentity (#457 migration — back-derive from a frozen name)", () => {
  it("derives a primary build tab (seq 0)", () => {
    expect(deriveTabIdentity("My Project · build")).toEqual({ projectKey: "My_Project", kind: "build", seq: 0 });
  });
  it("derives an overflow build tab (· build N → seq N-1)", () => {
    expect(deriveTabIdentity("My Project · build 2")).toEqual({ projectKey: "My_Project", kind: "build", seq: 1 });
    expect(deriveTabIdentity("My Project · build 3")).toEqual({ projectKey: "My_Project", kind: "build", seq: 2 });
  });
  it("derives a triage tab", () => {
    expect(deriveTabIdentity("My Project · triage")).toEqual({ projectKey: "My_Project", kind: "triage", seq: 0 });
  });
  it("returns null for an ad-hoc / manually-named tab", () => {
    expect(deriveTabIdentity("tab-1")).toBeNull();
    expect(deriveTabIdentity("scratch")).toBeNull();
  });
  it("matches the launch-time key for the same name (round-trips with sanitizeProjectKey)", () => {
    const derived = deriveTabIdentity("Alpha Beta · build")!;
    expect(derived.projectKey).toBe(sanitizeProjectKey("Alpha Beta"));
  });
});

describe("findByTitle (#380/#444 — one title matcher)", () => {
  const projects = [
    { id: "1", title: "Studio Code" },
    { id: "2", title: "  Github Pretty Readme  " },
  ];
  const get = (p: { title: string }) => p.title;
  it("matches case-insensitively", () => {
    expect(findByTitle(projects, "studio code", get)?.id).toBe("1");
    expect(findByTitle(projects, "STUDIO CODE", get)?.id).toBe("1");
  });
  it("ignores surrounding whitespace on both sides", () => {
    expect(findByTitle(projects, "github pretty readme", get)?.id).toBe("2");
    expect(findByTitle(projects, "  Studio Code  ", get)?.id).toBe("1");
  });
  it("returns null for no match or a blank title", () => {
    expect(findByTitle(projects, "nope", get)).toBeNull();
    expect(findByTitle(projects, "   ", get)).toBeNull();
    expect(findByTitle(projects, "", get)).toBeNull();
  });
  it("returns the first match when several share a title", () => {
    const dups = [{ id: "a", title: "Dup" }, { id: "b", title: "dup" }];
    expect(findByTitle(dups, "DUP", p => p.title)?.id).toBe("a");
  });
});

describe("isAgentWorktreeCwd (#3937)", () => {
  const REPO = "kevinthelago/networkmonitor";

  it("accepts the agent's own worktree", () => {
    expect(isAgentWorktreeCwd("C:\\wt\\network-monitor\\networkmonitor--auth", REPO, "auth")).toBe(true);
  });

  it("accepts it with either separator and a trailing slash", () => {
    expect(isAgentWorktreeCwd("/c/wt/network-monitor/networkmonitor--auth/", REPO, "auth")).toBe(true);
  });

  it("REJECTS the worktrees container — the poisoned value OSC 7 wrote back", () => {
    // The whole point: this directory EXISTS, so `dir_exists` passes for it forever and the pane
    // relaunches into the app's data dir on every resume. Only a shape check catches it.
    expect(isAgentWorktreeCwd("C:/Users/k/.base-studio-code/worktrees/network-monitor", REPO, "auth")).toBe(false);
  });

  it("rejects ANOTHER agent's worktree", () => {
    expect(isAgentWorktreeCwd("/c/wt/network-monitor/networkmonitor--other", REPO, "auth")).toBe(false);
  });

  it("rejects a different repo's worktree for the same agent id", () => {
    expect(isAgentWorktreeCwd("/c/wt/p/otherrepo--auth", REPO, "auth")).toBe(false);
  });

  it("rejects an empty cwd", () => {
    expect(isAgentWorktreeCwd("", REPO, "auth")).toBe(false);
  });

  it("agrees with what agentWorktreeCwd builds — the two must not drift", () => {
    const built = agentWorktreeCwd("C:\\base", "network-monitor", REPO, "auth");
    expect(isAgentWorktreeCwd(built, REPO, "auth")).toBe(true);
  });

  it("handles an agent id needing slug sanitisation", () => {
    const built = agentWorktreeCwd("/base", "p", REPO, "feat/thing x");
    expect(isAgentWorktreeCwd(built, REPO, "feat/thing x")).toBe(true);
  });
});
