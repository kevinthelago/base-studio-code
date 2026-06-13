import type { AgentFlow } from "./agentFlow";
import { flowOrUndefined } from "./agentFlow";
import { type DirectorDrive, normalizeDirectorDrive, DEFAULT_DIRECTOR_DRIVE } from "./directorDrive";
import { type IntegrationStrategy, normalizeStrategy } from "./integrationStrategy";
// Pure helpers for the dynamic, guided project planner.
//
// The planner no longer has a fixed list of sections. Claude documents whatever
// topics a given project warrants — each documented topic becomes its own file
// in the plan directory and is surfaced in the UI as it's written. These helpers
// turn raw section keys (file stems) into ordered, titled, tier-grouped sections
// for rendering, and parse the considered-but-skipped coverage record.
//
// Free of React / xterm / Tauri imports so the logic can be unit-tested in
// isolation and shared between Planning.tsx and its tests.

/** The coverage record: topics considered but deliberately not documented. */
export const SKIPPED_KEY = "_skipped";

/** The allowed-commands config file (JSON). Surfaced by the poll, not rendered
 *  as a plan section — synced into the per-project/repo command store instead. */
export const COMMANDS_KEY = "commands";

/** The agent-fleet config file (JSON: `fleet.json`). Surfaced by the poll like
 *  `commands.json` — not a rendered plan section; parsed into the fleet store and
 *  shown in its own Fleet card. See {@link parseFleetFile}. */
export const FLEET_KEY = "fleet";

/** The linked-repositories file (JSON: `repos.json` — an array of `"owner/repo"`).
 *  The persistent, resume-safe complement to the live `<repo_link>` tag: a resumed
 *  planner can't replay a stream-only tag, but it CAN write this file, so the right
 *  pane reliably shows the repos. Surfaced by the poll like `fleet.json`; not rendered
 *  as a plan section. See {@link parseReposFile}. */
export const REPOS_KEY = "repos";

/** The reusable-skills file (JSON: `skills.json` — an array of skill objects).
 *  The planner's CRUD channel into the global Skills library. Surfaced by the
 *  poll like `commands.json`; not rendered as a plan section — upserted into the
 *  skills store. See {@link parseSkillsFile} in lib/skills. (#404) */
export const SKILLS_KEY = "skills";

/** The feature list file (JSON: `features.json` — an array of feature objects). The
 *  authoritative artifact of the Features stage (#…): each entry is a user-facing capability
 *  and a fleet stream. Surfaced by the poll like `fleet.json`; not rendered as a plan section —
 *  it drives the Features board. See {@link parseFeaturesFile} in featureList. */
export const FEATURES_KEY = "features";

/** Parse `repos.json` into a deduped list of `owner/repo` full names. Accepts a bare
 *  JSON array of strings, or `{ "repos": [...] }`. Returns [] on blank/malformed. */
export function parseReposFile(raw: string): string[] {
  const t = raw.trim();
  if (!t) return [];
  try {
    const j: unknown = JSON.parse(t);
    const arr: unknown[] = Array.isArray(j)
      ? j
      : (j && typeof j === "object" && Array.isArray((j as { repos?: unknown }).repos))
        ? (j as { repos: unknown[] }).repos
        : [];
    return [...new Set(
      arr.filter((x): x is string => typeof x === "string" && x.includes("/")).map((x) => x.trim()),
    )];
  } catch {
    return [];
  }
}

/**
 * One parallel work stream — a single Claude session with a focused role, a repo,
 * the files/globs it OWNS (its conflict boundary), the issues it owns, the streams
 * it must follow (interface-first), and the kickoff script that seeds it.
 */
export interface AgentStream {
  id: string;
  name: string;
  repo: string;
  /** Path globs this stream owns; no other stream should write inside them. */
  owns: string[];
  /** Issue refs this stream owns (e.g. `#12`). */
  issues: string[];
  /** Ids of streams that must land before this one starts. */
  dependsOn: string[];
  /** Relpath of the kickoff script the fleet launch seeds this session with. */
  prompt?: string;
  /** Id of the AgentProfile this stream's session launches under (#289). */
  profile?: string;
  /** Per-agent execution flow (#297): autonomy + GitHub push policy. Unset ⇒ DEFAULT_FLOW at launch. */
  flow?: AgentFlow;
  /** Per-stream integration-strategy override (#378). Unset ⇒ the fleet default. */
  strategy?: IntegrationStrategy;
  /** Per-capability permission posture chosen in the project pane's agent editor.
   *  When present it overrides the profile-derived posture in the pane. */
  perm?: Record<string, "allow" | "ask" | "deny">;
  /** Permission preset name chosen in the pane (e.g. "Build"), or "custom" when a
   *  capability was hand-tuned. When present it overrides the profile-derived preset. */
  preset?: string;
}

