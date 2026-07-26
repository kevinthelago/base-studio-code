// Pure facet / filter / sort logic for the Projects page (#3802) — the Projects-tab twin of the
// Skills library's `lib/skillsFilter.ts`. It folds the FOUR project sources (GitHub boards, local
// published hubs, in-progress drafts, bare drafts) into ONE unified `ProjectItem` list, then filters
// (search + a Status facet + an application-architecture Type facet) and sorts it. Free of React /
// Tauri so it's unit-testable in isolation; the composer (`ProjectsList`) owns the state + the
// open/delete handlers and the surrounding chrome.

import { projStatus, projectProgress, type GhProject } from "./published/publishedModel";
import { projectSlug } from "@/shared/lib/core/projectPaths";
import type { DraftRow } from "./drafts";
import type { LocalPublishedRow } from "./localPublished";
import type { ChipTone } from "@/shared/ui/data/Chip";
import { type AppType, APP_TYPES, type ClassifyConfig } from "@/features/planner/lib/classifyConfig";
import { serviceMode, type DeployConfig, type DeployService } from "@/features/planner/lib/deployServices";

/** The lifecycle bucket a project lands in — the Status facet's four values (#3802). */
export type ProjectStatus = "active" | "shipped" | "in-progress" | "draft";

/** Which of the four sources a card came from — drives its open action + card affordances. */
export type ProjectSource = "board" | "local" | "draft";

/** Re-export the application-architecture type axis (#3802) so callers reach it via this module. */
export type { AppType } from "@/features/planner/lib/classifyConfig";

/** A presentation-ready project row, unified across all four sources. Carries the raw source ref
 *  (`gh` / `draft`) so the composer routes the correct open/delete handler without re-deriving it. */
export interface ProjectItem {
  /** Stable React key (gh node id, or `local:<key>` / `draft:<key>`). */
  id: string;
  /** The name-derived slug key (#2409) — the project's on-disk identity. */
  key: string;
  title: string;
  description: string;
  status: ProjectStatus;
  /** The project's APPLICATION ARCHITECTURE (#3802) — the Type facet axis. */
  appType: AppType;
  source: ProjectSource;
  /** GitHub project #number (boards only). */
  number?: number;
  /** Short repo names (boards only). */
  repos: string[];
  itemsTotal: number;
  open: number;
  /** Progress fraction 0..1 (closed / total items; boards only). */
  pct: number;
  running: number;
  paused: number;
  /** Recency key (epoch ms). */
  updatedAt: number;
  /** The raw board project (source "board") — for the reopen / board / delete handlers. */
  gh?: GhProject;
  /** The raw draft row (source "draft") — for reopen / delete-draft. */
  draft?: DraftRow;
}

export type SortKey = "recency" | "name";
export const SORTS: { value: SortKey; label: string }[] = [
  { value: "recency", label: "Recently updated" },
  { value: "name", label: "Name (A–Z)" },
];

/** Card / list density. */
export type Density = "cards" | "list";

/** The Status facet's option set — value, label, dot colour, and the Chip tone the card uses. */
export interface StatusFacet {
  value: ProjectStatus;
  label: string;
  dot: string;
  tone: ChipTone;
}
export const STATUS_FACETS: StatusFacet[] = [
  { value: "active",      label: "active",      dot: "var(--success)", tone: "success" },
  { value: "shipped",     label: "shipped",     dot: "var(--fg-dim)",  tone: "neutral" },
  { value: "in-progress", label: "in progress", dot: "var(--violet)",  tone: "info" },
  { value: "draft",       label: "draft",       dot: "var(--accent)",  tone: "accent" },
];

/** Status → display meta, indexed for O(1) lookup in the card. */
export const STATUS_META: Record<ProjectStatus, StatusFacet> =
  Object.fromEntries(STATUS_FACETS.map((f) => [f.value, f])) as Record<ProjectStatus, StatusFacet>;

/** The Type (application-architecture) facet — label + accent colour per {@link AppType} (#3802). */
export interface TypeFacet { value: AppType; label: string; color: string }
export const TYPE_FACETS: TypeFacet[] = [
  { value: "application", label: "application", color: "var(--accent)" },
  { value: "api",         label: "api",         color: "var(--success)" },
  { value: "serverless",  label: "serverless",  color: "var(--danger)" },
  { value: "static",      label: "static site", color: "color-mix(in oklch, var(--info), var(--success))" },
  { value: "desktop",     label: "desktop app", color: "var(--violet)" },
  { value: "mobile",      label: "mobile app",  color: "var(--info)" },
  { value: "cli",         label: "cli",         color: "color-mix(in oklch, var(--accent), var(--violet))" },
  { value: "library",     label: "library",     color: "var(--fg-dim)" },
];
export const TYPE_META: Record<AppType, TypeFacet> =
  Object.fromEntries(TYPE_FACETS.map((f) => [f.value, f])) as Record<AppType, TypeFacet>;

/** Map ONE deploy service's mode/workload/localKind onto an application-architecture {@link AppType}. */
function appTypeOfService(s: DeployService): AppType {
  if (serviceMode(s) === "local") {
    if (s.localKind === "library") return "library";
    // A local build-and-run app: a desktop installer, else a generic local application / CLI.
    return /desktop|installer/i.test(s.buildTargets ?? "") ? "desktop" : "application";
  }
  switch (s.workload) {
    case "static": return "static";
    case "serverless": return "serverless";
    case "service":
    case "container": return "api";
    default: return "application";
  }
}

/** Derive a project's architecture from its deploy config (the first service), or undefined if none. */
export function appTypeFromDeploy(deploy: DeployConfig | undefined): AppType | undefined {
  const first = deploy?.services?.[0];
  return first ? appTypeOfService(first) : undefined;
}

