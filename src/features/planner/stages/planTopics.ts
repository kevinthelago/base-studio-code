// Pure helpers for the dynamic, guided project planner.
//
// The planner no longer has a fixed list of sections. Claude documents whatever
// topics a given project warrants — each documented topic becomes its own file
// in the plan directory and is surfaced in the UI as it's written. These helpers
// turn raw section keys (file stems) into ordered, titled, tier-grouped sections
// for rendering, and parse the considered-but-skipped coverage record.
//
// Free of React / xterm / Tauri imports so the logic can be unit-tested in
// isolation and shared between Planning.tsx and its tests. (The fleet/agent-stream
// machinery that used to live here moved to fleet/planFleet.ts in #1615.)

import { FLEET_KEY } from "../fleet/planFleet";

/** The coverage record: topics considered but deliberately not documented. */
export const SKIPPED_KEY = "_skipped";

/** The feature list file (JSON: `features.json` — an array of feature objects). The
 *  authoritative artifact of the Features stage (#…): each entry is a user-facing capability
 *  and a fleet stream. Surfaced by the poll like `fleet.json`; not rendered as a plan section —
 *  it drives the Features board. See {@link parseFeaturesFile} in featureList. */
export const FEATURES_KEY = "features";

/**
 * Anchor sections that are always present in the UI even before Claude drafts
 * them, because the GitHub publish flow is keyed off them:
 *   - `goal`   → project board title + description
 */
export const ANCHOR_KEYS = ["goal"] as const;

/** Section keys for the per-repo tier are namespaced `repo__{short}__{topic}`. */
const REPO_PREFIX = "repo__";

/**
 * The curated checklist of dimensions covering modern application development,
 * in the order they should appear. Claude walks this list during discovery,
 * documenting the ones that apply and recording the rest as skipped. Custom
 * topics Claude invents sort after these (alphabetically). The title is what the
 * section card shows.
 *
 * Single-sourced from the Discovery stage data (`src-tauri/data/stages/discovery.json`,
 * its `dimensions` array) so the dimension vocabulary lives in ONE place — the same data
 * file the planner prompt and gate read (#1591). Loaded directly via `import.meta.glob`
 * (NOT through blueprints.ts `STAGE_DEFS`) to avoid a circular import.
 */
const discoveryModules = import.meta.glob<{ default: { dimensions?: { key: string; title: string }[] } }>(
  "@data/stages/discovery.json",
  { eager: true },
);
export const KNOWN_DIMENSIONS: { key: string; title: string }[] =
  Object.values(discoveryModules)[0]?.default.dimensions ?? [];

const TITLE_BY_KEY = new Map(KNOWN_DIMENSIONS.map(d => [d.key, d.title]));
const ORDER_BY_KEY = new Map(KNOWN_DIMENSIONS.map((d, i) => [d.key, i]));

// Reverse map (#…): a section the planner named after its DISPLAY TITLE ("Tech stack.md") or a
// casing/separator variant is canonicalized back to its key ("stack"), so the Context gate —
// which keys off goal/scope/stack/architecture — stays robust to how the file is named.
const KEY_BY_TITLE = new Map(KNOWN_DIMENSIONS.map(d => [d.title.toLowerCase(), d.key]));
// Synonyms with no separator / alternate wording the title map alone wouldn't catch.
const KEY_ALIASES: Record<string, string> = {
  techstack: "stack", "technology stack": "stack",
  "data schema": "schema", personas: "users",
  versioning: "release", releases: "release", "release schedule": "release",
  "versioning and release schedule": "release", "release plan": "release",
  // #3989 — the outage plan is prose-titled in a dozen ways; land them all on the one key.
  "outage response": "outage_response", "outage": "outage_response",
  "cloud outage": "outage_response", "cloud outage response plan": "outage_response",
  "outage response plan": "outage_response",
};
/**
 * Map a section key/stem the planner may have written as a display title or alias (e.g.
 * "Tech stack", "Tech_stack") back to its canonical key ("stack"). Canonical keys and unknown
 * custom topics pass through unchanged.
 */
export function canonicalTopicKey(key: string): string {
  const raw = key.trim();
  if (TITLE_BY_KEY.has(raw)) return raw; // already canonical
  const norm = raw.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return KEY_BY_TITLE.get(norm) ?? KEY_ALIASES[norm] ?? key;
}

// Words that should keep a specific casing rather than be Title-cased.
const ACRONYMS: Record<string, string> = {
  api: "API", ui: "UI", ux: "UX", id: "ID", url: "URL", db: "DB", io: "IO",
  ci: "CI", cd: "CD", cli: "CLI", sdk: "SDK", cicd: "CI/CD", sql: "SQL",
  html: "HTML", css: "CSS", http: "HTTP", grpc: "gRPC", i18n: "i18n",
  a11y: "a11y", seo: "SEO", mvp: "MVP", kpi: "KPI", llm: "LLM", ml: "ML",
};

