// Typed data for the Skills library.
//
// A "skill" is a reusable capability bundle — a named procedure (prompt +
// bundled tools + guardrails) any worker running an allowed permission-profile
// can invoke. The packaged set ships compliance & standards procedures (SOC 2,
// GDPR, accessibility, i18n, …) — the cross-cutting obligations almost every
// product carries. Shaped to mirror the MCP catalog data model (see
// data/mcpCatalog.ts) so swapping in live data later is a drop-in. Stats are
// fleet-wide, last 7d.

/** Capability kind — drives the card glyph + accent color. */
export type SkillKind = "workflow" | "scaffold" | "codemod" | "review" | "docs";

/** Where a skill came from — drives its source tag style. */
export type SkillSource = "first-party" | "team" | "imported" | "community";

/** Permission profile a skill is allowed to run under (mirrors agentProfiles). */
export type SkillProfile = "build" | "review" | "docs" | "auto" | "sandbox";

export interface Skill {
  id: string;
  name: string;
  kind: SkillKind;
  source: SkillSource;
  desc: string;
  /** The full authored procedure (the SKILL.md body). When absent, the seeded
   *  SkillDef falls back to `desc`. Packaged skills carry a real procedure here. */
  body?: string;
  /** Tool names bundled with the skill, rendered as kbd chips. */
  tools: string[];
  /** Permission profiles allowed to invoke it. */
  profiles: SkillProfile[];
  /** Fleet-wide invocations over the last 7 days. */
  invocations: number;
  /** Success rate (0–100), weighted into the KPIs. */
  success: number;
  /** Average tokens per invocation, in thousands. */
  avgTokensK: number;
  lastUsed: string;
  /** 7-point trend used for the inline sparkline. */
  trend: number[];
  /** Pinned skills are auto-available to the fleet. */
  pinned?: boolean;
}

export interface SkillCatalogItem {
  name: string;
  by: string;
  glyph: string;
  desc: string;
}

export interface KindMeta {
  label: string;
  glyph: string;
  /** CSS color (token var or oklch literal). */
  color: string;
}

export interface SourceTag {
  label: string;
  /** Tag CSS modifier class ("amber" | "info" | ""). */
  cls: string;
}

// Shared color literals (match the design palette).
const A = "var(--accent)";
const I = "var(--info)";
const G = "var(--success)";
const V = "oklch(0.7 0.12 290)";
const DOCSC = "oklch(0.7 0.06 90)";

/** kind → glyph + color (matches the catalog-icon style on the MCP screen). */
export const KIND: Record<SkillKind, KindMeta> = {
  workflow: { label: "workflow", glyph: "⌁", color: A },
  scaffold: { label: "scaffold", glyph: "▤", color: I },
  codemod:  { label: "codemod",  glyph: "↻", color: V },
  review:   { label: "review",   glyph: "◇", color: G },
  docs:     { label: "docs",     glyph: "¶", color: DOCSC },
};

/** profile keys mirror agentProfiles / fleet PROFILE. */
export const PROFILE_COLOR: Record<SkillProfile, string> = {
  build:   "oklch(0.78 0.14 70)",
  review:  "oklch(0.72 0.10 230)",
  docs:    "oklch(0.7 0.06 90)",
  auto:    "oklch(0.74 0.13 145)",
  sandbox: "oklch(0.68 0.18 25)",
};

export const SOURCE_TAG: Record<SkillSource, SourceTag> = {
  "first-party": { label: "first-party", cls: "amber" },
  team:          { label: "team",        cls: "info" },
  imported:      { label: "imported",    cls: "" },
  community:     { label: "community",    cls: "" },
};

