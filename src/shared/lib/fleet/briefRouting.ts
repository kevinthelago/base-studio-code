// Brief routing (#brief-routes-to-its-target) — decide WHICH pane each `bsc-brief` is delivered to.
//
// The target was always on the wire. `bsc-brief <target>` writes it, `parseCoordLine` reads it back,
// `ReceivedBrief.target` documents it as "director, issuer, or a specific session id", and the fold
// carries it into `CoordState.briefs`. The one thing missing was a consumer: `useDirectorPump` looped
// over director-drive panes and injected every brief into each of them, so a director briefing a
// worker briefed itself and the worker never heard.
//
// This is the pure decision half, modelled on `studioNetworkDrive`'s `authorInjections` — the pump
// stays a thin actuator. Free of React/Tauri so the routing table is unit-testable on its own.

import type { ReceivedBrief } from "@/shared/lib/fleet/coordination.types";

export interface BriefRouteContext {
  /** Panes launched with a director drive — the `director` audience, and where an undeliverable
   *  brief is reported (the director is the actor that can do something about it). */
  directorPanes: string[];
  /** Every pane the app currently has a status for. This is the REACHABLE set: a target that
   *  resolves to nothing here has no session to receive it. */
  knownPanes: string[];
  /** `<paneId>|<key>` entries already injected. */
  surfaced: ReadonlySet<string>;
  /** A pane's session ROLE, for the tier constraint below. Optional so every existing caller and
   *  fixture keeps working unchanged — absent ⇒ no sender is treated as an architect. */
  roleOf?: (paneId: string) => string | undefined;
}

/** The broadcast audiences — every other target names one specific session. */
const DIRECTOR = "director";
const ISSUER = "issuer";

/**
 * Stable per-brief key. **Includes the target**, unlike the original `<from>@<at>`: two briefs sent
 * by one session in the same millisecond to different targets shared a key under the old scheme, so
 * the second was suppressed as already-surfaced and silently never delivered.
 */
export function briefRouteKey(b: Pick<ReceivedBrief, "from" | "at" | "target">): string {
  return `${b.from}@${b.at}@${b.target || DIRECTOR}`;
}

/**
 * Resolve a brief's `target` to the panes that should receive it.
 *
 * Order matters — most specific first, so a project that happens to name a stream "director" cannot
 * hijack the broadcast audience:
 *  1. an EXACT pane id (`studio-code:security`) — what a director reaching one worker writes;
 *  2. a bare stream id (`security`) — resolved by suffix against the known panes, since a pane id is
 *     `<projectKey>:<stream>` and a session addressing a sibling stream has no reason to know the key;
 *  3. `director` / `issuer` — the two broadcast audiences.
 * Anything else resolves to nothing, which the caller reports rather than drops.
 */
export function resolveBriefTarget(target: string, ctx: BriefRouteContext): string[] {
  const t = (target || "").trim();
  if (!t) return ctx.directorPanes;                                  // untargeted ⇒ the old behaviour
  if (ctx.knownPanes.includes(t)) return [t];                        // 1 · exact pane id
  const bySuffix = ctx.knownPanes.filter((p) => p.endsWith(`:${t}`));
  if (bySuffix.length > 0) return bySuffix;                          // 2 · bare stream id
  if (t === DIRECTOR) return ctx.directorPanes;                      // 3 · broadcast audiences
  if (t === ISSUER) return ctx.knownPanes.filter((p) => p.endsWith(`:${ISSUER}`));
  return [];
}

// THE PROMPT ASSEMBLY IS GONE (#coord-prefix-names-the-sender). `briefInjections` and the three
// prompt builders it fed built `[coordinator] ...` strings for a pump that no longer exists — the app
// does not write into a session's stdin at all now, so they were computed by nothing and delivered to
// nobody. `resolveBriefTarget` + `briefRouteKey` survive because they answer routing questions, not
// delivery ones.
//
// CARRY THIS FORWARD IF BRIEF DELIVERY IS EVER REBUILT — it was a rule, not an implementation detail
// (#funnel-generalize-brief-channel), and its only enforcement site went with the deleted function:
//
//   An ARCHITECT reaches DIRECTORS, and nothing else. Apply it to the resolved pane set by
//   INTERSECTING with the director panes, never by replacing them with every director: a
//   `bsc-brief <project>:director` from an architect must still reach exactly that one director, so a
//   targeted brief stays targeted. An architect naming a WORKER resolves to that worker, intersects
//   to empty, and must be reported UNDELIVERABLE — refused loudly, never silently re-routed to a
//   director, which would look like it worked while quietly crossing the tier boundary.
