// Pure filter/sort tests for the Projects page (#3802) — the Projects twin of skillsFilter's tests.
import { describe, it, expect } from "vitest";
import {
  buildProjectItems, statusCounts, typeCounts, filterProjects, resolveAppType, appTypeFromDeploy,
  STATUS_FACETS, TYPE_FACETS, type ProjectItem,
} from "./projectsFilter";
import type { GhProject } from "./published/publishedModel";
import type { DeployConfig, DeployService } from "@/features/planner/lib/deployServices";

const board = (over: Partial<GhProject> = {}): GhProject => ({
  id: "PVT_1", number: 1, title: "Board One", shortDescription: "a live board", url: "", closed: false,
  updatedAt: new Date("2024-01-01").toISOString(),
  items: { totalCount: 4, nodes: [
    { content: { state: "OPEN" } }, { content: { state: "OPEN" } },
    { content: { state: "CLOSED" } }, { content: { state: "CLOSED" } },
  ] },
  repositories: { nodes: [{ nameWithOwner: "o/repo-a" }, { nameWithOwner: "o/repo-b" }] },
  ...over,
});

const svc = (over: Partial<DeployService>): DeployService => (over as DeployService);

function sample(): ProjectItem[] {
  return buildProjectItems({
    boards: [board(), board({ id: "PVT_2", number: 2, title: "Shipped One", closed: true })],
    localPublished: [{ key: "acme-crm", title: "Acme CRM", updatedAt: 5 }],
    drafts: [
      { key: "raw-idea", title: "Raw Idea", pitch: "just an idea", sort: 10 },
      { key: "in-flight", title: "In Flight", pitch: "", sort: 20 },
    ],
    dbStateByKey: { "in-flight": "planning" },
    fleetByProject: { PVT_1: { running: 2, paused: 1 } },
    // TYPE (application architecture): classification wins for the local hub; the draft is derived
    // from its deploy plan (a serverless service).
    classificationByKey: { "acme-crm": { appType: "api" } },
    deployByKey: { "in-flight": { services: [svc({ mode: "cloud", workload: "serverless" })] } },
  });
}

const byTitle = (items: ProjectItem[], t: string) => items.find((i) => i.title === t)!;

describe("buildProjectItems", () => {
  it("folds the four sources into one list with the right status + source", () => {
    const items = sample();
    expect(items).toHaveLength(5);
    expect(byTitle(items, "Board One")).toMatchObject({ status: "active", source: "board", number: 1 });
    expect(byTitle(items, "Shipped One")).toMatchObject({ status: "shipped", source: "board" });
    expect(byTitle(items, "Acme CRM")).toMatchObject({ status: "active", source: "local", key: "acme-crm" });
    expect(byTitle(items, "In Flight")).toMatchObject({ status: "in-progress", source: "draft" });
    expect(byTitle(items, "Raw Idea")).toMatchObject({ status: "draft", source: "draft" });
  });

  it("resolves each project's application TYPE — classification wins, else deploy, else default", () => {
    const items = sample();
    expect(byTitle(items, "Acme CRM").appType).toBe("api");         // classification appType
    expect(byTitle(items, "In Flight").appType).toBe("serverless"); // derived from the deploy plan
    expect(byTitle(items, "Raw Idea").appType).toBe("application"); // no signal → default
    expect(byTitle(items, "Board One").appType).toBe("application");
  });

  it("derives board progress, short repo names, and the live fleet counts", () => {
    const b = byTitle(sample(), "Board One");
    expect(b.itemsTotal).toBe(4);
    expect(b.open).toBe(2);
    expect(b.pct).toBeCloseTo(0.5);
    expect(b.repos).toEqual(["repo-a", "repo-b"]);
    expect(b.running).toBe(2);
    expect(b.paused).toBe(1);
  });
});

describe("resolveAppType / appTypeFromDeploy", () => {
  const cfg = (services: DeployService[]): DeployConfig => ({ services });
  it("maps a deploy service's workload / mode onto an app type", () => {
    expect(appTypeFromDeploy(cfg([svc({ mode: "cloud", workload: "static" })]))).toBe("static");
    expect(appTypeFromDeploy(cfg([svc({ mode: "cloud", workload: "service" })]))).toBe("api");
    expect(appTypeFromDeploy(cfg([svc({ mode: "local", localKind: "library" })]))).toBe("library");
    expect(appTypeFromDeploy(cfg([svc({ mode: "local", localKind: "application", buildTargets: "desktop installer" })]))).toBe("desktop");
    expect(appTypeFromDeploy(undefined)).toBeUndefined();
  });
  it("prefers the explicit classification over the deploy derivation and the default", () => {
    expect(resolveAppType({ appType: "mobile" }, cfg([svc({ mode: "cloud", workload: "static" })]))).toBe("mobile");
    expect(resolveAppType(undefined, cfg([svc({ mode: "cloud", workload: "serverless" })]))).toBe("serverless");
    expect(resolveAppType(undefined, undefined)).toBe("application");
  });
});

describe("statusCounts / typeCounts", () => {
  it("counts each status across the union (local-published counts as active)", () => {
    expect(statusCounts(sample())).toEqual({ active: 2, shipped: 1, "in-progress": 1, draft: 1 });
  });
  it("counts each application type", () => {
    const c = typeCounts(sample());
    expect(c.application).toBe(3);
    expect(c.api).toBe(1);
    expect(c.serverless).toBe(1);
    expect(c.desktop).toBe(0);
  });
});

describe("filterProjects", () => {
  it("filters by the Status facet (OR within the facet)", () => {
    const out = filterProjects(sample(), { query: "", statusSel: new Set(["draft"]), sort: "recency" });
    expect(out.map((i) => i.title)).toEqual(["Raw Idea"]);
  });

  it("filters by the Type facet, and AND-combines with Status", () => {
    const byType = filterProjects(sample(), { query: "", statusSel: new Set(), typeSel: new Set(["api"]), sort: "recency" });
    expect(byType.map((i) => i.title)).toEqual(["Acme CRM"]);

    const both = filterProjects(sample(), { query: "", statusSel: new Set(["active"]), typeSel: new Set(["application"]), sort: "recency" });
    expect(both.map((i) => i.title).sort()).toEqual(["Board One"]);
  });

  it("filters by the free-text query over title/description/key/repos", () => {
    const out = filterProjects(sample(), { query: "acme", statusSel: new Set(), sort: "recency" });
    expect(out.map((i) => i.title)).toEqual(["Acme CRM"]);

    const byRepo = filterProjects(sample(), { query: "repo-b", statusSel: new Set(), sort: "recency" });
    expect(byRepo.map((i) => i.title)).toContain("Board One");
  });

  it("sorts by name (A–Z) and by recency (updatedAt desc)", () => {
    const byName = filterProjects(sample(), { query: "", statusSel: new Set(), sort: "name" });
    expect(byName[0].title).toBe("Acme CRM");

    const byRecency = filterProjects(sample(), { query: "", statusSel: new Set(), sort: "recency" });
    expect(byRecency[0].source).toBe("board");
    expect(byRecency[byRecency.length - 1].title).toBe("Acme CRM"); // updatedAt 5 = oldest
  });
});

describe("facets", () => {
  it("exposes the four status facets and the application-type facets", () => {
    expect(STATUS_FACETS.map((f) => f.value)).toEqual(["active", "shipped", "in-progress", "draft"]);
    expect(TYPE_FACETS.map((f) => f.value)).toContain("serverless");
    expect(TYPE_FACETS.map((f) => f.value)).toContain("desktop");
  });
});
