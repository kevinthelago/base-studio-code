// The `bsc` command-surface catalog, and the two filters over it
// (`a-persona-declares-its-command-surfaces`, epic `epic-command-surfaces-are-nodes`).
//
// Pure and feature-agnostic, so BOTH consumers can reach it without crossing a boundary: the Glance
// drill (a feature) draws its band from one filter, and the session launch (the shell) builds each
// session's denies from the other. The reader that fills the store is `app/useSurfaceCatalogPoll`.
//
// THE TWO FILTERS ARE NOT INTERCHANGEABLE, and the difference is a security one rather than a matter
// of taste — see `deniableSurfaceNames`.

/** One row of `bsc surface list --json`, pared to what the app reads. `status` is
 *  `active` | `deprecated` | `internal`; ABSENT means active, because the catalog omits the field for
 *  the common case. */
export interface SurfaceRow {
  name: string;
  status?: string;
}

const isActive = (r: SurfaceRow): boolean => !r.status || r.status === "active";

/** Tolerate an ABSENT catalog, because both callers read it off a STORE SNAPSHOT.
 *
 *  `sessionDeniedCommands` takes an `AppStore` and the documented unit-test contract is a PARTIAL cast
 *  (see `mkStore` in the sessionLaunch tests), so the field can genuinely be `undefined` — and a throw
 *  there is not a failed filter, it is a session that cannot launch at all. A persisted state written
 *  before this field existed reaches the same path. Absent reads as EMPTY, which every consumer already
 *  treats as "unknown" and fails open on. */
const rowsOf = (rows: readonly SurfaceRow[] | null | undefined): readonly SurfaceRow[] => rows ?? [];

/**
 * The surfaces the Glance band DRAWS — active only.
 *
 * A deprecated alias is skipped because it and its live surface are ONE store: the catalog says so
 * itself (`bsc org` → "the same store `bsc teams` serves"), and drawing both would put two nodes on
 * one store and overstate the surface area. An `internal` row (`hook`, `serve`) is harness plumbing
 * rather than something an agent drives, so it is not a capability worth a node either.
 */
export function activeSurfaceNames(rows: readonly SurfaceRow[] | null | undefined): string[] {
  return rowsOf(rows).filter(isActive).map((r) => r.name);
}

/**
 * The surfaces the permission gate may DENY — active **and deprecated**.
 *
 * THE DEPRECATED ROWS ARE THE WHOLE POINT, and leaving them out is a bypass rather than an omission.
 * `bsc org` serves the store `bsc teams` serves, and `bsc component` the store `bsc ui` serves. So a
 * persona that declares neither `teams` nor `ui` still reaches both stores through the alias unless
 * the alias is denied too: the declaration would close the front door and leave the side door open.
 *
 * Aliases are denied UNCONDITIONALLY to a declaring persona, including one that declares the surface
 * the alias points at. The catalog records no alias→target mapping — only prose in `summary` — so
 * honouring one would mean parsing that prose, and the safe direction is the tighter one. A persona
 * that wants the teams store declares `teams` and runs `bsc teams`, which is what the deprecation
 * asks for anyway.
 *
 * INTERNAL rows are in NEITHER list. `bsc hook` is invoked by the PreToolUse hook mechanism itself and
 * `bsc serve` by the warm-serve path; denying them would break the machinery that enforces every other
 * deny — a self-inflicted outage, not a restriction.
 */
export function deniableSurfaceNames(rows: readonly SurfaceRow[] | null | undefined): string[] {
  return rowsOf(rows).filter((r) => isActive(r) || r.status === "deprecated").map((r) => r.name);
}