/** Optional async-integrator session that coordinates the fleet from the project root. */
export interface FleetDirector { enabled: boolean; role?: string; drive?: DirectorDrive; }

/** The full parallel-execution plan for a project (persisted as `fleet.json`). */
export interface FleetPlan {
  /** Optimal number of worker sessions to run concurrently. */
  recommended: number;
  /** Why that many — the planner's justification. */
  reasoning: string;
  streams: AgentStream[];
  director: FleetDirector;
  /** Project-default integration strategy (#378). Unset ⇒ DEFAULT_STRATEGY. */
  strategy?: IntegrationStrategy;
}

/** An empty fleet — the default before the planner has designed one. */
export function emptyFleet(): FleetPlan {
  return { recommended: 0, reasoning: "", streams: [], director: { enabled: false, drive: DEFAULT_DIRECTOR_DRIVE } };
}

/**
 * Anchor sections that are always present in the UI even before Claude drafts
 * them, because the GitHub publish flow is keyed off them:
 *   - `goal`   → project board title + description
 *   - `phases` → milestones and per-repo tracking issues
 */
export const ANCHOR_KEYS = ["goal", "phases"] as const;

/** Section keys for the per-repo tier are namespaced `repo__{short}__{topic}`. */
export const REPO_PREFIX = "repo__";

/**
 * The curated checklist of dimensions covering modern application development,
 * in the order they should appear. Claude walks this list during discovery,
 * documenting the ones that apply and recording the rest as skipped. Custom
 * topics Claude invents sort after these (alphabetically). The title is what the
 * section card shows.
 */
export const KNOWN_DIMENSIONS: { key: string; title: string }[] = [
  { key: "goal",           title: "Goal" },
  { key: "users",          title: "Users & personas" },
  { key: "scope",          title: "Scope" },
  { key: "ux",             title: "UX & flows" },
  { key: "stack",          title: "Tech stack" },
  { key: "architecture",   title: "Architecture" },
  { key: "schema",         title: "Data model" },
  { key: "api",            title: "API & contracts" },
  { key: "integrations",   title: "Integrations" },
  { key: "auth",           title: "Auth & access" },
  { key: "security",       title: "Security & privacy" },
  { key: "testing",        title: "Testing" },
  { key: "observability",  title: "Observability & logging" },
  { key: "performance",    title: "Performance & reliability" },
  { key: "infra",          title: "Infrastructure" },
  { key: "cicd",           title: "CI/CD" },
  { key: "data_lifecycle", title: "Data lifecycle" },
  { key: "docs",           title: "Documentation" },
  { key: "analytics",      title: "Analytics" },
  { key: "accessibility",  title: "Accessibility & i18n" },
  { key: "cost",           title: "Cost & resourcing" },
  { key: "phases",         title: "Roadmap" },
  { key: "risks",          title: "Risks" },
  { key: "open_questions", title: "Open questions" },
];

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
};
/**
 * Map a section key/stem the planner may have written as a display title or alias (e.g.
 * "Tech stack", "Tech_stack") back to its canonical key ("stack"). Canonical keys and unknown
 * custom topics pass through unchanged.
 */
