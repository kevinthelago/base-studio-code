import { describe, it, expect } from "vitest";
import {
  parseSectionKey,
  titleForKey,
  orderProjectKeys,
  groupSections,
  parseSkipped,
  parseFleetFile,
  canonicalSectionKey,
  KNOWN_DIMENSIONS,
  SKIPPED_KEY,
  FLEET_KEY,
  FEATURES_KEY,
  parseReposFile,
} from "./planSections";

describe("parseSectionKey", () => {
  it("treats a bare key as a project-tier section", () => {
    expect(parseSectionKey("security")).toEqual({ tier: "project", repo: null, topic: "security" });
  });

  it("decodes a repo-namespaced key into repo + topic", () => {
    expect(parseSectionKey("repo__web__api")).toEqual({ tier: "repo", repo: "web", topic: "api" });
  });

  it("keeps multi-part topics intact after the repo segment", () => {
    expect(parseSectionKey("repo__api__data_lifecycle")).toEqual({
      tier: "repo", repo: "api", topic: "data_lifecycle",
    });
  });

  it("falls back to an overview topic when a repo key has no topic", () => {
    expect(parseSectionKey("repo__web")).toEqual({ tier: "repo", repo: "web", topic: "overview" });
  });

  it("does not treat a project key with underscores as a repo key", () => {
    expect(parseSectionKey("data_lifecycle")).toEqual({
      tier: "project", repo: null, topic: "data_lifecycle",
    });
  });
});

describe("titleForKey", () => {
  it("uses curated titles for known dimensions", () => {
    expect(titleForKey("cicd")).toBe("CI/CD");
    expect(titleForKey("api")).toBe("API & contracts");
    expect(titleForKey("observability")).toBe("Observability & logging");
  });

  it("humanizes custom project topics", () => {
    expect(titleForKey("feature_flags")).toBe("Feature Flags");
  });

  it("applies acronym casing inside custom topics", () => {
    expect(titleForKey("sql_tuning")).toBe("SQL Tuning");
  });

  it("titles a repo-tier section by its topic", () => {
    expect(titleForKey("repo__web__api")).toBe("API & contracts");
  });

  it("labels the skipped record", () => {
    expect(titleForKey(SKIPPED_KEY)).toBe("Considered & skipped");
  });
});

describe("orderProjectKeys", () => {
  it("orders known dimensions by the curated checklist regardless of input order", () => {
    expect(orderProjectKeys(["phases", "goal", "stack"])).toEqual(["goal", "stack", "phases"]);
  });

  it("places custom keys after all known dimensions, alphabetically", () => {
    const ordered = orderProjectKeys(["zeta_topic", "goal", "alpha_topic"]);
    expect(ordered[0]).toBe("goal");
    expect(ordered.slice(1)).toEqual(["alpha_topic", "zeta_topic"]);
  });
});

describe("groupSections", () => {
  it("separates project-tier keys from per-repo groups", () => {
    const { project, repos } = groupSections([
      "goal", "repo__web__api", "security", "repo__web__testing", "repo__api__schema",
    ]);
    expect(project).toEqual(["goal", "security"]);
    expect(repos).toEqual([
      { repo: "api", keys: ["repo__api__schema"] },
      { repo: "web", keys: ["repo__web__api", "repo__web__testing"] },
    ]);
  });

  it("excludes the skipped record and the DB-owned config keys from both tiers", () => {
    const { project, repos } = groupSections(["goal", SKIPPED_KEY, FLEET_KEY, FEATURES_KEY]);
    expect(project).toEqual(["goal"]);
    expect(repos).toEqual([]);
  });

  it("orders each repo's topics by the curated checklist", () => {
    const { repos } = groupSections(["repo__web__phases", "repo__web__goal", "repo__web__api"]);
    expect(repos[0].keys).toEqual(["repo__web__goal", "repo__web__api", "repo__web__phases"]);
  });
});