// The packaged skills are compliance & standards procedures — the cross-cutting
// obligations (security attestation, data protection, accessibility, localization)
// that apply to nearly every product, so they ship enabled + global. Each carries
// a real authored `body` (the SKILL.md procedure) the fleet runs verbatim.
export const SKILLS: Skill[] = [
  {
    id: "soc2-readiness", name: "SOC 2 readiness review", kind: "review", source: "first-party",
    desc: "Audits code + config against the SOC 2 Trust Services Criteria (security, availability, confidentiality) and reports each gap with a remediation.",
    body: [
      "Read-only audit of the codebase and infrastructure config against the SOC 2 Trust Services Criteria. Do not change code — produce a findings report.",
      "1. Inventory the controls in scope: access control (authn/authz, RBAC, MFA), change management (PR review, CI gates, branch protection), encryption (at rest + in transit), logging & monitoring, backup/DR, and incident response.",
      "2. For each criterion, locate the implementing code/config (or its absence). Cite file:line.",
      "3. Map each finding to the criterion (CC6 logical access, CC7 monitoring, CC8 change mgmt, A1 availability, C1 confidentiality).",
      "4. Rate severity (blocker / gap / observation) and give a concrete remediation per finding.",
      "5. Output a table: criterion · status (met/partial/missing) · evidence · remediation. Flag any secret material committed to the repo as a blocker.",
    ].join("\n"),
    tools: ["git_diff", "rank_files", "repo_map", "get_pr"],
    profiles: ["review"], invocations: 47, success: 95, avgTokensK: 22, lastUsed: "8m ago",
    trend: [4, 6, 5, 8, 7, 9, 11], pinned: true,
  },
  {
    id: "gdpr-review", name: "GDPR data-protection review", kind: "review", source: "first-party",
    desc: "Maps personal-data flows and checks lawful basis, consent, data-subject rights (access/erasure/portability), and retention — flagging each violation.",
    body: [
      "Read-only data-protection review against the GDPR. Produce a findings report; do not modify code.",
      "1. Map the personal-data flows: what PII is collected, where it is stored, who it is shared with (third parties, sub-processors), and cross-border transfers.",
      "2. For each flow confirm a lawful basis (Art. 6) and, for special-category data, an Art. 9 condition.",
      "3. Verify the data-subject rights are technically supported: access/export (Art. 15/20), erasure (Art. 17), rectification, and objection — find the endpoint/handler or flag it missing.",
      "4. Check consent capture (granular, opt-in, withdrawable) and retention limits (data deleted/anonymized after its purpose ends).",
      "5. Check data-minimization and that PII isn't logged in plaintext.",
      "6. Output: data-flow inventory + a violations table (article · issue · file:line · fix).",
    ].join("\n"),
    tools: ["git_diff", "rank_files", "repo_map"],
    profiles: ["review"], invocations: 39, success: 93, avgTokensK: 24, lastUsed: "20m ago",
    trend: [3, 5, 4, 7, 6, 8, 9], pinned: true,
  },
  {
    id: "wcag-audit", name: "WCAG 2.2 AA accessibility audit", kind: "review", source: "first-party",
    desc: "Checks the UI against WCAG 2.2 AA — semantics, ARIA, contrast, keyboard nav, focus order — listing each failure against its success criterion.",
    body: [
      "Read-only accessibility audit of the UI against WCAG 2.2 level AA. Report failures; do not edit components.",
      "1. Perceivable: text alternatives for non-text content (1.1.1), color not the sole signal (1.4.1), contrast ≥ 4.5:1 / 3:1 large (1.4.3), and resizable/reflowing text (1.4.4/1.4.10).",
      "2. Operable: full keyboard access with no traps (2.1.1/2.1.2), visible focus (2.4.7), logical focus order (2.4.3), and target size ≥ 24px (2.5.8).",
      "3. Understandable: labelled inputs (3.3.2), error identification (3.3.1), consistent navigation (3.2.3).",
      "4. Robust: valid name/role/value via semantic HTML or correct ARIA (4.1.2), status messages announced (4.1.3).",
      "5. For each failure cite the component file:line and the exact success criterion, and give the minimal fix.",
    ].join("\n"),
    tools: ["git_diff", "rank_files", "repo_map"],
    profiles: ["review"], invocations: 31, success: 90, avgTokensK: 19, lastUsed: "1h ago",
    trend: [2, 4, 3, 5, 6, 5, 8],
  },
  {
    id: "hipaa-safeguards", name: "HIPAA safeguards review", kind: "review", source: "first-party",
    desc: "Reviews PHI handling against the HIPAA Security Rule — encryption, access controls, audit logging, and minimum-necessary — citing each gap.",
    body: [
      "Read-only review of PHI handling against the HIPAA Security Rule technical safeguards. Report findings only.",
      "1. Access control (§164.312(a)): unique user identification, RBAC scoped to minimum-necessary, automatic logoff.",
      "2. Audit controls (§164.312(b)): tamper-evident logging of PHI access — who accessed which record, when.",
      "3. Integrity (§164.312(c)): protections against improper PHI alteration/destruction.",
      "4. Transmission security (§164.312(e)) + encryption at rest: TLS in transit, encrypted storage; flag any PHI in logs, URLs, or analytics.",
      "5. Confirm a path for Business Associate Agreements with any third party that touches PHI.",
      "6. Output a safeguards table (§ · control · status · evidence file:line · remediation).",
    ].join("\n"),
    tools: ["git_diff", "rank_files", "repo_map"],
    profiles: ["review"], invocations: 14, success: 88, avgTokensK: 23, lastUsed: "3h ago",
    trend: [1, 2, 2, 3, 4, 3, 5],
  },
  {
    id: "pci-dss-review", name: "PCI-DSS cardholder-data review", kind: "review", source: "first-party",
    desc: "Verifies cardholder-data handling against PCI-DSS — no PAN/CVV storage, tokenization, scoped network, TLS — and flags scope creep.",
    body: [
      "Read-only review of cardholder-data handling against PCI-DSS v4.0. Report findings only.",
      "1. Storage (Req. 3): confirm the PAN is never stored in the clear and the CVV/CVC/track data is NEVER stored post-authorization. Prefer tokenization / a hosted payment field so card data never touches the server.",
      "2. Transmission (Req. 4): strong TLS for any cardholder data in transit; no card data in URLs or logs.",
      "3. Access (Req. 7/8): need-to-know access, unique IDs, MFA for the cardholder-data environment.",
      "4. Scope: identify every component that touches card data and flag scope creep (analytics, logs, error trackers receiving PAN).",
      "5. Output: a requirement-by-requirement table (req · status · evidence file:line · remediation), blockers first.",
    ].join("\n"),
    tools: ["git_diff", "rank_files", "repo_map"],
    profiles: ["review"], invocations: 11, success: 91, avgTokensK: 20, lastUsed: "5h ago",
    trend: [1, 1, 2, 2, 3, 2, 4],
  },
  {
    id: "i18n-extract", name: "Internationalize the UI (i18n)", kind: "codemod", source: "first-party",
    desc: "Extracts hardcoded strings into a message catalog, wires the i18n framework, and handles locale, pluralization, RTL, and date/number formatting.",
    body: [
      "Internationalize the UI. Make code changes on a branch and verify with a typecheck.",
      "1. Pick/confirm the framework already in use (e.g. i18next, react-intl, FormatJS); if none, propose one and wire the provider at the app root.",
      "2. Sweep components for user-visible hardcoded strings (JSX text, placeholders, aria-labels, titles, alt). Skip logs and developer-only text.",
      "3. Replace each with a translation call keyed by a stable id; collect the defaults into the source-locale catalog (e.g. `en.json`).",
      "4. Handle plurals and interpolation (ICU MessageFormat) — never concatenate translated fragments.",
      "5. Locale-aware dates/numbers/currency via Intl; set `dir`/logical CSS properties so RTL locales mirror correctly.",
      "6. Add a missing-key check and verify the build/typecheck is green. Report the extracted-key count and any strings that need human translation.",
    ].join("\n"),
    tools: ["edit", "write_file", "repo_map", "rank_files"],
    profiles: ["build"], invocations: 26, success: 86, avgTokensK: 30, lastUsed: "47m ago",
    trend: [2, 3, 5, 4, 6, 7, 9],
  },
  {
    id: "compliance-docs", name: "Compliance docs pack", kind: "docs", source: "first-party",
    desc: "Generates the compliance document set — privacy policy, DPA, and a Record of Processing Activities — from the codebase's actual data flows.",
    body: [
      "Generate the compliance document set from the codebase's real data flows. Write Markdown to /docs and open a docs-only PR.",
      "1. Derive the data inventory: every category of personal data the app collects, its purpose, lawful basis, storage location, and retention period — cite the code that handles each.",
      "2. Privacy policy: what is collected, why, who it is shared with (sub-processors), user rights, and contact — in plain language.",
      "3. Data Processing Agreement (DPA) skeleton: processing scope, sub-processor list, security measures, breach-notification terms.",
      "4. Record of Processing Activities (RoPA, GDPR Art. 30): a table of processing activities, categories, recipients, transfers, and retention.",
      "5. Cross-link the docs and flag any data flow with no documented purpose or basis. These are drafts for legal review — say so explicitly.",
    ].join("\n"),
    tools: ["write_file", "repo_map", "kb_write"],
    profiles: ["docs"], invocations: 18, success: 94, avgTokensK: 17, lastUsed: "2h ago",
    trend: [1, 2, 3, 3, 4, 5, 6],
  },
  {
    id: "audit-consent-scaffold", name: "Scaffold audit logging + consent gate", kind: "scaffold", source: "first-party",
    desc: "Scaffolds tamper-evident audit logging and a consent/preferences gate — the cross-cutting plumbing SOC 2, HIPAA, and GDPR all require.",
    body: [
      "Scaffold the cross-cutting compliance plumbing. Make code changes on a branch and stub tests.",
      "1. Audit log: an append-only, tamper-evident record (actor, action, resource, timestamp, request id) for every access/mutation of sensitive data. Add a single choke-point helper and wire it into the data-access layer; never log the sensitive payload itself.",
      "2. Consent gate: a consent/preferences store (purpose-scoped, opt-in, withdrawable, versioned) plus a guard the UI and API call before any non-essential processing.",
      "3. Data-subject hooks: stub export and erasure entry points that enumerate a user's data across stores.",
      "4. Add tests for the audit-write path and the consent guard's allow/deny. Document the new surfaces in /docs.",
    ].join("\n"),
    tools: ["write_file", "edit", "repo_map", "run_tests"],
    profiles: ["build", "auto"], invocations: 9, success: 89, avgTokensK: 27, lastUsed: "6h ago",
    trend: [1, 1, 2, 2, 3, 4, 4],
  },
  {
    id: "web-seo", name: "Web SEO", kind: "workflow", source: "first-party",
    desc: "Make a generated web app SEO-ready: metadata + Open Graph/Twitter, robots.txt + sitemap.xml, JSON-LD structured data, semantic HTML, and Core Web Vitals — applied only when there's a public web surface.",
    body: [
      "Make the web app discoverable and shareable. APPLIES ONLY to a public, crawlable web surface — if this project is a CLI, desktop app, library, internal tool, or API-only service, SKIP this skill entirely (it doesn't apply).",
      "1. Metadata: a unique, descriptive <title> + meta description per page (or route); a canonical URL; Open Graph (og:title/description/image/url/type) + Twitter Card tags; favicon + app icons. Use the framework's head/metadata API (e.g. Next metadata, react-helmet, SvelteKit <svelte:head>) rather than hand-managed tags.",
      "2. Crawlability: ship robots.txt (allow + sitemap reference) and a generated sitemap.xml; use clean, semantic routes and correct HTTP status codes (404/301). For content that must be indexable, prefer SSR / SSG / prerender over client-only rendering so crawlers see real HTML — within what the chosen stack supports.",
      "3. Structured data: add JSON-LD where it fits the domain (Organization/WebSite site-wide; Article, Product, BreadcrumbList, FAQ on the relevant pages). Validate against schema.org types.",
      "4. Semantic HTML + accessibility (overlaps the a11y bar): one <h1> per page + ordered headings, landmark elements (header/nav/main/footer), descriptive alt text, and a correct <html lang>. Good semantics is good SEO.",
      "5. Performance / Core Web Vitals: optimize images (right format/size, width+height to avoid CLS, lazy-load below the fold), preconnect to critical origins, and keep LCP/CLS/INP within budget. Avoid render-blocking work on the critical path.",
      "6. Internationalization (only if multi-locale): hreflang alternates + localized titles/descriptions.",
      "7. Verify: confirm the baseline (title/description, canonical, OG/Twitter, robots.txt, sitemap.xml, JSON-LD, one h1) is present, and sanity-check with a Lighthouse SEO pass if available.",
      "Ground specifics (current tag conventions, framework metadata APIs, schema.org types) in the Research MCP rather than guessing.",
    ].join("\n"),
    tools: ["read_file", "edit", "write_file", "repo_map"],
    profiles: ["build"], invocations: 0, success: 0, avgTokensK: 0, lastUsed: "—",
    trend: [0, 0, 0, 0, 0, 0, 0], pinned: true,
  },
];

