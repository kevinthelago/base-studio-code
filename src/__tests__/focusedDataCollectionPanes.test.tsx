import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { FocusedTargetsBody } from "../screens/projects/FocusedTargetsBody";
import { FocusedLegitimacyBody } from "../screens/projects/FocusedLegitimacyBody";
import { FocusedAcquireBody } from "../screens/projects/FocusedAcquireBody";
import { FocusedExtractBody } from "../screens/projects/FocusedExtractBody";
import { FocusedModelBody } from "../screens/projects/FocusedModelBody";
import { FocusedMappingBody } from "../screens/projects/FocusedMappingBody";
import { FocusedCleaningBody } from "../screens/projects/FocusedCleaningBody";
import { FocusedLoadBody } from "../screens/projects/FocusedLoadBody";
import { parseStageJson, modeSummary, type CollectSource } from "../screens/projects/dataCollection";

// The collection panes self-fetch their planner-written JSON via `read_plan_sections`
// (a map of section stem → file content). Route that command per test.
function routeSections(map: Record<string, string>) {
  vi.mocked(invoke).mockImplementation(((cmd: string) =>
    cmd === "read_plan_sections" ? Promise.resolve(map) : Promise.resolve(null)
  ) as unknown as typeof invoke);
}

const TARGETS = JSON.stringify({
  sources: [
    { id: "sessions", mode: "scrape", label: "Conf sessions", loc: "https://c.com/s", type: "website", feeds: ["Talk"], scope: { start: "/s", pattern: "/s/*", bound: "~180" } },
    { id: "speakers", mode: "fetch", label: "Speakers API", loc: "https://api.c.com", type: "REST API", feeds: ["Speaker"], scope: { start: "?y=2024", pattern: "cursor", bound: "~140" } },
  ],
  dataModel: { name: "Talks", entities: [{ name: "Talk", fields: ["title", "speaker"] }, { name: "Speaker", fields: ["name"] }] },
});

const ACQUIRE = JSON.stringify({
  sources: [
    { id: "sessions", mode: "scrape", label: "Conf sessions", status: "running", captured: "180 pages",
      crawl: { start: ["/s"], depth: 2, include: "/s/*", exclude: "/admin" }, rate: { rps: "1 req/s", concurrency: 2, delay: "1000ms" }, options: { jsRender: false },
      run: { note: "crawling /s", done: 96, total: 180, errors: 2, rate: "1.0 req/s" } },
    { id: "speakers", mode: "fetch", label: "Speakers API", status: "not run", estimate: "~140 records",
      endpoint: "GET /v1/speakers", auth: "Bearer", paging: { kind: "cursor", pageSize: 50 }, format: "JSON", schedule: "one-shot" },
  ],
});

const EXTRACT = JSON.stringify({
  sources: [
    { id: "sessions", mode: "scrape", label: "Conf sessions", kind: "HTML", artifact: "session-card.html",
      rules: [
        { sel: ".title", field: "Talk.title", entity: "Talk", ok: true },
        { sel: ".track", field: "Talk.track", entity: "Talk", ok: false },
      ] },
  ],
  gaps: { unmappedModel: [{ field: "Talk.abstract", why: "no source element" }], unmappedSource: [] },
  sample: { cols: ["title", "track"], rows: [{ title: "Scaling Rust", track: "" }] },
  coverage: { parsed: 172, total: 180, pct: 95.6, gaps: [{ field: "Talk.track", why: "selector matches 0 on 8 pages" }] },
});

const DATAMODEL = JSON.stringify({
  id: "m1", name: "CRM Core", version: 1,
  entities: [
    { key: "Account", label: "Account", identity: ["domain"], fields: [
      { key: "name", type: "string", required: true },
      { key: "domain", type: "string", required: true, populated: 88, provenance: "Website (parsed)" },
      { key: "type", type: "enum", enum_values: ["Customer", "Partner"], populated: 97 },
      { key: "legacyCode", type: "string", populated: 2, drop: true },
    ] },
  ],
});