/** Resolve a project's application architecture (#3802): the explicit classification wins (the
 *  planner sets it at discovery via `bsc plan classify`), else it's derived from the deploy plan,
 *  else the neutral default "application". Pure + exported for direct testing. */
export function resolveAppType(classification: ClassifyConfig | undefined, deploy: DeployConfig | undefined): AppType {
  return classification?.appType ?? appTypeFromDeploy(deploy) ?? "application";
}

export interface BuildProjectItemsArgs {
  /** The visible GitHub boards (`visibleProjects`) — the live/persisted board rows. */
  boards: GhProject[];
  /** Local published hubs NOT covered by a board (`buildLocalPublished`) — the offline published set. */
  localPublished: LocalPublishedRow[];
  /** Every draft row (on-disk hubs ∪ store draft map ∪ DB drafts) — split by `dbStateByKey`. */
  drafts: DraftRow[];
  /** key → durable lifecycle state (`created`/`planning` ⇒ in-progress, else a bare draft). */
  dbStateByKey: Record<string, string>;
  /** Live fleet counts per board node id. */
  fleetByProject: Record<string, { running: number; paused: number }>;
  /** plan key → the project's classification blob (`planClassification`) — carries `appType` (#3802). */
  classificationByKey?: Record<string, ClassifyConfig>;
  /** plan key → the project's deploy plan (`planDeployConfig`) — the architecture fallback. */
  deployByKey?: Record<string, DeployConfig>;
}

/** Fold the four project sources into one unified, presentation-ready list. Pure. */
export function buildProjectItems(a: BuildProjectItemsArgs): ProjectItem[] {
  const items: ProjectItem[] = [];
  const classBy = a.classificationByKey ?? {};
  const deployBy = a.deployByKey ?? {};
  const typeOf = (planKey: string): AppType => resolveAppType(classBy[planKey], deployBy[planKey]);

  for (const p of a.boards) {
    const { open, pct } = projectProgress(p);
    const fleet = a.fleetByProject[p.id] ?? { running: 0, paused: 0 };
    items.push({
      id: p.id,
      key: p.id,
      title: p.title,
      description: p.shortDescription ?? "",
      status: projStatus(p),
      appType: typeOf(projectSlug(p.title)),
      source: "board",
      number: p.number,
      repos: (p.repositories?.nodes ?? []).map((r) => r.nameWithOwner.split("/")[1] ?? r.nameWithOwner),
      itemsTotal: p.items?.totalCount ?? 0,
      open,
      pct,
      running: fleet.running,
      paused: fleet.paused,
      updatedAt: new Date(p.updatedAt).getTime(),
      gh: p,
    });
  }

  for (const lp of a.localPublished) {
    items.push({
      id: "local:" + lp.key,
      key: lp.key,
      title: lp.title,
      description: "",
      // A published hub without board data is presumed active (the offline published set, #2445).
      status: "active",
      appType: typeOf(lp.key),
      source: "local",
      repos: [],
      itemsTotal: 0,
      open: 0,
      pct: 0,
      running: 0,
      paused: 0,
      updatedAt: lp.updatedAt,
    });
  }

  for (const d of a.drafts) {
    const st = a.dbStateByKey[d.key];
    const inProgress = st === "created" || st === "planning";
    items.push({
      id: "draft:" + d.key,
      key: d.key,
      title: d.title,
      description: d.pitch,
      status: inProgress ? "in-progress" : "draft",
      appType: typeOf(d.key),
      source: "draft",
      repos: [],
      itemsTotal: 0,
      open: 0,
      pct: 0,
      running: 0,
      paused: 0,
      updatedAt: d.sort,
      draft: d,
    });
  }

  return items;
}

/** Live per-status counts over the unified list — the rail facet badges. */
export function statusCounts(items: ProjectItem[]): Record<ProjectStatus, number> {
  const c: Record<ProjectStatus, number> = { active: 0, shipped: 0, "in-progress": 0, draft: 0 };
  for (const i of items) c[i.status]++;
  return c;
}

/** Live per-type (application-architecture) counts — the rail's Type facet badges (#3802). */
export function typeCounts(items: ProjectItem[]): Record<AppType, number> {
  const c = Object.fromEntries(APP_TYPES.map((k) => [k, 0])) as Record<AppType, number>;
  for (const i of items) c[i.appType]++;
  return c;
}

export interface FilterProjectsArgs {
  query: string;
  /** Selected status facet values; empty ⇒ all statuses. */
  statusSel: Set<ProjectStatus>;
  /** Selected type (application-architecture) facet values; empty ⇒ all types. */
  typeSel?: Set<AppType>;
  sort: SortKey;
}

/** Apply the Status + Type facets (OR within a facet, AND across facets), the free-text query
 *  (title · description · key · repos), then sort. Returns a fresh array; `items` is never mutated. */
export function filterProjects(items: ProjectItem[], { query, statusSel, typeSel, sort }: FilterProjectsArgs): ProjectItem[] {
  const q = query.trim().toLowerCase();
  let pool = items;
  if (statusSel.size) pool = pool.filter((i) => statusSel.has(i.status));
  if (typeSel && typeSel.size) pool = pool.filter((i) => typeSel.has(i.appType));
  if (q) pool = pool.filter((i) => (i.title + " " + i.description + " " + i.key + " " + i.repos.join(" ")).toLowerCase().includes(q));
  return [...pool].sort((a, b) =>
    sort === "name" ? a.title.toLowerCase().localeCompare(b.title.toLowerCase()) : b.updatedAt - a.updatedAt,
  );
}
