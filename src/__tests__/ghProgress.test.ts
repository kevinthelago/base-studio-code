import { describe, it, expect } from "vitest";
import { buildGhStructure, type Section } from "../screens/planner/github/ghStructure";
import {
  buildProgressOverlay,
  type IssueState,
  type MilestoneState,
} from "../screens/planner/github/ghProgress";

// Minimal section factory - only `k` and `content` matter to the structure.
const sec = (k: Section["k"], content = ""): Section => ({
  k, content, title: k, state: content ? "drafted" : "pending",
});

const PHASES_JSON = JSON.stringify([
  { name: "Phase 1 - Foundation", description: "scaffolding" },
  { name: "Phase 2 - Core",       description: "features" },
]);

const ISSUES_JSON = JSON.stringify([
  { ref: "F1", title: "Add login endpoint",   phase: 1, acceptance: [], owns: [], dependsOn: [], labels: [] },
  { ref: "F2", title: "Wire status command",  phase: 1, acceptance: [], owns: [], dependsOn: [], labels: [] },
]);

const iss = (over: Partial<IssueState>): IssueState => ({
  title: "x", state: "open", number: 1, url: "https://example/1", milestone: null, ...over,
});

const ms = (title: string, open: number, closed: number): MilestoneState => ({ title, open, closed });

