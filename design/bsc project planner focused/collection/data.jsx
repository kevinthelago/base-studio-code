/* =====================================================================
   data.jsx — Data Collection blueprint · four acquisition panes.
   Project: "Build a directory of tech-conference talks" → Talks model.
   collectTargets · sourceLicensing · dataAcquire · dataExtract
   Functionless design data.
   ===================================================================== */

// ── mode chips (consistent across all four panes) ──
const MODE = {
  scrape: { label: "scrape", glyph: "🕸", h: 230 },   // crawl a website
  fetch:  { label: "fetch",  glyph: "⤓", h: 175 },    // pull api / file / dataset
};

// ── the bound target Data Model ──
const DM = {
  name: "Talks",
  entities: [
    { name: "Talk",    fields: ["title", "speaker", "session", "track", "abstract"] },
    { name: "Speaker", fields: ["name", "org", "bio"] },
    { name: "Session", fields: ["startsAt", "room", "day"] },
  ],
};

// ── sources (multi-source is the norm) ──
const SOURCES = [
  { id: "sessions", label: "Conf sessions", loc: "https://confsite.com/2024/sessions",
    type: "website", mode: "scrape", feeds: ["Talk", "Session"],
    scope: { start: "/2024/sessions", pattern: "/2024/sessions/*", bound: "2024 only · ~180 pages" } },
  { id: "speakers", label: "Speakers API", loc: "https://api.confsite.com/v1/speakers",
    type: "REST API", mode: "fetch", feeds: ["Speaker"],
    scope: { start: "?year=2024", pattern: "cursor paginated", bound: "~140 records" } },
];
// a third source used in blocked / multi states to exercise the gate
const SOURCE_RIVAL = { id: "rival", label: "Rival agenda", loc: "https://rival-conf.com/agenda",
  type: "website", mode: "scrape", feeds: ["Talk"], blocked: true,
  scope: { start: "/agenda", pattern: "/agenda/*", bound: "all years" } };

const source = (id) => [...SOURCES, SOURCE_RIVAL].find((s) => s.id === id) || { label: id };

// ── source legitimacy / clearance ──
const CLEARANCE = {
  sessions: {
    status: "cleared",
    robots: { delay: "1s", rules: [
      { path: "/2024/sessions", allow: true },
      { path: "/2024/sessions/*", allow: true },
      { path: "/admin", allow: false },
      { path: "/api/internal", allow: false },
    ] },
    terms: { kind: "ToS", text: "Non-commercial use permitted", attribution: "Attribution required", license: null },
  },
  speakers: {
    status: "cleared",
    robots: null,
    terms: { kind: "License", text: "Open data", attribution: "Credit confsite.com", license: "CC-BY" },
    api: { rate: "60 req/min", terms: "API ToS · non-redistribution" },
  },
  rival: {
    status: "blocked",
    robots: { delay: "—", rules: [
      { path: "/agenda", allow: false },
      { path: "/", allow: false },
    ] },
    terms: { kind: "ToS", text: "Scraping prohibited", attribution: null, license: "proprietary" },
    reason: "robots.txt disallows /agenda · ToS prohibits scraping",
  },
};
const INTENDED_USE = "Internal analytics & a public talk directory — non-redistributed source data, attributed.";

// ── acquire config ──
const ACQUIRE = {
  sessions: { mode: "scrape",
    crawl: { start: ["/2024/sessions"], depth: 2, include: "/2024/sessions/*", exclude: "/admin" },
    rate: { rps: "1 req/s", concurrency: 2, delay: "1000ms", robots: true },
    options: { pagination: "next-page link", jsRender: false },
    estimate: "~180 pages", captured: "180 pages · 41 MB HTML" },
  speakers: { mode: "fetch",
    endpoint: "GET /v1/speakers", auth: "Bearer · CONF_API_TOKEN",
    paging: { kind: "cursor", pageSize: 50 }, format: "JSON", schedule: "one-shot",
    estimate: "~140 records", captured: "142 records · 0.4 MB JSON" },
};
const LIVE_RUN = {
  sessions: { done: 96, total: 180, errors: 2, rate: "1.0 req/s", note: "crawling /2024/sessions · depth 2" },
  speakers: { done: 140, total: 140, errors: 0, rate: "done", note: "142 records via cursor" },
};

