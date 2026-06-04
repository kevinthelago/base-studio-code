// Per-repo feature plans (#177). The planner's per-repo pass can now go down to the
// FEATURE level: for each repo it writes one plan section per feature, namespaced
// `repo__{short}__feat__{slug}`, carrying the feature's approach, a phase marker, and
// (optionally) acceptance criteria. At publish each feature section becomes one real
// GitHub issue under its milestone — supplementing, not replacing, the per-phase
// tracking issues.
//
// Rather than thread a parallel "feature" object through the structure builder and the
// publisher, a feature section is converted into a synthetic {@link PlanIssue}: it then
// flows through the exact same granular-issue machinery (#311) — structure nodes,
// milestone pinning, labels, and the GitHub-link overlay — with no special-casing
// downstream.
//
// Pure (no React/Tauri) so the parsing is unit-testable and shared between Planning.tsx
// and its tests.

import { parseSectionKey } from "./planSections";
import type { PlanIssue } from "./planIssues";

/** The repo-tier topic prefix that marks a section as a feature (`feat__{slug}`). */
export const FEATURE_PREFIX = "feat__";

/** Label applied to every feature-derived issue so they're filterable on GitHub. */
export const FEATURE_LABEL = "type:feature";

/** True when a section key is a per-repo feature section (`repo__{short}__feat__{slug}`). */
export function isFeatureKey(key: string): boolean {
  const info = parseSectionKey(key);
  return info.tier === "repo" && info.repo !== null && info.topic.startsWith(FEATURE_PREFIX)
    && info.topic.length > FEATURE_PREFIX.length;
}

/** The feature slug for a feature key, or null when the key isn't a feature section. */
export function featureSlug(key: string): string | null {
  if (!isFeatureKey(key)) return null;
  return parseSectionKey(key).topic.slice(FEATURE_PREFIX.length);
}

/** Title-case a slug (`login-form` → "Login form") as the fallback feature title. */
function humanizeSlug(slug: string): string {
  const words = slug.split(/[-_\s]+/).filter(Boolean);
  if (words.length === 0) return "Feature";
  return words.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(" ");
}

export interface ParsedFeature {
  /** Phase the feature belongs to (1-based number or milestone name), or undefined. */
  phase?: number | string;
  /** Feature title — the section's first heading, else the humanized slug. */
  title: string;
  /** The feature's approach/body, with the phase marker + leading title heading stripped. */
  body: string;
  /** Acceptance items pulled from `- [ ]` checkbox lines, if any. */
  acceptance: string[];
}

/**
 * Parse a feature section's markdown into its structured parts. Tolerant of how the
 * planner writes it:
 *
 * - **Phase marker** — the first line matching `phase: <n|name>` (also `phase = …` and
 *   an HTML-comment `<!-- phase: … -->`). A bare number → a 1-based phase index;
 *   anything else → a milestone name. Dropped from the body.
 * - **Title** — the first markdown heading (`# …`), else the humanized `slug`. A
 *   leading heading used as the title is dropped from the body (a deeper/later heading
 *   is kept).
 * - **Acceptance** — every `- [ ]` / `- [x]` checkbox line becomes an acceptance item
 *   and is lifted out of the body (so {@link renderIssueBody} renders one clean
 *   checklist instead of duplicating it).
 *
 * Everything else is preserved as the body (the approach).
 */
export function parseFeatureSection(content: string, slug: string): ParsedFeature {
  let phase: number | string | undefined;
  let title = "";
  const acceptance: string[] = [];
  const bodyLines: string[] = [];
  let sawContent = false;

  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();

    const pm = line.match(/^(?:<!--\s*)?phase\s*[:=]\s*(.+?)\s*(?:-->)?$/i);
    if (pm && phase === undefined) {
      const v = pm[1].trim();
      const n = Number(v);
      phase = v !== "" && Number.isFinite(n) ? n : v;
      continue; // metadata, not approach — drop from the body
    }

    // The FIRST heading, before any other content, is the feature title.
    const hm = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (hm && !title && !sawContent) {
      title = hm[1].trim();
      continue;
    }

    const am = line.match(/^[-*]\s+\[[ xX]?\]\s+(.+?)\s*$/);
    if (am) {
      acceptance.push(am[1].trim());
      continue;
    }

    if (line) sawContent = true;
    bodyLines.push(raw);
  }

  if (!title) title = humanizeSlug(slug);
  return { phase, title, body: bodyLines.join("\n").trim(), acceptance };
}

/** A section as the converter needs it — just its key and raw content. */
export interface FeatureSectionInput {
  k: string;
  content: string;
}

/**
 * Resolve a repo short name (`web`, the name without its owner) to the matching full
 * `owner/repo` from `repos`, case-insensitively. Returns undefined when none matches —
 * the synthetic issue then has no `repo` and publish files it under the default repo.
 */
function resolveRepo(short: string, repos: string[]): string | undefined {
  const lc = short.toLowerCase();
  return repos.find((full) => (full.split("/")[1] ?? full).toLowerCase() === lc);
}

/**
 * Convert every per-repo feature section into a synthetic {@link PlanIssue}. Each gets a
 * stable, namespaced ref (`feat:{short}:{slug}`) that can't collide with a hand-authored
 * issues.json ref, the resolved full repo, its parsed phase/title/body/acceptance, and
 * the {@link FEATURE_LABEL}. Non-feature sections are ignored.
 */
export function featureSectionsToIssues(sections: FeatureSectionInput[], repos: string[]): PlanIssue[] {
  const out: PlanIssue[] = [];
  for (const s of sections) {
    const slug = featureSlug(s.k);
    if (!slug) continue;
    const short = parseSectionKey(s.k).repo as string; // isFeatureKey guarantees non-null
    const parsed = parseFeatureSection(s.content, slug);
    out.push({
      ref: `feat:${short}:${slug}`,
      title: parsed.title,
      phase: parsed.phase,
      acceptance: parsed.acceptance,
      owns: [],
      dependsOn: [],
      labels: [FEATURE_LABEL],
      repo: resolveRepo(short, repos),
      body: parsed.body || undefined,
    });
  }
  return out;
}