// Additional standards a team can add to the library on demand.
export const SKILL_CATALOG: SkillCatalogItem[] = [
  { name: "ISO 27001 control mapping", by: "first-party", glyph: "◇", desc: "Map controls to ISO 27001 Annex A and flag the unaddressed ones." },
  { name: "CCPA / CPRA consumer-rights review", by: "first-party", glyph: "◇", desc: "Check know/delete/correct/opt-out rights and sale-share disclosures." },
  { name: "OWASP ASVS verification", by: "community", glyph: "◇", desc: "Verify the app against OWASP ASVS L1/L2 security requirements." },
  { name: "Cookie consent & ePrivacy", by: "team", glyph: "◇", desc: "Audit cookie/tracker consent against ePrivacy and the TCF." },
  { name: "Data retention & erasure policy", by: "first-party", glyph: "¶", desc: "Draft retention schedules and automated-erasure rules per data class." },
];

/** A packaged {@link Skill} → a catalog row, so the packaged set and the add-on
 *  extras present as ONE pool in the Skills screen's "add a skill" surfaces. */
function skillToCatalogItem(s: Skill): SkillCatalogItem {
  return { name: s.name, by: s.source, glyph: KIND[s.kind].glyph, desc: s.desc };
}

/**
 * The single catalog the Skills screen offers under "add a skill": every packaged
 * skill plus the add-on standards, deduped by name. The library is seeded from the
 * same packaged set ({@link SKILLS}), so the catalog and the main list draw from one
 * source — the screen then hides whatever is already in the user's library.
 */
export function skillCatalog(): SkillCatalogItem[] {
  const items = SKILLS.map(skillToCatalogItem);
  const seen = new Set(items.map((i) => i.name));
  for (const c of SKILL_CATALOG) if (!seen.has(c.name)) items.push(c);
  return items;
}

/** Compact number formatter (e.g. 1234 → "1.2k") — mirrors the design's `fmt`. */
export function fmtCount(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n);
}