// ── extract rules ──
const EXTRACT = {
  sessions: { kind: "HTML", artifact: "session-card.html",
    rules: [
      { sel: ".session-card .title", field: "Talk.title", entity: "Talk", ok: true },
      { sel: ".session-card .speaker", field: "Talk.speaker", entity: "Talk", ref: "Speaker", ok: true },
      { sel: "time[datetime]", field: "Session.startsAt", entity: "Session", ok: true },
      { sel: ".session-card .room", field: "Session.room", entity: "Session", ok: true },
      { sel: ".session-card .track", field: "Talk.track", entity: "Talk", ok: false }, // gap in partial
    ] },
  speakers: { kind: "JSON", artifact: "speakers.json",
    rules: [
      { sel: "$.speakers[].name", field: "Speaker.name", entity: "Speaker", ok: true },
      { sel: "$.speakers[].org", field: "Speaker.org", entity: "Speaker", ok: true },
      { sel: "$.speakers[].bio", field: "Speaker.bio", entity: "Speaker", ok: true },
    ] },
};
// sample extracted Talk rows (the marquee preview)
const SAMPLE_ROWS = {
  cols: ["title", "speaker", "track", "startsAt"],
  rows: [
    { title: "Scaling Rust at the edge", speaker: "Dana Reyes", track: "Platform", startsAt: "2024-09-12 09:30" },
    { title: "Designing for agents", speaker: "Lou Park", track: "AI", startsAt: "2024-09-12 10:15" },
    { title: "The realtime web, redux", speaker: "Mara Quinn", track: "Frontend", startsAt: "2024-09-12 11:00" },
    { title: "Postgres at 10TB", speaker: "Ivan Cole", track: "Data", startsAt: "2024-09-12 13:30" },
    { title: "Zero-downtime deploys", speaker: "Priya Nair", track: "Platform", startsAt: "2024-09-12 14:15" },
  ],
};
const COVERAGE = { parsed: 172, total: 180, pct: 95.6, gaps: [{ field: "Talk.track", why: "selector matches 0 on 8 pages" }] };
const EXTRACT_GAPS = {
  unmappedModel: [{ field: "Talk.abstract", why: "no source element" }],
  unmappedSource: [{ sel: ".session-card .level", why: "not mapped to a field" }],
};

// ── stepper: full Data Collection blueprint (8 stages) ──
const STEPS = [
  { key: "context",   title: "Context" },
  { key: "targets",   title: "Targets" },
  { key: "model",     title: "Model" },
  { key: "license",   title: "License" },
  { key: "acquire",   title: "Acquire" },
  { key: "extract",   title: "Extract" },
  { key: "clean",     title: "Clean" },
  { key: "load",      title: "Load" },
];

// ── the four panes ──
const PANES = [
  { id: "targets", stepKey: "targets", n: 2, title: "Targets", stage: "collectTargets",
    blurb: "Declare the external sources to collect from and bind the Data Model they feed.",
    gateLabel: "sources + model bound" },
  { id: "license", stepKey: "license", n: 4, title: "Source legitimacy", stage: "sourceLicensing",
    blurb: "Clear every source for the intended use — ToS, robots.txt, and license — before any data is acquired.",
    gateLabel: "every source cleared" },
  { id: "acquire", stepKey: "acquire", n: 5, title: "Acquire", stage: "dataAcquire",
    blurb: "Scrape or fetch the raw artifacts from each cleared source, rate-limited and robots-aware.",
    gateLabel: "raw artifacts captured" },
  { id: "extract", stepKey: "extract", n: 6, title: "Extract", stage: "dataExtract",
    blurb: "Parse the raw artifacts into structured rows mapped to the Data Model.",
    gateLabel: "structured rows produced" },
];

// ── states ──
const STATES = [
  { id: "empty",   label: "Empty",        sub: "nothing declared" },
  { id: "partial", label: "Partial",      sub: "some pieces missing" },
  { id: "defined", label: "Defined",      sub: "gate met" },
  { id: "live",    label: "Live",         sub: "Acquire only · running", only: "acquire" },
  { id: "multi",   label: "Multi-source", sub: "2–4 sources" },
];

// resolve which sources are visible for a state
function sourcesFor(state) {
  if (state === "empty") return [];
  if (state === "multi") return [...SOURCES, SOURCE_RIVAL];
  return SOURCES;
}

Object.assign(window, {
  MODE, DM, SOURCES, SOURCE_RIVAL, source, CLEARANCE, INTENDED_USE,
  ACQUIRE, LIVE_RUN, EXTRACT, SAMPLE_ROWS, COVERAGE, EXTRACT_GAPS,
  STEPS, PANES, STATES, sourcesFor,
});
