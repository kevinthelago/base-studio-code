import { describe, it, expect } from "vitest";
import {
  parseTopicKey,
  titleForTopic,
  orderTopicKeys,
  groupTopics,
  parseSkipped,
  canonicalTopicKey,
  KNOWN_DIMENSIONS,
  SKIPPED_KEY,
  FEATURES_KEY,
} from "./planTopics";
import { FLEET_KEY } from "../fleet/planFleet";
import discoveryStage from "@data/stages/discovery.json";

describe("parseTopicKey", () => {
  it("treats a bare key as a project-tier section", () => {
    expect(parseTopicKey("security")).toEqual({ tier: "project", repo: null, topic: "security" });
  });

  it("decodes a repo-namespaced key into repo + topic", () => {
    expect(parseTopicKey("repo__web__api")).toEqual({ tier: "repo", repo: "web", topic: "api" });
  });

  it("keeps multi-part topics intact after the repo segment", () => {
    expect(parseTopicKey("repo__api__data_lifecycle")).toEqual({
      tier: "repo", repo: "api", topic: "data_lifecycle",
    });
  });

  it("falls back to an overview topic when a repo key has no topic", () => {
    expect(parseTopicKey("repo__web")).toEqual({ tier: "repo", repo: "web", topic: "overview" });
  });

  it("does not treat a project key with underscores as a repo key", () => {
    expect(parseTopicKey("data_lifecycle")).toEqual({
      tier: "project", repo: null, topic: "data_lifecycle",
    });
  });
});

describe("titleForTopic", () => {
  it("uses curated titles for known dimensions", () => {
    expect(titleForTopic("cicd")).toBe("CI/CD");
    expect(titleForTopic("api")).toBe("API & contracts");
    expect(titleForTopic("observability")).toBe("Observability & logging");
  });

  it("humanizes custom project topics", () => {
    expect(titleForTopic("feature_flags")).toBe("Feature Flags");
  });

  it("applies acronym casing inside custom topics", () => {
    expect(titleForTopic("sql_tuning")).toBe("SQL Tuning");
  });

  it("titles a repo-tier section by its topic", () => {
    expect(titleForTopic("repo__web__api")).toBe("API & contracts");
  });

  it("labels the skipped record", () => {
    expect(titleForTopic(SKIPPED_KEY)).toBe("Considered & skipped");
  });
});

describe("orderTopicKeys", () => {
  it("orders known dimensions by the curated checklist regardless of input order", () => {
    expect(orderTopicKeys(["phases", "goal", "stack"])).toEqual(["goal", "stack", "phases"]);
  });

  it("places custom keys after all known dimensions, alphabetically", () => {
    const ordered = orderTopicKeys(["zeta_topic", "goal", "alpha_topic"]);
    expect(ordered[0]).toBe("goal");
    expect(ordered.slice(1)).toEqual(["alpha_topic", "zeta_topic"]);
  });
});

describe("groupTopics", () => {
  it("separates project-tier keys from per-repo groups", () => {
    const { project, repos } = groupTopics([
      "goal", "repo__web__api", "security", "repo__web__testing", "repo__api__schema",
    ]);
    expect(project).toEqual(["goal", "security"]);
    expect(repos).toEqual([
      { repo: "api", keys: ["repo__api__schema"] },
      { repo: "web", keys: ["repo__web__api", "repo__web__testing"] },
    ]);
  });

  it("excludes the skipped record and the DB-owned config keys from both tiers", () => {
    const { project, repos } = groupTopics(["goal", SKIPPED_KEY, FLEET_KEY, FEATURES_KEY]);
    expect(project).toEqual(["goal"]);
    expect(repos).toEqual([]);
  });

  it("orders each repo's topics by the curated checklist", () => {
    const { repos } = groupTopics(["repo__web__phases", "repo__web__goal", "repo__web__api"]);
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
  it("leads with goal and no longer carries a milestone-phases dimension (#1912)", () => {
    expect(KNOWN_DIMENSIONS[0].key).toBe("goal");
    expect(KNOWN_DIMENSIONS.some(d => d.key === "phases")).toBe(false);
  });

  it("has unique keys", () => {
    const keys = KNOWN_DIMENSIONS.map(d => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("carries the cloud outage response dimension right after reliability (#3989)", () => {
    const keys = KNOWN_DIMENSIONS.map(d => d.key);
    expect(keys).toContain("outage_response");
    // It reads as the resilience pair to `reliability` — keep them adjacent in the checklist so the
    // planner walks them together.
    expect(keys.indexOf("outage_response")).toBe(keys.indexOf("reliability") + 1);
    expect(titleForTopic("outage_response")).toBe("Cloud outage response");
  });

  it("does NOT gate the stage on the outage plan — a CLI has no cloud to lose (#3989)", () => {
    // The baseline required-set is the same file's `requires` array; outage_response is required
    // PER PROJECT via `bsc plan discovery require`, never for everyone.
    expect(discoveryStage.requires).not.toContain("outage_response");
    expect(discoveryStage.requires).toContain("goal"); // sanity: we read the right array
  });
});

describe("canonicalTopicKey", () => {
  it("maps the display title (and casing/separator variants) back to the key — the stack.md fix", () => {
    expect(canonicalTopicKey("Tech stack")).toBe("stack");
    expect(canonicalTopicKey("Tech_stack")).toBe("stack");
    expect(canonicalTopicKey("tech-stack")).toBe("stack");
    expect(canonicalTopicKey("technology stack")).toBe("stack");
    expect(canonicalTopicKey("techstack")).toBe("stack");
  });
  it("canonicalizes other core titles too", () => {
    expect(canonicalTopicKey("Architecture")).toBe("architecture");
    expect(canonicalTopicKey("Data model")).toBe("schema");
    expect(canonicalTopicKey("Users & personas")).toBe("users");
  });
  it("lands every way the planner titles the outage plan on one key (#3989)", () => {
    for (const variant of [
      "Cloud outage response", "cloud-outage-response", "Outage response",
      "Cloud outage response plan", "Outage_response_plan", "Cloud outage", "Outage",
    ]) {
      expect(canonicalTopicKey(variant)).toBe("outage_response");
    }
  });

  it("passes canonical keys and unknown custom topics through unchanged", () => {
    expect(canonicalTopicKey("stack")).toBe("stack");
    expect(canonicalTopicKey("goal")).toBe("goal");
    expect(canonicalTopicKey("offline_sync")).toBe("offline_sync");
  });
});

describe("groupTopics excludes the fleet config", () => {
  it("does not surface the fleet key as a renderable section", () => {
    const { project, repos } = groupTopics(["goal", FLEET_KEY, "phases"]);
    expect(project).toEqual(["goal", "phases"]);
    expect(repos).toEqual([]);
  });
});
