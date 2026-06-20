/* =====================================================================
   data.jsx — Migration / Source pane.
   The planner connects READ-ONLY to an existing system (Salesforce),
   inventories it, and INFERS a canonical Data Model from the real
   records + custom fields. "The existing data dictates the structure."
   Functionless design data — realistic Salesforce migration.
   ===================================================================== */

// ── field types (each a distinct mono chip) ──
const FT = {
  string: { label: "string", h: null,  glyph: "" },
  number: { label: "number", h: 230,   glyph: "#" },
  money:  { label: "money",  h: 145,   glyph: "$" },
  date:   { label: "date",   h: 195,   glyph: "◷" },
  bool:   { label: "bool",   h: null,  glyph: "·" },
  enum:   { label: "enum",   h: 300,   glyph: "≡" },   // violet — carries values
  ref:    { label: "ref",    h: 230,   glyph: "→" },   // info — points to an entity
};

// ── source catalog (read-only connectors) ──
const SOURCES = [
  { id: "salesforce", name: "Salesforce",        kind: "CRM",       glyph: "☁", h: 230 },
  { id: "hubspot",    name: "HubSpot",           kind: "CRM",       glyph: "◉", h: 25 },
  { id: "dynamics",   name: "Dynamics 365",      kind: "CRM",       glyph: "◭", h: 250 },
  { id: "sql",        name: "SQL database",      kind: "Postgres / MySQL", glyph: "⛁", h: 195 },
  { id: "odata",      name: "OData / OpenAPI",   kind: "SAP · REST", glyph: "❯", h: 70 },
  { id: "csv",        name: "CSV / export",      kind: "File upload", glyph: "⤓", h: 145 },
];
const source = (id) => SOURCES.find((s) => s.id === id) || { name: id, glyph: "■", h: 250, kind: "" };

// ── inventory: what was found in Salesforce ──
const INVENTORY = [
  { obj: "Account", custom: false, fields: 41, records: "12,431",
    sample: [
      { Name: "Northwind Traders", Type: "Customer", Website: "northwind.com", Industry: "Retail" },
      { Name: "Acme Corp", Type: "Customer", Website: "acme.com", Industry: "Manufacturing" },
      { Name: "Globex", Type: "Prospect", Website: "globex.io", Industry: "Technology" },
    ],
    cols: ["Name", "Type", "Website", "Industry"] },
  { obj: "Contact", custom: false, fields: 38, records: "28,902",
    sample: [
      { FirstName: "Dana", LastName: "Reyes", Email: "dana@northwind.com", Title: "VP Ops" },
      { FirstName: "Lou", LastName: "Park", Email: "lou@acme.com", Title: "Buyer" },
    ],
    cols: ["FirstName", "LastName", "Email", "Title"] },
  { obj: "Opportunity", custom: false, fields: 33, records: "6,210",
    sample: [
      { Name: "Northwind — Q3 Renewal", StageName: "Proposal", Amount: "48,000", CloseDate: "2026-08-14" },
      { Name: "Acme — Expansion", StageName: "Closed Won", Amount: "120,000", CloseDate: "2026-05-02" },
    ],
    cols: ["Name", "StageName", "Amount", "CloseDate"] },
  { obj: "Project__c", custom: true, fields: 17, records: "1,884",
    sample: [
      { Name: "NW Migration", Health__c: "Green", Contract_Value__c: "85,000", Legacy_Code__c: "—" },
      { Name: "Acme Rollout", Health__c: "Yellow", Contract_Value__c: "210,000", Legacy_Code__c: "LX-44" },
    ],
    cols: ["Name", "Health__c", "Contract_Value__c", "Legacy_Code__c"] },
];