function humanize(topic: string): string {
  const words = topic.split(/[_\-\s]+/).filter(Boolean);
  if (words.length === 0) return "Section";
  return words
    .map(w => ACRONYMS[w.toLowerCase()] ?? (w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

export interface TopicKeyInfo {
  /** "project" for top-level plan sections, "repo" for a per-repo tier section. */
  tier: "project" | "repo";
  /** Short repo name for repo-tier sections; null for project-tier. */
  repo: string | null;
  /** The dimension/topic this section documents (e.g. "api", "security"). */
  topic: string;
}

/**
 * Decode a raw section key (file stem) into its tier and topic.
 *
 * Project-tier keys are bare (`api`, `security`, `data_lifecycle`).
 * Repo-tier keys are namespaced `repo__{short}__{topic}` — e.g. `repo__web__api`
 * → repo "web", topic "api". A repo key missing its topic falls back to
 * "overview".
 */
export function parseTopicKey(key: string): TopicKeyInfo {
  if (key.startsWith(REPO_PREFIX)) {
    const rest = key.slice(REPO_PREFIX.length);
    const sep = rest.indexOf("__");
    if (sep > 0) {
      return { tier: "repo", repo: rest.slice(0, sep), topic: rest.slice(sep + 2) || "overview" };
    }
    // `repo__web` with no topic — treat the remainder as the repo, topic generic.
    return { tier: "repo", repo: rest || "repo", topic: "overview" };
  }
  return { tier: "project", repo: null, topic: key };
}

/** Human-readable title for a section key, honoring the curated titles and acronyms. */
export function titleForTopic(key: string): string {
  if (key === SKIPPED_KEY) return "Considered & skipped";
  const { topic } = parseTopicKey(key);
  return TITLE_BY_KEY.get(topic) ?? humanize(topic);
}

/**
 * Order project-tier section keys: known dimensions in checklist order, then any
 * custom keys alphabetically. The `_skipped` record and repo-tier keys are not
 * expected here (callers filter them out first).
 */
export function orderTopicKeys(keys: string[]): string[] {
  const rank = (k: string) => ORDER_BY_KEY.get(k) ?? KNOWN_DIMENSIONS.length;
  return [...keys].sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    return ra !== rb ? ra - rb : a.localeCompare(b);
  });
}

/**
 * Split a flat list of section keys into the project tier and per-repo groups.
 * Project keys are ordered by the curated checklist; each repo's topics are
 * ordered the same way (by topic). The `_skipped` record is excluded from both.
 */
export function groupTopics(keys: string[]): {
  project: string[];
  repos: { repo: string; keys: string[] }[];
} {
  const project: string[] = [];
  const byRepo = new Map<string, string[]>();
  for (const key of keys) {
    if (key === SKIPPED_KEY || key === FLEET_KEY || key === FEATURES_KEY) continue;
    const info = parseTopicKey(key);
    if (info.tier === "repo" && info.repo) {
      const list = byRepo.get(info.repo) ?? [];
      list.push(key);
      byRepo.set(info.repo, list);
    } else {
      project.push(key);
    }
  }
  const repos = [...byRepo.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([repo, ks]) => ({
      repo,
      keys: [...ks].sort((a, b) => {
        const ta = parseTopicKey(a).topic, tb = parseTopicKey(b).topic;
        const ra = ORDER_BY_KEY.get(ta) ?? KNOWN_DIMENSIONS.length;
        const rb = ORDER_BY_KEY.get(tb) ?? KNOWN_DIMENSIONS.length;
        return ra !== rb ? ra - rb : ta.localeCompare(tb);
      }),
    }));
  return { project: orderTopicKeys(project), repos };
}

export interface SkippedItem { topic: string; reason: string; }

/**
 * Parse the `_skipped.md` coverage record into topic/reason pairs. Tolerant of a
 * few common line formats so Claude isn't forced into a rigid syntax:
 *
 *   - **topic** — reason
 *   - topic — reason
 *   - topic: reason
 *   - topic - reason
 *
 * Lines without a recognizable separator are treated as a topic with no reason.
 * Blank lines and markdown headers/horizontal rules are ignored.
 */
export function parseSkipped(content: string): SkippedItem[] {
  if (!content) return [];
  const out: SkippedItem[] = [];
  for (const raw of content.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    if (/^#{1,6}(?:\s|$)/.test(line)) continue;  // markdown header — not a skip item
    line = line.replace(/^[-*+]\s+/, "");        // drop leading list marker
    if (!line || /^[-=_]{3,}$/.test(line)) continue;  // blank or horizontal rule
    // Split topic from reason on the first em dash, " - ", or ":".
    const m = line.match(/^(.*?)(?:\s+—\s+|\s+-\s+|:\s+)(.*)$/);
    if (m) {
      const topic = m[1].replace(/\*\*/g, "").trim();
      const reason = m[2].trim();
      if (topic) out.push({ topic, reason });
    } else {
      const topic = line.replace(/\*\*/g, "").trim();
      if (topic) out.push({ topic, reason: "" });
    }
  }
  return out;
}