export function canonicalSectionKey(key: string): string {
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

export interface SectionKeyInfo {
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
export function parseSectionKey(key: string): SectionKeyInfo {
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
export function titleForKey(key: string): string {
  if (key === SKIPPED_KEY) return "Considered & skipped";
  const { topic } = parseSectionKey(key);
  return TITLE_BY_KEY.get(topic) ?? humanize(topic);
}

/**
 * Order project-tier section keys: known dimensions in checklist order, then any
 * custom keys alphabetically. The `_skipped` record and repo-tier keys are not
 * expected here (callers filter them out first).
 */
export function orderProjectKeys(keys: string[]): string[] {
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
export function groupSections(keys: string[]): {
  project: string[];
  repos: { repo: string; keys: string[] }[];
} {
  const project: string[] = [];
  const byRepo = new Map<string, string[]>();
  for (const key of keys) {
    if (key === SKIPPED_KEY || key === COMMANDS_KEY || key === FLEET_KEY || key === REPOS_KEY || key === SKILLS_KEY || key === FEATURES_KEY) continue;
    const info = parseSectionKey(key);
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
        const ta = parseSectionKey(a).topic, tb = parseSectionKey(b).topic;
        const ra = ORDER_BY_KEY.get(ta) ?? KNOWN_DIMENSIONS.length;
        const rb = ORDER_BY_KEY.get(tb) ?? KNOWN_DIMENSIONS.length;
        return ra !== rb ? ra - rb : ta.localeCompare(tb);
      }),
    }));
  return { project: orderProjectKeys(project), repos };
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

/** Coerce a JSON value into a string[]. Accepts an array (strings kept, others
 *  stringified) or a single comma-separated string; anything else → []. */
function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.map(x => (typeof x === "string" ? x : String(x))).map(s => s.trim()).filter(Boolean);
  }
  if (typeof v === "string") {
    return v.split(",").map(s => s.trim()).filter(Boolean);
  }
  return [];
}

/** Coerce a JSON value into a non-negative integer; non-numeric → 0. */
function coerceNum(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/**
 * Parse the `fleet.json` config the planner writes (surfaced by the section poll
 * as stem {@link FLEET_KEY}) into a {@link FleetPlan}. Tolerant of partial/malformed
 * input: returns `null` only when the text is blank or not a JSON object; otherwise
 * fills sensible defaults. Streams missing `id` or `repo` are dropped; `dependsOn`
 * accepts either `dependsOn` or `depends_on`.
 */
export function parseFleetFile(raw: string): FleetPlan | null {
  if (!raw || !raw.trim()) return null;
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch { return null; }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;

  const streams: AgentStream[] = [];
  const rawStreams = Array.isArray(o.streams) ? o.streams : [];
  for (const s of rawStreams) {
    if (!s || typeof s !== "object") continue;
    const so = s as Record<string, unknown>;
    const id   = typeof so.id === "string" ? so.id.trim() : "";
    const repo = typeof so.repo === "string" ? so.repo.trim() : "";
    if (!id || !repo) continue;  // id + repo are the minimum a stream needs
    const prompt = typeof so.prompt === "string" && so.prompt.trim() ? so.prompt.trim() : undefined;
    streams.push({
      id,
      name: typeof so.name === "string" && so.name.trim() ? so.name.trim() : id,
      repo,
      owns:      toStringArray(so.owns),
      issues:    toStringArray(so.issues),
      dependsOn: toStringArray(so.dependsOn ?? so.depends_on),
      prompt,
      profile: typeof so.profile === "string" && so.profile.trim() ? so.profile.trim() : undefined,
      flow: flowOrUndefined(so.flow && typeof so.flow === "object" && !Array.isArray(so.flow) ? so.flow as Record<string, unknown> : null),
      perm: (so.perm && typeof so.perm === "object" && !Array.isArray(so.perm))
        ? (so.perm as Record<string, "allow" | "ask" | "deny">) : undefined,
      preset: typeof so.preset === "string" && so.preset.trim() ? so.preset.trim() : undefined,
      strategy: normalizeStrategy(so.strategy),
    });
  }

  const dir = (o.director && typeof o.director === "object" && !Array.isArray(o.director))
    ? (o.director as Record<string, unknown>) : {};
  const director: FleetDirector = {
    enabled: dir.enabled === true || dir.enabled === "true",
    role: typeof dir.role === "string" && dir.role.trim() ? dir.role.trim() : undefined,
    drive: normalizeDirectorDrive(dir.drive),
  };

  return {
    recommended: coerceNum(o.recommended),
    reasoning: typeof o.reasoning === "string" ? o.reasoning : "",
    streams,
    director,
    strategy: normalizeStrategy(o.strategy),
  };
}