const MAPPING = JSON.stringify({
  mapped: [{ from: "Account.Name", to: "Account.name", auto: true }, { from: "Account.Website", to: "Account.domain", auto: true, note: "parsed" }],
  droppedSource: [{ field: "Account.Fax", why: "deprecated" }],
  unmappedModel: [{ field: "Account.arr", why: "net-new" }],
});

const CLEANING = JSON.stringify({
  qualityBar: 95, validationPct: 98,
  rules: [
    { field: "Account.domain", rule: "lowercase + strip www", kind: "standardize" },
    { field: "Opportunity.amount", rule: "currency → money", kind: "coerce" },
    { field: "Contact.email", rule: "RFC5322", kind: "validate" },
  ],
  quarantine: { count: 12, policy: "held for review" },
});

const LOAD = JSON.stringify({
  total: "49,427", entities: 4, lineage: 100, validation: 98.6, conflicts: 1, precedence: ["salesforce", "sql"],
  per: [
    { entity: "Account", rows: "12,431", valid: 99.1, src: ["salesforce", "sql"], merged: "11,902 matched", conflict: "name ×7 → SF wins" },
    { entity: "Contact", rows: "28,902", valid: 98.0, src: ["salesforce"] },
  ],
  artifacts: [{ name: "Canonical Data Model", detail: "CRM Core · 4 entities", glyph: "◆" }],
  issues: [{ t: "Generate read-only connector", tag: "connector" }],
});

const LICENSING = JSON.stringify({
  sources: [
    { id: "sessions", mode: "scrape", label: "Conf sessions", loc: "https://c.com/s" },
    { id: "rival", mode: "scrape", label: "Rival agenda", loc: "https://rival.com" },
  ],
  clearance: {
    sessions: { status: "cleared", robots: { delay: "1s", rules: [{ path: "/s", allow: true }, { path: "/admin", allow: false }] }, terms: { license: null, text: "Non-commercial OK", attribution: "Attribution required" } },
    rival: { status: "blocked", reason: "robots.txt disallows /agenda" },
  },
  intendedUse: "Internal analytics & a public directory.",
});

describe("dataCollection helpers", () => {
  it("parseStageJson tolerates absent / malformed input", () => {
    expect(parseStageJson("")).toBeNull();
    expect(parseStageJson("not json")).toBeNull();
    expect(parseStageJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });
  it("modeSummary counts scrape vs fetch", () => {
    const s: CollectSource[] = [{ id: "a", mode: "scrape", label: "A" }, { id: "b", mode: "fetch", label: "B" }];
    expect(modeSummary(s)).toBe("2 sources (1 scrape · 1 fetch)");
  });
});

describe("FocusedTargetsBody", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("shows the empty state when no targets are declared", async () => {
    routeSections({});
    render(<FocusedTargetsBody projectId="proj" />);
    await screen.findByText("No sources declared yet");
    expect(screen.getByText("Data Model bound")).toBeTruthy(); // readiness check present
  });

  it("renders declared sources + the bound Data Model", async () => {
    routeSections({ collectTargets: TARGETS });
    render(<FocusedTargetsBody projectId="proj" />);
    // The label appears in both the sources card and the scope-per-source card.
    expect((await screen.findAllByText("Conf sessions")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Speakers API").length).toBeGreaterThan(0);
    expect(screen.getByText("✓ bound")).toBeTruthy();
    expect(screen.getAllByText("Talk").length).toBeGreaterThan(0);
  });
});

describe("FocusedLegitimacyBody", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("shows the empty state when no sources need clearance", async () => {
    routeSections({});
    render(<FocusedLegitimacyBody projectId="proj" />);
    await screen.findByText("No sources to clear yet");
  });

  it("renders clearances and a hard-stop banner for a blocked source", async () => {
    routeSections({ sourceLicensing: LICENSING });
    render(<FocusedLegitimacyBody projectId="proj" />);
    await screen.findByTestId("legitimacy-hard-block");
    expect(screen.getByText("Acquisition blocked")).toBeTruthy();
    expect(screen.getAllByText("blocked").length).toBeGreaterThan(0);
    expect(screen.getByText("Internal analytics & a public directory.")).toBeTruthy();
  });
});

describe("FocusedAcquireBody", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("shows the empty state when nothing is configured", async () => {
    routeSections({});
    render(<FocusedAcquireBody projectId="proj" />);
    await screen.findByText("Nothing to acquire yet");
  });

  it("renders scrape/fetch config + a live progress bar for a running crawl", async () => {
    routeSections({ dataAcquire: ACQUIRE });
    render(<FocusedAcquireBody projectId="proj" />);
    await screen.findByText("scrape · Conf sessions");
    expect(screen.getByText("fetch · Speakers API")).toBeTruthy();
    expect(screen.getByText("crawling /s")).toBeTruthy();      // live run note
    expect(screen.getByText("96 / ~180 pages")).toBeTruthy();
  });
});

