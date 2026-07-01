// Pure helpers for the planner's section-by-section discovery loop.
//
// Free of React / xterm / Tauri imports so the tag parsing and message building
// can be unit-tested in isolation and shared with Planning.tsx.

import type { AgentStream } from "../fleet/planFleet";
import { flowOrUndefined } from "../fleet/agentFlow";
import { type IntegrationStrategy, normalizeStrategy } from "../lib/integrationStrategy";

// Quote-flexible class: straight ("), and curly (“ ”) so an LLM emitting smart
// quotes doesn't silently break tag detection. Mirrors the other planner tags.
const Q = '["“”]';

// The `<plan_focus>` stream tag was removed (#2017): the "active topic" card-highlight it drove was
// dropped in the focused-pane redesign (#652), so it fed a discarded state value. The stepper follows
// the live session off the section files the planner writes, not a tag.

/**
 * The message injected into Claude's PTY when the user confirms a section in the
 * UI. It is the "advance to the next section" signal for the discovery loop.
 */
export function buildSectionConfirmMessage(sectionTitle: string): string {
  return `[The user confirmed the "${sectionTitle}" section in the planner UI — continue to the next section.]`;
}

/**
 * The message injected into Claude's PTY when the user deliberately SKIPS an optional stage in the
 * planner UI (#921). It tells the planner to stop any work on that stage and move on — the stage is
 * optional and the user chose not to do it.
 */
export function buildSectionSkipMessage(sectionTitle: string): string {
  return `[The user chose to SKIP the optional "${sectionTitle}" section in the planner UI — do not work on it; continue to the next section.]`;
}

// Startup scripts moved to plan.db (#2010) — the planner records per-repo kickoff/triage prompt
// docs with `bsc plan startup add`; the section poll resolves each `path` via `scriptDocRelpath`
// (below) and auto-assigns it. (The `<startup_script>` stream tag + its parser are gone.)

/**
 * Build the unified-store relpath for a script the planner wrote to its project
 * dir. `sanitizedKey` is the on-disk project folder (sanitize_project_key). A
 * path already rooted at `projects/` is returned untouched; otherwise it is
 * resolved under the project hub. Backslashes are normalized to posix and any
 * leading slashes stripped so the result satisfies read_document's path guards.
 */
export function scriptDocRelpath(sanitizedKey: string, path: string): string {
  const clean = path.replace(/\\/g, "/").replace(/^\/+/, "");
  if (clean.startsWith("projects/")) return clean;
  return `projects/${sanitizedKey}/${clean}`;
}

// ── Agent fleet tags ──────────────────────────────────────────────────────────
//
// The planner designs how multiple Claude sessions run in parallel. `fleet.json`
// is the authoritative channel (polled like commands.json); these inline tags are
// the fast path for immediate UI feedback before the next poll.

/** Read one attribute value from a tag's attribute string (quote-flexible). */
function tagAttr(attrs: string, k: string): string | undefined {
  return new RegExp(`\\b${k}=${Q}([^\\u0022\\u201c\\u201d]*)${Q}`).exec(attrs)?.[1];
}

/** Split a comma-separated attribute value into trimmed, non-empty parts. */
function tagList(attrs: string, k: string): string[] {
  return (tagAttr(attrs, k) ?? "").split(",").map(s => s.trim()).filter(Boolean);
}

// Tolerant of an optional self-closing slash so a missing `/` doesn't drop the tag.
const AGENT_ASSIGN_RE = () => /<agent_assign\s+([^>]*?)\/?>/g;

/**
 * Parse every `<agent_assign id="..." name="..." repo="owner/repo" owns="a,b"
 * issues="#1,#2" depends_on="other-id" prompt="prompts/x-kickoff.md"
 * autonomy="continuous" push="auto-pr" trigger="per-issue" gate="hard" />` tag into a
 * {@link AgentStream}. Attributes may use straight or curly quotes and any order;
 * list attributes are comma-separated. `depends_on` and `dependsOn` are both
 * accepted. Tags missing `id` or `repo` are skipped.
 */
export function parseAgentAssigns(text: string): AgentStream[] {
  const re = AGENT_ASSIGN_RE();
  const out: AgentStream[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const attrs = m[1];
    const id   = tagAttr(attrs, "id")?.trim();
    const repo = tagAttr(attrs, "repo")?.trim();
    if (!id || !repo) continue;
    const deps = tagList(attrs, "depends_on");
    const prompt = tagAttr(attrs, "prompt")?.trim();
    out.push({
      id,
      name: tagAttr(attrs, "name")?.trim() || id,
      repo,
      owns:      tagList(attrs, "owns"),
      issues:    tagList(attrs, "issues"),
      dependsOn: deps.length ? deps : tagList(attrs, "dependsOn"),
      prompt: prompt || undefined,
      profile: tagAttr(attrs, "profile")?.trim() || undefined,
      flow: flowOrUndefined({
        autonomy: tagAttr(attrs, "autonomy")?.trim(),
        push:     tagAttr(attrs, "push")?.trim(),
        trigger:  tagAttr(attrs, "trigger")?.trim(),
        gate:     tagAttr(attrs, "gate")?.trim(),
      }),
      strategy: normalizeStrategy(tagAttr(attrs, "strategy")?.trim()),
    });
  }
  return out;
}

/** Remove every `<agent_assign>` tag so it never prints in the terminal. */
export function stripAgentAssigns(text: string): string {
  return text.replace(AGENT_ASSIGN_RE(), "");
}

/** The fleet-level metadata carried by a `<fleet_plan>` tag. */
export interface FleetMeta {
  recommended: number;
  reasoning: string;
  director: boolean;
  directorRole?: string;
  /** Project-default integration strategy (#378). Unset ⇒ DEFAULT_STRATEGY downstream. */
  strategy?: IntegrationStrategy;
}

const FLEET_PLAN_RE = () => /<fleet_plan\s+([^>]*?)\/?>/g;

/**
 * Parse the `<fleet_plan recommended="4" reasoning="..." director="true"
 * director_role="..." />` tag. When several appear in the buffer the last one wins
 * (the planner re-emits as the fleet firms up). Returns `null` when none are present.
 */
export function parseFleetPlan(text: string): FleetMeta | null {
  const re = FLEET_PLAN_RE();
  let m: RegExpExecArray | null;
  let last: FleetMeta | null = null;
  while ((m = re.exec(text)) !== null) {
    const attrs = m[1];
    const recRaw = tagAttr(attrs, "recommended");
    const rec = recRaw !== undefined ? Number(recRaw) : NaN;
    const dir = (tagAttr(attrs, "director") ?? "").trim().toLowerCase();
    last = {
      recommended: Number.isFinite(rec) && rec >= 0 ? Math.floor(rec) : 0,
      reasoning: tagAttr(attrs, "reasoning")?.trim() ?? "",
      director: dir === "true" || dir === "yes" || dir === "1",
      directorRole: tagAttr(attrs, "director_role")?.trim() || undefined,
      strategy: normalizeStrategy(tagAttr(attrs, "strategy")?.trim()),
    };
  }
  return last;
}

/** Remove every `<fleet_plan>` tag so it never prints in the terminal. */
export function stripFleetPlan(text: string): string {
  return text.replace(FLEET_PLAN_RE(), "");
}