// ── inferred model "CRM Core" ──
// each field: name, type, opt fields: values(enum), ref(entity), identity, req, pop(%),
//   src (provenance label), why (signal), drop (low-value candidate)
const MODEL = {
  name: "CRM Core",
  entities: [
    { name: "Account", identity: "domain", records: "12,431", fields: [
      { name: "name", type: "string", req: true, pop: 100, src: "Account.Name", why: "100% populated" },
      { name: "domain", type: "string", identity: true, req: true, pop: 88, src: "Website (parsed)", why: "best merge key · 88%" },
      { name: "type", type: "enum", values: ["Customer", "Partner", "Prospect"], req: true, pop: 97, src: "Account.Type", why: "picklist → enum" },
      { name: "industry", type: "enum", values: ["Retail", "Manufacturing", "Technology", "Finance", "+6"], pop: 79, src: "Account.Industry", why: "picklist → enum" },
      { name: "employees", type: "number", pop: 64, src: "NumberOfEmployees", why: "64% populated → optional" },
    ] },
    { name: "Contact", identity: "email", records: "28,902", fields: [
      { name: "email", type: "string", identity: true, req: true, pop: 96, src: "Contact.Email", why: "unique 96% → identity" },
      { name: "firstName", type: "string", pop: 99, src: "Contact.FirstName", why: "99% populated" },
      { name: "lastName", type: "string", req: true, pop: 100, src: "Contact.LastName", why: "100% populated" },
      { name: "account", type: "ref", ref: "Account", req: true, pop: 94, src: "AccountId", why: "lookup → Account" },
      { name: "title", type: "string", pop: 71, src: "Contact.Title", why: "71% populated → optional" },
    ] },
    { name: "Opportunity", identity: null, records: "6,210", fields: [
      { name: "name", type: "string", req: true, pop: 100, src: "Opportunity.Name", why: "100% populated" },
      { name: "stage", type: "enum", values: ["Prospecting", "Qualification", "Proposal", "Closed Won", "Closed Lost"], req: true, pop: 100, src: "StageName", why: "picklist → enum" },
      { name: "amount", type: "money", pop: 91, src: "Amount", why: "currency → money" },
      { name: "closeDate", type: "date", req: true, pop: 100, src: "CloseDate", why: "date field" },
      { name: "account", type: "ref", ref: "Account", req: true, pop: 100, src: "AccountId", why: "master-detail → Account" },
    ] },
    { name: "Project", identity: null, records: "1,884", custom: true, fields: [
      { name: "name", type: "string", req: true, pop: 100, src: "Project__c.Name", why: "100% populated" },
      { name: "health", type: "enum", values: ["Green", "Yellow", "Red"], pop: 88, src: "Health__c", why: "picklist → enum" },
      { name: "account", type: "ref", ref: "Account", req: true, pop: 92, src: "Account__c", why: "lookup → Account" },
      { name: "contractValue", type: "money", pop: 76, src: "Contract_Value__c", why: "currency → money" },
      { name: "legacyCode", type: "string", pop: 2, src: "Legacy_Code__c", why: "2% populated", drop: true },
    ] },
  ],
};

// ── field mapping (source → model), incl. gaps ──
const MAPPING = {
  mapped: [
    { from: "Account.Name", to: "Account.name", auto: true },
    { from: "Account.Website", to: "Account.domain", auto: true, note: "parsed" },
    { from: "Account.Type", to: "Account.type", auto: true },
    { from: "Contact.Email", to: "Contact.email", auto: true },
    { from: "Project__c.Account__c", to: "Project.account", auto: true, note: "lookup" },
    { from: "Project__c.Contract_Value__c", to: "Project.contractValue", auto: true },
  ],
  droppedSource: [
    { field: "Project__c.Legacy_Code__c", why: "2% populated" },
    { field: "Account.Fax", why: "deprecated" },
    { field: "Contact.MailingStreet", why: "out of scope" },
  ],
  unmappedModel: [
    { field: "Account.arr", why: "net-new · derive from Opportunity" },
    { field: "Contact.consent", why: "net-new · collect at signup" },
  ],
};