describe("FocusedExtractBody", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("shows the empty state when no rules exist", async () => {
    routeSections({});
    render(<FocusedExtractBody projectId="proj" />);
    await screen.findByText("No extraction rules yet");
  });

  it("renders rules, a no-match gap, sample preview, and coverage", async () => {
    routeSections({ dataExtract: EXTRACT });
    render(<FocusedExtractBody projectId="proj" />);
    await screen.findByText("html rules · Conf sessions");
    expect(screen.getByText("no match")).toBeTruthy();          // r.ok === false
    expect(screen.getAllByText("95.6%").length).toBeGreaterThan(0); // coverage bar + readiness detail
    expect(screen.getByText(/1 rows produced/)).toBeTruthy();
  });
});

describe("FocusedModelBody", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("shows the empty state with no model", async () => {
    routeSections({});
    render(<FocusedModelBody projectId="proj" />);
    await screen.findByText("No Data Model yet");
  });

  it("renders entities, fields, identity, enum + drop hint", async () => {
    routeSections({ datamodel: DATAMODEL });
    render(<FocusedModelBody projectId="proj" />);
    await screen.findByText(/CRM Core/);
    expect(screen.getByText("identity: [domain]")).toBeTruthy();
    expect(screen.getByText("drop?")).toBeTruthy();        // legacyCode 2% populated
    expect(screen.getByText("88%")).toBeTruthy();          // populated bar label
  });
});

describe("FocusedMappingBody", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("shows the empty state with no mapping", async () => {
    routeSections({});
    render(<FocusedMappingBody projectId="proj" />);
    await screen.findByText("No mapping yet");
  });

  it("renders mapped / dropped / unmapped sections", async () => {
    routeSections({ dataMap: MAPPING });
    render(<FocusedMappingBody projectId="proj" />);
    await screen.findByText("Account.Name");
    expect(screen.getByText("dropped from source")).toBeTruthy();
    expect(screen.getByText("Account.arr")).toBeTruthy();   // net-new model field
  });
});

describe("FocusedCleaningBody", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("shows the empty state with no rules", async () => {
    routeSections({});
    render(<FocusedCleaningBody projectId="proj" />);
    await screen.findByText("No cleaning rules yet");
  });

  it("renders the quality bar + rules grouped by kind", async () => {
    routeSections({ dataClean: CLEANING });
    render(<FocusedCleaningBody projectId="proj" />);
    await screen.findByText("standardize formats");
    expect(screen.getByText("coerce types")).toBeTruthy();
    expect(screen.getByText("validate")).toBeTruthy();
    expect(screen.getByText("98% pass")).toBeTruthy();
  });
});

describe("FocusedLoadBody", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("shows the empty state with no load plan", async () => {
    routeSections({});
    render(<FocusedLoadBody projectId="proj" />);
    await screen.findByText("No load plan yet");
  });

  it("renders headline stats, per-entity merge, artifacts + issues", async () => {
    routeSections({ dataLoad: LOAD });
    render(<FocusedLoadBody projectId="proj" />);
    await screen.findByText("49,427");
    expect(screen.getByText(/11,902 matched/)).toBeTruthy();   // merge summary
    expect(screen.getByText(/name ×7 → SF wins/)).toBeTruthy(); // conflict resolution
    expect(screen.getByText("Generate read-only connector")).toBeTruthy(); // load issue
  });
});
