import { describe, it, expect } from "vitest";
import {
  sanitizeProjectKey,
  projectSlug,
  repoShortName,
  projectRepoCwd,
  isKnownPublishedKey,
  canonicalProjectKey,
  findProjectTabIdx,
  deriveTabIdentity,
  resolveProjectKey,
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


describe("isKnownPublishedKey (#380 — guard the draft clean-start delete)", () => {
  const alias = {
    "PVT_kwHOA_BZbml": "github-pretty-readme",
    "PVT_kwHOA_BYsJC": "studio-code",
  };
  it("is true when a node id is aliased to the draft key", () => {
    expect(isKnownPublishedKey("github-pretty-readme", alias)).toBe(true);
    expect(isKnownPublishedKey("studio-code", alias)).toBe(true);
  });
  it("is false for a name no node id maps to (a genuine unpublished draft)", () => {
    expect(isKnownPublishedKey("brand-new-idea", alias)).toBe(false);
  });
  it("is false against an empty alias map", () => {
    expect(isKnownPublishedKey("github-pretty-readme", {})).toBe(false);
  });
  it("matches the published NAME, not a node id key", () => {
    // a node id is a KEY, never a value — so passing one must not falsely match
    expect(isKnownPublishedKey("PVT_kwHOA_BZbml", alias)).toBe(false);
  });
});

describe("canonicalProjectKey (#457/#380 — one canonical identity)", () => {
  it("prefers the explicit projectId (stable across renames), sanitized", () => {
    expect(canonicalProjectKey("Display Name", "PVT_node id")).toBe("PVT_node_id");
  });
  it("falls back to the sanitized name when no id is given", () => {
    expect(canonicalProjectKey("My Project")).toBe("My_Project");
    expect(canonicalProjectKey("My Project", "")).toBe("My_Project");
    expect(canonicalProjectKey("My Project", "   ")).toBe("My_Project");
  });
  it("renaming the display name does not change the key when an id is present", () => {
    expect(canonicalProjectKey("Alpha", "PID1")).toBe(canonicalProjectKey("Beta", "PID1"));
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

describe("resolveProjectKey (#380 — one canonical workspace key)", () => {
  const alias = { "PVT_node1": "my-project", "PVT_node2": "other" };
  it("maps an aliased node id to its stable folder key", () => {
    expect(resolveProjectKey("PVT_node1", alias)).toBe("my-project");
  });
  it("returns the raw key unchanged when no alias maps it (local-only draft)", () => {
    expect(resolveProjectKey("my-project", alias)).toBe("my-project");
    expect(resolveProjectKey("brand-new", alias)).toBe("brand-new");
  });
  it("is a no-op against an empty alias map", () => {
    expect(resolveProjectKey("PVT_node1", {})).toBe("PVT_node1");
  });
  it("a write key and a read key derived through it agree (no divergence)", () => {
    // Board-reached session keys off the node id; the planner wrote under the folder key.
    const writeKey = resolveProjectKey("my-project", alias); // planner's raw folder key
    const readKey = resolveProjectKey("PVT_node1", alias);   // board's node id
    expect(writeKey).toBe(readKey);
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