describe("parseSkipped", () => {
  it("parses bolded em-dash list items", () => {
    expect(parseSkipped("- **Schema** — no persistent data store")).toEqual([
      { topic: "Schema", reason: "no persistent data store" },
    ]);
  });

  it("parses colon and hyphen separators", () => {
    expect(parseSkipped("- Auth: handled by the platform\n- i18n - single locale only")).toEqual([
      { topic: "Auth", reason: "handled by the platform" },
      { topic: "i18n", reason: "single locale only" },
    ]);
  });

  it("keeps a topic with no reason", () => {
    expect(parseSkipped("- Analytics")).toEqual([{ topic: "Analytics", reason: "" }]);
  });

  it("ignores headers, rules, and blank lines", () => {
    const md = "# Skipped\n\n---\n- Cost — internal tool, no budget tracking\n\n";
    expect(parseSkipped(md)).toEqual([{ topic: "Cost", reason: "internal tool, no budget tracking" }]);
  });

  it("returns [] for empty content", () => {
    expect(parseSkipped("")).toEqual([]);
  });
});

describe("KNOWN_DIMENSIONS", () => {
  it("leads with goal and includes the publish-critical phases dimension", () => {
    expect(KNOWN_DIMENSIONS[0].key).toBe("goal");
    expect(KNOWN_DIMENSIONS.some(d => d.key === "phases")).toBe(true);
  });

  it("has unique keys", () => {
    const keys = KNOWN_DIMENSIONS.map(d => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("canonicalSectionKey", () => {
  it("maps the display title (and casing/separator variants) back to the key — the stack.md fix", () => {
    expect(canonicalSectionKey("Tech stack")).toBe("stack");
    expect(canonicalSectionKey("Tech_stack")).toBe("stack");
    expect(canonicalSectionKey("tech-stack")).toBe("stack");
    expect(canonicalSectionKey("technology stack")).toBe("stack");
    expect(canonicalSectionKey("techstack")).toBe("stack");
  });
  it("canonicalizes other core titles too", () => {
    expect(canonicalSectionKey("Architecture")).toBe("architecture");
    expect(canonicalSectionKey("Data model")).toBe("schema");
    expect(canonicalSectionKey("Users & personas")).toBe("users");
  });
  it("passes canonical keys and unknown custom topics through unchanged", () => {
    expect(canonicalSectionKey("stack")).toBe("stack");
    expect(canonicalSectionKey("goal")).toBe("goal");
    expect(canonicalSectionKey("offline_sync")).toBe("offline_sync");
  });
});

describe("groupSections excludes the fleet config", () => {
  it("does not surface the fleet key as a renderable section", () => {
    const { project, repos } = groupSections(["goal", FLEET_KEY, "phases"]);
    expect(project).toEqual(["goal", "phases"]);
    expect(repos).toEqual([]);
  });
});

describe("parseFleetFile", () => {
  it("parses a full fleet, defaulting list fields", () => {
    const raw = JSON.stringify({
      recommended: 3,
      reasoning: "three independent areas",
      director: { enabled: true, role: "integrator" },
      streams: [
        { id: "auth-ui", name: "Auth UI", repo: "own/web", owns: ["src/auth/**"], issues: ["#1", "#2"], dependsOn: [], prompt: "prompts/auth-ui-kickoff.md" },
        { id: "api", repo: "own/api" },
      ],
    });
    expect(parseFleetFile(raw)).toEqual({
      recommended: 3,
      reasoning: "three independent areas",
      director: { enabled: true, role: "integrator", drive: "event" },
      streams: [
        { id: "auth-ui", name: "Auth UI", repo: "own/web", owns: ["src/auth/**"], issues: ["#1", "#2"], dependsOn: [], prompt: "prompts/auth-ui-kickoff.md" },
        { id: "api", name: "api", repo: "own/api", owns: [], issues: [], dependsOn: [], prompt: undefined },
      ],
      // Agent-relationship fields default to empty when the fleet declares none (#…).
      artifacts: [],
      edges: [],
    });
  });

  it("drops streams missing id or repo", () => {
    const raw = JSON.stringify({ streams: [{ name: "no id", repo: "own/web" }, { id: "no-repo" }, { id: "ok", repo: "own/api" }] });
    expect(parseFleetFile(raw)?.streams.map(s => s.id)).toEqual(["ok"]);
  });

  it("carries a stream's assigned MCP servers, undefined when none (#1054)", () => {
    const raw = JSON.stringify({
      streams: [
        { id: "sci", repo: "o/r", mcp: ["Research", "Compliance"] },
        { id: "ui", repo: "o/r" },
      ],
    });
    const fleet = parseFleetFile(raw)!;
    expect(fleet.streams[0].mcp).toEqual(["Research", "Compliance"]);
    expect(fleet.streams[1].mcp).toBeUndefined();
  });

  it("carries a stream's granted commands, undefined when none (#1572)", () => {
    const raw = JSON.stringify({
      streams: [
        { id: "rust", repo: "o/r", commands: ["cargo", "wasm-pack"] },
        { id: "ui", repo: "o/r" },
      ],
    });
    const fleet = parseFleetFile(raw)!;
    expect(fleet.streams[0].commands).toEqual(["cargo", "wasm-pack"]);
    expect(fleet.streams[1].commands).toBeUndefined();
  });

  it("accepts depends_on as an alias and coerces a string recommended", () => {
    const raw = JSON.stringify({
      recommended: "2",
      director: { enabled: "true" },
      streams: [{ id: "b", repo: "o/r", depends_on: ["a"] }],
    });
    const fleet = parseFleetFile(raw)!;
    expect(fleet.recommended).toBe(2);
    expect(fleet.director.enabled).toBe(true);
    expect(fleet.streams[0].dependsOn).toEqual(["a"]);
  });

  it("round-trips fleet + stream integration strategy (#378)", () => {
    const raw = JSON.stringify({
      recommended: 2,
      strategy: "pr-ci",
      streams: [
        { id: "a", repo: "o/r", strategy: "manual" },
        { id: "b", repo: "o/r" },
      ],
    });
    const fleet = parseFleetFile(raw)!;
    expect(fleet.strategy).toBe("pr-ci");
    expect(fleet.streams[0].strategy).toBe("manual");
    expect(fleet.streams[1].strategy).toBeUndefined();
  });

  it("drops an invalid fleet/stream strategy to undefined (#378)", () => {
    const raw = JSON.stringify({ strategy: "bogus", streams: [{ id: "a", repo: "o/r", strategy: "nope" }] });
    const fleet = parseFleetFile(raw)!;
    expect(fleet.strategy).toBeUndefined();
    expect(fleet.streams[0].strategy).toBeUndefined();
  });

  it("returns null for blank or malformed input", () => {
    expect(parseFleetFile("")).toBeNull();
    expect(parseFleetFile("   ")).toBeNull();
    expect(parseFleetFile("{not json")).toBeNull();
    expect(parseFleetFile("[1,2,3]")).toBeNull();
  });
});


describe("parseReposFile (#378)", () => {
  it("parses a bare JSON array of owner/repo", () => {
    expect(parseReposFile('["acme/web","acme/api"]')).toEqual(["acme/web", "acme/api"]);
  });
  it("accepts a { repos: [...] } wrapper and dedupes + trims", () => {
    expect(parseReposFile('{"repos":[" acme/web ","acme/web","acme/api"]}')).toEqual(["acme/web", "acme/api"]);
  });
  it("ignores non-owner/repo strings and non-strings", () => {
    expect(parseReposFile('["acme/web","notarepo",42,null]')).toEqual(["acme/web"]);
  });
  it("returns [] for blank or malformed input", () => {
    expect(parseReposFile("")).toEqual([]);
    expect(parseReposFile("   ")).toEqual([]);
    expect(parseReposFile("{not json")).toEqual([]);
  });
});
