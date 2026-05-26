// Iteration burn-down, computed from a GitHub Projects V2 Iteration field +
// Status single-select + item close timestamps. Pure + unit-tested; the card and
// data hook live in ProjectsSummary.tsx.

const DAY = 86400000;

/** A Projects V2 iteration (from the Iteration field's configuration). */
export interface BurndownIteration {
  id: string;
  title: string;
  startDate: string; // "YYYY-MM-DD"
  duration: number;  // days
}

/** An item scoped to the iteration: when it closed (if it did) and whether it's done now. */
export interface BurndownItem {
  closedAt: string | null; // ISO timestamp, or null if still open
  done: boolean;           // closed OR Status == "Done"
}

export interface BurndownSeries {
  total: number;
  remaining: number;          // not-done items right now (closed OR Status=Done)
  daysTotal: number;
  daysElapsed: number;        // clamped to [0, daysTotal]
  ideal: number[];            // length daysTotal + 1
  actual: (number | null)[];  // length daysTotal + 1; null after today
  onTrack: boolean;           // remaining <= ideal at today
}

/** Outcome of resolving a project's iteration burn-down. */
export type BurndownResult =
  | { status: "no-field" }
  | { status: "no-active-iteration"; projectTitle: string }
  | { status: "ready"; projectTitle: string; iterationTitle: string; series: BurndownSeries };

// ── GraphQL response shapes (Projects V2) ──────────────────────────────────────

interface ProjectFieldNode {
  __typename: string;
  name?: string;
  configuration?: { iterations?: BurndownIteration[]; completedIterations?: BurndownIteration[] };
  options?: Array<{ id: string; name: string }>;
}
interface ItemFieldValueNode {
  __typename: string;
  iterationId?: string;
  name?: string;
  field?: { name?: string };
}
interface ProjectItemNode {
  content: { closed?: boolean; closedAt?: string | null } | null;
  fieldValues?: { nodes?: ItemFieldValueNode[] };
}
export interface ProjectIterationNode {
  title: string;
  fields?: { nodes?: ProjectFieldNode[] };
  items?: { nodes?: ProjectItemNode[] };
}

/** Local-midnight epoch ms for an iteration's startDate. */
function startMs(startDate: string): number {
  return new Date(`${startDate}T00:00:00`).getTime();
}

/**
 * The iteration whose `[start, start + duration)` window contains `now`, or null
 * when today falls in a break / before the first / after the last iteration.
 */
export function findCurrentIteration(iterations: BurndownIteration[], now: number): BurndownIteration | null {
  for (const it of iterations) {
    const s = startMs(it.startDate);
    if (now >= s && now < s + Math.max(1, it.duration) * DAY) return it;
  }
  return null;
}

/**
 * Burn-down series for an iteration. The ideal line falls linearly from `total`
 * to 0 over the iteration's days. The actual line, for each elapsed day d, is
 * `total − (items closed by end of day d)`; days after today are null and today's
 * point is anchored to the live `remaining` (so Status=Done-but-open items are
 * reflected at the tip even though they can't bend the historical curve).
 */
export function computeBurndown(iteration: BurndownIteration, items: BurndownItem[], now: number): BurndownSeries {
  const daysTotal = Math.max(1, Math.round(iteration.duration));
  const start = startMs(iteration.startDate);
  const daysElapsed = Math.max(0, Math.min(daysTotal, Math.floor((now - start) / DAY)));
  const total = items.length;
  const remaining = items.filter((i) => !i.done).length;
  const closedMs = items
    .map((i) => (i.closedAt ? new Date(i.closedAt).getTime() : null))
    .filter((t): t is number => t != null);

  const ideal: number[] = [];
  const actual: (number | null)[] = [];
  for (let d = 0; d <= daysTotal; d++) {
    ideal.push(Math.round(total * (1 - d / daysTotal)));
    if (d < daysElapsed) {
      const closedByEod = closedMs.filter((t) => t < start + (d + 1) * DAY).length;
      actual.push(Math.max(0, total - closedByEod));
    } else if (d === daysElapsed) {
      actual.push(remaining); // anchor today's point to the live remaining count
    } else {
      actual.push(null);
    }
  }

  return { total, remaining, daysTotal, daysElapsed, ideal, actual, onTrack: remaining <= (ideal[daysElapsed] ?? 0) };
}

/**
 * Resolve a Projects V2 node into a burn-down result: find the Iteration field's
 * current iteration and the "Status" single-select, scope items to that iteration,
 * and compute the series. Returns a `no-field` / `no-active-iteration` status when
 * the project has no Iteration field or today isn't inside an iteration.
 */
export function parseProjectIteration(node: ProjectIterationNode | null, now: number): BurndownResult {
  if (!node) return { status: "no-field" };
  const fields = node.fields?.nodes ?? [];
  const iterField = fields.find((f) => f.__typename === "ProjectV2IterationField" && f.configuration);
  if (!iterField) return { status: "no-field" };
  const statusField = fields.find(
    (f) => f.__typename === "ProjectV2SingleSelectField" && (f.name ?? "").toLowerCase() === "status",
  );

  const current = findCurrentIteration(iterField.configuration?.iterations ?? [], now);
  if (!current) return { status: "no-active-iteration", projectTitle: node.title };

  const items: BurndownItem[] = [];
  for (const item of node.items?.nodes ?? []) {
    const fvs = item.fieldValues?.nodes ?? [];
    const iterVal = fvs.find(
      (v) => v.__typename === "ProjectV2ItemFieldIterationValue" && (v.field?.name ?? "") === iterField.name,
    );
    if (!iterVal || iterVal.iterationId !== current.id) continue; // only items in the current iteration
    const statusVal = fvs.find(
      (v) =>
        v.__typename === "ProjectV2ItemFieldSingleSelectValue" &&
        (!statusField || (v.field?.name ?? "").toLowerCase() === "status"),
    );
    const closed = !!item.content?.closed;
    items.push({
      closedAt: item.content?.closedAt ?? null,
      done: closed || (statusVal?.name ?? "").toLowerCase() === "done",
    });
  }

  return { status: "ready", projectTitle: node.title, iterationTitle: current.title, series: computeBurndown(current, items, now) };
}
