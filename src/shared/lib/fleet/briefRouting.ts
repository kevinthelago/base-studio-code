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

import type { ReceivedBrief, CoordRef } from "./coordination.types";

/** One delivery: the pane, the prose, and every once-guard key the injection covers. */
export interface BriefInjection {
  paneId: string;
  prompt: string;
  /** `<paneId>|<key>` entries the pump records after injecting. Plural because one message carries
   *  every brief queued for that pane, and each brief needs its OWN guard — sharing one key would let
   *  a later brief be suppressed by an earlier one's guard. */
  keys: string[];
}

export interface BriefRouteContext {
  /** Panes launched with a director drive — the `director` audience, and where an undeliverable
   *  brief is reported (the director is the actor that can do something about it). */
  directorPanes: string[];
  /** Every pane the app currently has a status for. This is the REACHABLE set: a target that
   *  resolves to nothing here has no session to receive it. */
  knownPanes: string[];
  /** `<paneId>|<key>` entries already injected. */
  surfaced: ReadonlySet<string>;
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

/** Short label for a ref, for the injected prose. */
function refLabel(ref: CoordRef): string {
  switch (ref.kind) {
    case "issue":     return `#${ref.number}`;
    case "contract":  return `contract:${ref.name}`;
    case "file":      return `file:${ref.path}`;
    case "predicate": return `predicate:${ref.expr}`;
    case "session":   return `session:${ref.id}`;
  }
}

function describe(b: ReceivedBrief): string {
  return `"${b.body}"${b.ref ? ` [${refLabel(b.ref)}]` : ""}`;
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

/** The prose a DIRECTOR gets: reconcile the plan and route the work onward. Unchanged in substance
 *  from the original `pendingBriefPrompt` — this audience's job did not change. */
export function directorBriefPrompt(briefs: ReceivedBrief[]): string {
  return `[coordinator] ${briefs.length} plan update(s) pushed to you: ${briefs.map(describe).join("; ")}. ` +
    `Reconcile the running plan with each: update the board/issues to match, and route any new or changed ` +
    `work to the owning worker with bsc-assign (open a fresh issue via bsc-issue first when a brief ` +
    `introduces a new #ref). Do not ask the user.`;
}

/** The prose a TARGETED session gets. Deliberately different from the director's: a worker cannot
 *  route work onward, has no board to reconcile, and must not be told to run `bsc-assign`. */
export function targetedBriefPrompt(briefs: ReceivedBrief[], from: string): string {
  return `[coordinator] ${from || "another session"} sent you ${briefs.length} update(s): ` +
    `${briefs.map(describe).join("; ")}. This is authoritative context for YOUR lane, not a question — ` +
    `there is nothing to answer. Fold it into what you are building: if it changes your current work, ` +
    `adjust and note why with bsc-note; if it introduces work outside your owned globs, do NOT take it ` +
    `— reply to the sender with bsc-ask so it can be routed to the stream that owns it.`;
}

/** The prose the DIRECTOR gets when a brief named a target with no reachable session. Reported rather
 *  than dropped: a silently-swallowed brief is indistinguishable from one nobody acted on. */
export function undeliverableBriefPrompt(briefs: ReceivedBrief[]): string {
  const list = briefs.map((b) => `${describe(b)} → target "${b.target}"`).join("; ");
  return `[coordinator] ${briefs.length} brief(s) could NOT be delivered — no running session matches ` +
    `the target: ${list}. Either the stream is not launched (bring it back with \`bsc fleet wake ` +
    `<pane-id>\`, then re-send) or the target name is wrong (\`bsc fleet list\` shows the real pane ids). ` +
    `Do not assume the recipient saw it.`;
}

/**
 * Compute every due brief injection. Pure: the caller performs them and records each `key`.
 *
 * Briefs are grouped per destination pane so a session that receives three at once gets one message,
 * matching how the ask/request surfacing already batches.
 */
export function briefInjections(briefs: ReceivedBrief[], ctx: BriefRouteContext): BriefInjection[] {
  const perPane = new Map<string, ReceivedBrief[]>();
  const undeliverable: ReceivedBrief[] = [];

  for (const b of briefs) {
    const panes = resolveBriefTarget(b.target, ctx);
    if (panes.length === 0) {
      // Guard the REPORT on the director panes, so an undeliverable brief is announced once and not
      // re-announced every tick for as long as it sits in the log (a brief is never consumed).
      if (ctx.directorPanes.some((p) => !ctx.surfaced.has(`${p}|undeliverable:${briefRouteKey(b)}`))) {
        undeliverable.push(b);
      }
      continue;
    }
    for (const p of panes) {
      if (ctx.surfaced.has(`${p}|${briefRouteKey(b)}`)) continue;
      perPane.set(p, [...(perPane.get(p) ?? []), b]);
    }
  }

  const out: BriefInjection[] = [];
  for (const [paneId, group] of perPane) {
    const prompt = ctx.directorPanes.includes(paneId)
      ? directorBriefPrompt(group)
      : targetedBriefPrompt(group, group[0].from);
    out.push({ paneId, prompt, keys: group.map((b) => `${paneId}|${briefRouteKey(b)}`) });
  }

  for (const p of ctx.directorPanes) {
    const fresh = undeliverable.filter((b) => !ctx.surfaced.has(`${p}|undeliverable:${briefRouteKey(b)}`));
    if (fresh.length === 0) continue;
    out.push({
      paneId: p,
      prompt: undeliverableBriefPrompt(fresh),
      keys: fresh.map((b) => `${p}|undeliverable:${briefRouteKey(b)}`),
    });
  }
  return out;
}