describe("buildProgressOverlay", () => {
  it("sets done=true on a closed issue node matched by title", () => {
    const structure = buildGhStructure(
      [sec("phases", PHASES_JSON), sec("issues", ISSUES_JSON)],
      ["acme/api"], "P",
    );
    const overlay = buildProgressOverlay(
      structure,
      { "acme/api": [
        iss({ title: "Add login endpoint", state: "closed", number: 7, url: "https://gh/7" }),
        iss({ title: "Wire status command", state: "open",   number: 8, url: "https://gh/8" }),
      ] },
      {},
    );
    expect(overlay["issue:acme/api:F1"]).toEqual({ done: true,  url: "https://gh/7", number: 7 });
    expect(overlay["issue:acme/api:F2"]).toEqual({ done: false, url: "https://gh/8", number: 8 });
  });

  it("matches titles case-insensitively and trims whitespace", () => {
    const structure = buildGhStructure(
      [sec("phases", PHASES_JSON), sec("issues", ISSUES_JSON)],
      ["acme/api"], "P",
    );
    const overlay = buildProgressOverlay(
      structure,
      { "acme/api": [
        iss({ title: "  add LOGIN endpoint  ", state: "closed", number: 7, url: "https://gh/7" }),
      ] },
      {},
    );
    expect(overlay["issue:acme/api:F1"]).toEqual({ done: true, url: "https://gh/7", number: 7 });
  });

  it("leaves unmatched legacy phase-tracker nodes with no progress", () => {
    const structure = buildGhStructure([sec("phases", PHASES_JSON)], ["acme/api"], "MyProj");
    const overlay = buildProgressOverlay(
      structure,
      { "acme/api": [iss({ title: "Some unrelated issue", state: "closed" })] },
      {},
    );
    expect(overlay["issue:acme/api:0"]).toBeUndefined();
    expect(overlay["issue:acme/api:1"]).toBeUndefined();
    expect(overlay["repo:acme/api"]).toBeUndefined();
    expect(overlay.project).toBeUndefined();
  });

  it("rolls a milestone up across all repos and marks done when open===0", () => {
    const structure = buildGhStructure([sec("phases", PHASES_JSON)], ["acme/api", "acme/web"], "P");
    const overlay = buildProgressOverlay(
      structure,
      {},
      {
        "acme/api": [ms("Phase 1 - Foundation", 1, 2), ms("Phase 2 - Core", 0, 0)],
        "acme/web": [ms("Phase 1 - Foundation", 0, 3), ms("Phase 2 - Core", 2, 1)],
      },
    );
    expect(overlay["ms:0"]).toEqual({ closed: 5, total: 6, done: false });
    expect(overlay["ms:1"]).toEqual({ closed: 1, total: 3, done: false });
  });

  it("marks a milestone done when every repo reports zero open and total>0", () => {
    const structure = buildGhStructure([sec("phases", PHASES_JSON)], ["acme/api", "acme/web"], "P");
    const overlay = buildProgressOverlay(
      structure,
      {},
      {
        "acme/api": [ms("Phase 1 - Foundation", 0, 4)],
        "acme/web": [ms("Phase 1 - Foundation", 0, 1)],
      },
    );
    expect(overlay["ms:0"]).toEqual({ closed: 5, total: 5, done: true });
  });

  it("does not mark an empty milestone (total===0) as done", () => {
    const structure = buildGhStructure([sec("phases", PHASES_JSON)], ["acme/api"], "P");
    const overlay = buildProgressOverlay(
      structure, {}, { "acme/api": [ms("Phase 1 - Foundation", 0, 0)] },
    );
    expect(overlay["ms:0"]).toEqual({ closed: 0, total: 0, done: false });
  });

  it("omits a milestone node entirely when no repo has that milestone", () => {
    const structure = buildGhStructure([sec("phases", PHASES_JSON)], ["acme/api"], "P");
    const overlay = buildProgressOverlay(structure, {}, { "acme/api": [] });
    expect(overlay["ms:0"]).toBeUndefined();
    expect(overlay["ms:1"]).toBeUndefined();
  });

  it("rolls matched issue nodes up to the repo and project nodes", () => {
    const structure = buildGhStructure(
      [sec("phases", PHASES_JSON), sec("issues", ISSUES_JSON)],
      ["acme/api"], "P",
    );
    const overlay = buildProgressOverlay(
      structure,
      { "acme/api": [
        iss({ title: "Add login endpoint",  state: "closed" }),
        iss({ title: "Wire status command", state: "open" }),
      ] },
      {},
    );
    expect(overlay["repo:acme/api"]).toEqual({ closed: 1, total: 2 });
    expect(overlay.project).toEqual({ closed: 1, total: 2 });
  });

  it("aggregates the project rollup across multiple repos", () => {
    const issuesApi = [
      { ref: "A1", title: "API one", phase: 1, acceptance: [], owns: [], dependsOn: [], labels: [], repo: "acme/api" },
    ];
    const issuesWeb = [
      { ref: "W1", title: "Web one", phase: 1, acceptance: [], owns: [], dependsOn: [], labels: [], repo: "acme/web" },
      { ref: "W2", title: "Web two", phase: 1, acceptance: [], owns: [], dependsOn: [], labels: [], repo: "acme/web" },
    ];
    const allIssues = JSON.stringify([...issuesApi, ...issuesWeb]);
    const structure = buildGhStructure(
      [sec("phases", PHASES_JSON), sec("issues", allIssues)],
      ["acme/api", "acme/web"], "P",
    );
    const overlay = buildProgressOverlay(
      structure,
      {
        "acme/api": [iss({ title: "API one", state: "closed" })],
        "acme/web": [
          iss({ title: "Web one", state: "closed" }),
          iss({ title: "Web two", state: "open" }),
        ],
      },
      {},
    );
    expect(overlay["repo:acme/api"]).toEqual({ closed: 1, total: 1 });
    expect(overlay["repo:acme/web"]).toEqual({ closed: 1, total: 2 });
    expect(overlay.project).toEqual({ closed: 2, total: 3 });
  });

  it("returns an empty overlay when there is nothing to map", () => {
    const structure = buildGhStructure([], [], "P");
    expect(buildProgressOverlay(structure, {}, {})).toEqual({});
  });

  it("matches an issue node by NUMBER via the links map even when no title matches", () => {
    const structure = buildGhStructure(
      [sec("phases", PHASES_JSON), sec("issues", ISSUES_JSON)],
      ["acme/api"], "P",
    );
    // The plan title drifted: GitHub issue #7's title no longer equals the node label.
    const overlay = buildProgressOverlay(
      structure,
      { "acme/api": [
        iss({ title: "Renamed on GitHub after publish", state: "closed", number: 7, url: "https://gh/7" }),
        iss({ title: "Wire status command",             state: "open",   number: 8, url: "https://gh/8" }),
      ] },
      {},
      { "issue:acme/api:F1": { number: 7, url: "https://gh/7" } },
    );
    // Number-link wins over the (now mismatched) title: F1 is still tracked + closed.
    expect(overlay["issue:acme/api:F1"]).toEqual({ done: true, url: "https://gh/7", number: 7 });
    // F2 still resolves by title (no link), open.
    expect(overlay["issue:acme/api:F2"]).toEqual({ done: false, url: "https://gh/8", number: 8 });
  });

  it("number-matched nodes roll up into the repo and project counts", () => {
    const structure = buildGhStructure(
      [sec("phases", PHASES_JSON), sec("issues", ISSUES_JSON)],
      ["acme/api"], "P",
    );
    const overlay = buildProgressOverlay(
      structure,
      { "acme/api": [
        iss({ title: "drifted A", state: "closed", number: 7, url: "https://gh/7" }),
        iss({ title: "drifted B", state: "open",   number: 8, url: "https://gh/8" }),
      ] },
      {},
      {
        "issue:acme/api:F1": { number: 7, url: "https://gh/7" },
        "issue:acme/api:F2": { number: 8, url: "https://gh/8" },
      },
    );
    // Both nodes matched purely by number (neither title matches) → counted.
    expect(overlay["repo:acme/api"]).toEqual({ closed: 1, total: 2 });
    expect(overlay.project).toEqual({ closed: 1, total: 2 });
  });

  it("falls back to title match when a link points at a missing issue number", () => {
    const structure = buildGhStructure(
      [sec("phases", PHASES_JSON), sec("issues", ISSUES_JSON)],
      ["acme/api"], "P",
    );
    const overlay = buildProgressOverlay(
      structure,
      { "acme/api": [
        iss({ title: "Add login endpoint", state: "closed", number: 7, url: "https://gh/7" }),
      ] },
      {},
      // #999 no longer exists; the node still resolves by its (unchanged) title.
      { "issue:acme/api:F1": { number: 999, url: "https://gh/999" } },
    );
    expect(overlay["issue:acme/api:F1"]).toEqual({ done: true, url: "https://gh/7", number: 7 });
  });

  it("ignores GitHub issues with no matching structure node", () => {
    const structure = buildGhStructure(
      [sec("phases", PHASES_JSON), sec("issues", ISSUES_JSON)],
      ["acme/api"], "P",
    );
    const overlay = buildProgressOverlay(
      structure,
      { "acme/api": [
        iss({ title: "Add login endpoint", state: "closed" }),
        iss({ title: "Totally unrelated",  state: "closed" }),
      ] },
      {},
    );
    expect(overlay["repo:acme/api"]).toEqual({ closed: 1, total: 1 });
  });
});