// ── load preview (what runs at build) ──
const LOAD = {
  total: "49,427", entities: 4, lineage: 100, validation: 98.6, conflicts: 1,
  per: [
    { entity: "Account", rows: "12,431", nulls: 0.4, valid: 99.1, src: ["salesforce"] },
    { entity: "Contact", rows: "28,902", nulls: 1.2, valid: 98.0, src: ["salesforce"] },
    { entity: "Opportunity", rows: "6,210", nulls: 0.9, valid: 99.4, src: ["salesforce"] },
    { entity: "Project", rows: "1,884", nulls: 3.1, valid: 97.2, src: ["salesforce"] },
  ],
};

// ── multi-source variant: Salesforce + SQL billing export ──
const LOAD_MULTI = {
  total: "53,108", entities: 4, lineage: 100, validation: 98.2, conflicts: 7,
  precedence: ["salesforce", "sql"],
  per: [
    { entity: "Account", rows: "12,431", nulls: 0.3, valid: 99.0, src: ["salesforce", "sql"], merged: "11,902 matched · 529 SQL-only", conflict: "name ×7 → SF wins" },
    { entity: "Contact", rows: "28,902", nulls: 1.2, valid: 98.0, src: ["salesforce"] },
    { entity: "Opportunity", rows: "6,210", nulls: 0.9, valid: 99.4, src: ["salesforce"] },
    { entity: "Invoice", rows: "5,565", nulls: 0.0, valid: 99.8, src: ["sql"], note: "net-new entity from SQL" },
  ],
};

// ── downstream artifacts generated at publish ──
const ARTIFACTS = [
  { name: "Canonical Data Model", kind: "artifact", detail: "CRM Core · 4 entities · 37 fields", glyph: "◆" },
  { name: "Migration stream", kind: "stream", detail: "read-only backfill · runs at build", glyph: "⟿" },
  { name: "Load issues", kind: "issues", detail: "3 issues → published to board", glyph: "☑" },
];
const LOAD_ISSUES = [
  { t: "Generate read-only Salesforce connector (MCP)", tag: "connector" },
  { t: "Backfill Account / Contact / Opportunity with lineage", tag: "backfill" },
  { t: "Quality gate: ≥98% validation pass before load", tag: "gate" },
];

// ── the gate checks (downstream-impact drives the gate) ──
function gateChecks(state) {
  const refined = state === "refined" || state === "multi";
  const inferred = state !== "empty" && state !== "connecting" && state !== "skipped";
  return [
    { id: "reachable", label: "Source reachable", ok: inferred || state === "connecting", detail: "read-only" },
    { id: "inferred",  label: "Model inferred",   ok: inferred, detail: inferred ? "CRM Core" : "—" },
    { id: "refined",   label: "Schema refined / confirmed", ok: refined, detail: refined ? "confirmed" : "review needed" },
    { id: "mapping",   label: "Field mapping resolved", ok: refined, detail: refined ? "0 gaps" : "2 gaps" },
  ];
}

// ── stepper context — Source sits BEFORE features/structure ──
const STEPS = [
  { key: "context", title: "Context" },
  { key: "repos", title: "Repos" },
  { key: "source", title: "Source" },     // ← this pane
  { key: "deploy", title: "Deploy" },
  { key: "features", title: "Features" },
  { key: "structure", title: "Structure" },
];

// ── the six states ──
const STATES = [
  { id: "empty",      label: "Empty",        sub: "no source connected" },
  { id: "connecting", label: "Connecting",   sub: "sampling + inferring (live)" },
  { id: "inferred",   label: "Inferred",     sub: "awaiting review" },
  { id: "refined",    label: "Refined",      sub: "gate met" },
  { id: "multi",      label: "Multi-source", sub: "Salesforce + SQL" },
  { id: "skipped",    label: "Skipped",      sub: "greenfield, optional" },
];

Object.assign(window, {
  FT, SOURCES, source, INVENTORY, MODEL, MAPPING, LOAD, LOAD_MULTI,
  ARTIFACTS, LOAD_ISSUES, gateChecks, STEPS, STATES,
});
