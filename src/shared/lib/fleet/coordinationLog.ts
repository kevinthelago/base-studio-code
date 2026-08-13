// -- Event ingestion (#199 slice 2) ---------------------------------------------
// The `bsc-*` coordination emitters (`src-tauri/data/shell/coord-emit.sh`) each append one TSV line to
// $BSC_COORD_LOG: `bsc-wait` (paused for the user), `bsc-ask`/`bsc-answer`, `bsc-issue`/`bsc-assign`,
// `bsc-brief`, and the completion set `bsc-landed`/`merged`/`closed`/`failed`, which is what satisfies a
// latch. `parseCoordLine` turns one line into a typed event, `applyCoordEvent` folds it into the latch
// state, and `ingestCoordLog` replays a whole log -- so the coordinator is just "read the log ->
// CoordState".
//
// The `blocked` kind has had NO emitter since #1039 removed runtime dependency-wait, and it got no
// replacement: `dependsOn` is a planning-time hint, enforced at LAUNCH by `streamGate.ts`, and a started
// worker never parks on an upstream. Parsing it stays so a log written before then still replays.
import type {
  CoordRef,
  Waiter,
  CoordState,
  AssignedWork,
  AnsweredWake,
  CoordEvent,
  CrossProjectRefusal,
} from "./coordination.types";
import { emptyCoordState, parseRef, registerWaiter, satisfy, fail } from "./coordinationState";

/**
 * Parse one TSV `$BSC_COORD_LOG` line into an event, or null if unrecognized.
 * Columns: `ts \t session \t kind \t <payload…>`.
 * - blocked: payload = `<comma-refs> \t <checkpoint?>`
 * - landed/merged/closed: payload = `<ref>`
 * - failed: payload = `<ref> \t <reason>`
 */
/**
 * The PROJECT a pane belongs to. Pane identity is `<projectKey>:<stream>` (paneIdentity.ts), so the
 * scope is already on the wire — this only reads it.
 *
 * A pane id with no colon (a bare or malformed id) yields the whole string — see
 * {@link sameCoordProject} for how an unplaceable id is then treated at delivery.
 */
export function coordProjectOf(paneId: string): string {
  const i = paneId.indexOf(":");
  return i < 0 ? paneId : paneId.slice(0, i);
}

/**
 * May `from` direct `target`? Only within one project.
 *
 * `coord.log` is ONE app-wide file and every consumer replays the whole tail, so before this a
 * director in project A could answer a worker in project B — and the instruction arrived through the
 * same trusted channel the worker's real director uses, with nothing in-band to tell them apart. Two
 * workers caught it only because the content named an unfamiliar repo.
 */
export function sameCoordProject(from: string, target: string): boolean {
  const a = coordProjectOf(from);
  const b = coordProjectOf(target);
  // REFUSE ONLY ON PROOF OF CROSSING. A pane id with no `:` cannot be placed in a project — the
  // retired positional ids (`t0p2`, #1176) and any bare id look like this — and refusing what we
  // cannot place would break single-project coordination that never used prefixed ids, which the
  // item explicitly requires to be unchanged. So an unplaceable id is ALLOWED: we only refuse when
  // both sides name a project and the projects differ.
  //
  // The residual is deliberate and worth stating: a bare-id target is reachable from any project.
  // That is strictly no worse than before this change, and prefixed ids are what the app mints now,
  // so the real fleet is covered. Tightening it means retiring bare ids, not tightening this rule.
  if (a === from || b === target) return true;
  return a === b;
}

export function parseCoordLine(line: string): CoordEvent | null {
  const cols = line.replace(/\r?\n$/, "").split("\t");
  if (cols.length < 4) return null;
  const [ts, session, kind, ...rest] = cols;
  const parsed = Date.parse(ts);
  const at = Number.isFinite(parsed) ? parsed : 0;
  switch (kind) {
    case "blocked": {
      const deps = (rest[0] ?? "").split(",").map(parseRef).filter((r): r is CoordRef => r !== null);
      if (deps.length === 0) return null;
      const checkpoint = rest[1]?.trim() || undefined;
      return { type: "blocked", session, deps, checkpoint, at };
    }
    case "landed":
    case "merged":
    case "closed": {
      const ref = parseRef(rest[0] ?? "");
      return ref ? { type: kind as "landed" | "merged" | "closed", ref, at } : null;
    }
    case "failed": {
      const ref = parseRef(rest[0] ?? "");
      return ref ? { type: "failed", ref, reason: rest[1] ?? "", at } : null;
    }
    case "waiting":
      return { type: "waiting", session, reason: rest[0] ?? "", checkpoint: rest[1]?.trim() || undefined, at };
    case "ask":
      return { type: "ask", session, question: rest[0] ?? "", checkpoint: rest[1]?.trim() || undefined, at };
    // #4106: emitted by the `bsc-fork` PreToolUse hook, so it lands whether or not the spawning
    // session chose to announce itself — the visibility cannot depend on the forker's cooperation.
    case "fork": {
      const description = (rest[0] ?? "").trim();
      return description
        ? { type: "fork", session, description, subagentType: rest[1]?.trim() || undefined, at }
        : null;
    }
    case "answer": {
      const target = (rest[0] ?? "").trim();
      // `session` is the EMITTER — carried as `from` since
      // #coord-log-is-app-wide-answers-cross-projects, because delivery has to compare its project
      // with the target's. `brief` already carried its emitter for the same reason.
      return target ? { type: "answer", from: session, target, answer: rest[1] ?? "", at } : null;
    }
    // #4001: `bsc plan request new|resolve` emit these from the CLI (not a shell helper) because the
    // notification has to carry the id the store just assigned. payload = <id> TAB <text|note>.
    case "request": {
      const id = (rest[0] ?? "").trim();
      return id ? { type: "request", session, id, text: rest[1] ?? "", at } : null;
    }
    case "request-resolved": {
      const id = (rest[0] ?? "").trim();
      return id ? { type: "request-resolved", id, at } : null;
    }
    case "issue": {
      // payload = <title> \t <body?> \t <suggested?> \t <id?>
      const title = (rest[0] ?? "").trim();
      if (!title) return null;
      const id = rest[3]?.trim() || `${session}@${at}`;
      return { type: "issue", session, id, title, body: rest[1]?.trim() || undefined, suggested: rest[2]?.trim() || undefined, at };
    }
    case "assign": {
      // payload = <target> \t <body> \t <issueId?> \t <title?>
      const target = (rest[0] ?? "").trim();
      if (!target) return null;
      return { type: "assign", session, target, body: rest[1] ?? "", issueId: rest[2]?.trim() || undefined, title: rest[3]?.trim() || undefined, at };
    }
    case "maintain":
      return { type: "maintain", session, note: rest[0]?.trim() || undefined, at };
    case "brief": {
      // payload = <target> \t <body> \t <ref?>. The `session` column is the emitter (the
      // planner's pane). `from` mirrors it; `id` (`<from>@<at>`) dedupes a replayed log.
      const target = (rest[0] ?? "").trim();
      if (!target) return null;
      const body = rest[1] ?? "";
      if (!body.trim()) return null;
      const ref = parseRef(rest[2] ?? "") ?? undefined;
      return { type: "brief", from: session, target, body, ref, id: `${session}@${at}`, at };
    }
    case "commission": {
      // payload = <target> \t <body> \t <ref?> (mirrors `brief`, #2940). The `session` column is
      // the requesting studio pane; `id` (`<from>@<at>`) is what a `deliver` references back.
      const target = (rest[0] ?? "").trim();
      if (!target) return null;
      const body = rest[1] ?? "";
      if (!body.trim()) return null;
      const ref = parseRef(rest[2] ?? "") ?? undefined;
      return { type: "commission", from: session, target, body, ref, id: `${session}@${at}`, at };
    }
    case "deliver": {
      // payload = <commissionId> \t <artifactId>. The `session` column is the delivering studio.
      const commissionId = (rest[0] ?? "").trim();
      const artifactId = (rest[1] ?? "").trim();
      if (!commissionId || !artifactId) return null;
      return { type: "deliver", commissionId, artifactId, from: session, at };
    }
    case "verdict": {
      // payload = <target> \t <pass|reject> \t <reason?> \t <relevant?>; the juror is the session column.
      const target = (rest[0] ?? "").trim();
      const v = (rest[1] ?? "").trim().toLowerCase();
      if (!target || (v !== "pass" && v !== "reject")) return null;
      const relevant = rest[3] === undefined ? undefined : rest[3].trim() !== "false" && rest[3].trim() !== "0";
      return { type: "verdict", juror: session, target, verdict: v, reason: rest[2]?.trim() || undefined, relevant, at };
    }
    case "woke":
      return { type: "woke", session, at };
    default:
      return null;
  }
}

/** Fold one event into the latch state, returning what it triggered. */
export function applyCoordEvent(s: CoordState, e: CoordEvent): {
  state: CoordState; woken: Waiter[]; ready: boolean; stalled: Waiter[]; answered: AnsweredWake[]; assigned: AssignedWork[]; refused?: CrossProjectRefusal[];
} {
  switch (e.type) {
    case "blocked": {
      const r = registerWaiter(s, { session: e.session, deps: e.deps, checkpoint: e.checkpoint, registeredAt: e.at });
      // A session that now declares a real dependency leaves the manual-wait list.
      const state = { ...r.state, waiting: r.state.waiting.filter((w) => w.session !== e.session) };
      return { state, woken: [], ready: r.ready, stalled: [], answered: [], assigned: [] };
    }
    case "waiting": {
      const waiting = [
        ...s.waiting.filter((w) => w.session !== e.session),
        { session: e.session, reason: e.reason, checkpoint: e.checkpoint, at: e.at },
      ];
      return { state: { ...s, waiting }, woken: [], ready: false, stalled: [], answered: [], assigned: [] };
    }
    case "landed":
    case "merged":
    case "closed": {
      const r = satisfy(s, e.ref, e.type, e.at);
      return { state: r.state, woken: r.woken, ready: false, stalled: [], answered: [], assigned: [] };
    }
    case "failed": {
      const r = fail(s, e.ref, e.reason, e.at);
      return { state: r.state, woken: [], ready: false, stalled: r.stalled, answered: [], assigned: [] };
    }
    case "woke": {
      // `maintaining` is carried (not cleared): once a worker enters maintenance it STAYS a
      // maintenance worker across dispatches — auto-end permanently skips it (that IS the mode).
      return { state: { latches: s.latches, waiters: s.waiters.filter((w) => w.session !== e.session), waiting: s.waiting.filter((w) => w.session !== e.session), asking: s.asking.filter((a) => a.session !== e.session), issues: s.issues, maintaining: s.maintaining, briefs: s.briefs, forks: s.forks, commissions: s.commissions, requests: s.requests }, woken: [], ready: false, stalled: [], answered: [], assigned: [] };
    }
    case "ask": {
      const asking = [
        ...s.asking.filter((a) => a.session !== e.session),
        { session: e.session, question: e.question, checkpoint: e.checkpoint, at: e.at },
      ];
      // Asking the director supersedes any prior user-wait registration for this session.
      const waiting = s.waiting.filter((w) => w.session !== e.session);
      return { state: { ...s, asking, waiting }, woken: [], ready: false, stalled: [], answered: [], assigned: [] };
    }
    case "answer": {
      // The director is addressing a specific worker — resume it whatever its park (an
      // ask, a dependency block, or a user-wait) and deliver the directive (#376). bsc-answer
      // is the director's universal "unblock + tell this worker" command, not just for asks.
      const ask = s.asking.find((a) => a.session === e.target);
      const waiter = s.waiters.find((w) => w.session === e.target);
      const waitS = s.waiting.find((w) => w.session === e.target);
      const checkpoint = ask?.checkpoint ?? waitS?.checkpoint ?? waiter?.checkpoint;
      // CROSS-PROJECT REFUSAL (#coord-log-is-app-wide-answers-cross-projects). The state is left
      // untouched as well as the delivery: clearing `asking`/`waiting` here would mark the worker as
      // answered by an actor with no authority over it, so its REAL director would then see nothing
      // outstanding and never reply.
      if (!sameCoordProject(e.from, e.target)) {
        return {
          state: s,
          woken: [], ready: false, stalled: [], answered: [], assigned: [],
          refused: [{ kind: "answer", from: e.from, target: e.target, at: e.at }],
        };
      }
      const answered: AnsweredWake[] = [{ session: e.target, answer: e.answer, checkpoint, at: e.at }];
      return {
        state: {
          ...s,
          asking: s.asking.filter((a) => a.session !== e.target),
          waiters: s.waiters.filter((w) => w.session !== e.target),
          waiting: s.waiting.filter((w) => w.session !== e.target),
        },
        woken: [], ready: false, stalled: [], answered, assigned: [],
      };
    }
    case "request": {
      // Dedup by id so a replayed log doesn't double it — the same guard `issue` uses.
      const requests = [
        ...s.requests.filter((r) => r.id !== e.id),
        { id: e.id, from: e.session, text: e.text, at: e.at },
      ];
      return { state: { ...s, requests }, woken: [], ready: false, stalled: [], answered: [], assigned: [] };
    }
    case "request-resolved": {
      // The director answered it. Removing it here is what lets the pump's surfaced-once guard be
      // PRUNED, so a later re-file of the same ask surfaces again rather than being suppressed
      // forever by a stale key.
      return {
        state: { ...s, requests: s.requests.filter((r) => r.id !== e.id) },
        woken: [], ready: false, stalled: [], answered: [], assigned: [],
      };
    }
    case "issue": {
      // The issuer captured new work — append it to the director's pending-issue
      // intake list (dedup by id so a replayed log doesn't double it).
      const issues = [
        ...s.issues.filter((i) => i.id !== e.id),
        { id: e.id, session: e.session, title: e.title, body: e.body, suggested: e.suggested, at: e.at },
      ];
      return { state: { ...s, issues }, woken: [], ready: false, stalled: [], answered: [], assigned: [] };
    }
    case "assign": {
      // The director routed an issue to a worker — resume that worker whatever its
      // park and inject the issue, and clear the matching pending issue from intake.
      const waiter = s.waiters.find((w) => w.session === e.target);
      const waitS = s.waiting.find((w) => w.session === e.target);
      const ask = s.asking.find((a) => a.session === e.target);
      const checkpoint = ask?.checkpoint ?? waitS?.checkpoint ?? waiter?.checkpoint;
      // Same refusal as `answer`, and for the stronger reason: an assign hands a worker WORK. Taking
      // an assignment from another project's director means building something for a plan, repo and
      // lane that actor has no authority over.
      if (!sameCoordProject(e.session, e.target)) {
        return {
          state: s,
          woken: [], ready: false, stalled: [], answered: [], assigned: [],
          refused: [{ kind: "assign", from: e.session, target: e.target, at: e.at }],
        };
      }
      const assigned: AssignedWork[] = [{ session: e.target, title: e.title, body: e.body, checkpoint, at: e.at }];
      return {
        state: {
          ...s,
          asking: s.asking.filter((a) => a.session !== e.target),
          waiters: s.waiters.filter((w) => w.session !== e.target),
          waiting: s.waiting.filter((w) => w.session !== e.target),
          issues: e.issueId ? s.issues.filter((i) => i.id !== e.issueId) : s.issues,
        },
        woken: [], ready: false, stalled: [], answered: [], assigned,
      };
    }
    case "maintain": {
      // A finished worker parks alive in maintenance (#1957). Replace any prior entry for it, and
      // drop it from waiting/asking — it's idle-ready, not waiting on a human. It stays maintaining
      // across dispatches, so `useWorkerAutoEnd` never nudges it to close.
      const maintaining = [
        ...s.maintaining.filter((m) => m.session !== e.session),
        { session: e.session, note: e.note ?? "", at: e.at },
      ];
      return {
        state: { ...s, maintaining, waiting: s.waiting.filter((w) => w.session !== e.session), asking: s.asking.filter((a) => a.session !== e.session) },
        woken: [], ready: false, stalled: [], answered: [], assigned: [],
      };
    }
    case "fork": {
      // Appended + deduped by id, like a brief: a replayed log must not multiply one fork. Never
      // auto-cleared — this records what a session DID, which does not stop being true.
      const forks = [...s.forks.filter((f) => f.id !== `${e.session}@${e.at}`), {
        id: `${e.session}@${e.at}`, session: e.session, description: e.description,
        subagentType: e.subagentType, at: e.at,
      }];
      return { state: { ...s, forks }, woken: [], ready: false, stalled: [], answered: [], assigned: [] };
    }
    case "brief": {
      // The planner pushed a mid-build plan update to the director/issuer (#2377). Append it
      // to the received-briefs list (dedup by id so a replayed log doesn't double it). Unlike
      // an ask/issue there is no consuming event that clears it — it's a standing record; the
      // director's surfacing is guarded once-per-pane by the pump, not by removal here.
      const briefs = [
        ...s.briefs.filter((b) => b.id !== e.id),
        { id: e.id, from: e.from, target: e.target, body: e.body, ref: e.ref, at: e.at },
      ];
      return { state: { ...s, briefs }, woken: [], ready: false, stalled: [], answered: [], assigned: [] };
    }
    case "commission": {
      // A studio session commissioned another for an artifact (#2940). Append to the open list
      // (dedup by id so a replayed log doesn't double it). Like a brief, no consuming event
      // removes it — a `deliver` sets `delivered`; the pump guards its once-per-commission routing.
      const commissions = [
        ...s.commissions.filter((c) => c.id !== e.id),
        { id: e.id, from: e.from, target: e.target, body: e.body, ref: e.ref, at: e.at },
      ];
      return { state: { ...s, commissions }, woken: [], ready: false, stalled: [], answered: [], assigned: [] };
    }
    case "deliver": {
      // The target studio delivered the authored artifact (#2940). Stamp `delivered` on the matching
      // commission so the pump surfaces the id back to the requester. An unmatched deliver (no open
      // commission for the id — e.g. a truncated log) is a no-op rather than an error.
      const commissions = s.commissions.map((c) =>
        c.id === e.commissionId ? { ...c, delivered: e.artifactId } : c,
      );
      return { state: { ...s, commissions }, woken: [], ready: false, stalled: [], answered: [], assigned: [] };
    }
    case "verdict":
      // Verdicts don't move the latch/waiter state — the foreman tallies them off the
      // log (see {@link tallyVerdicts} / {@link planJuryAction}) and emits the revert
      // (a `failed` event) when the panel rejects. So this fold is a no-op.
      return { state: s, woken: [], ready: false, stalled: [], answered: [], assigned: [] };
  }
}

/**
 * Replay a whole `$BSC_COORD_LOG` (oldest-first) into latch state, collecting the waiters
 * still awaiting wake in `ready` (became ready, no `woke` ack yet) -- the coordinator's
 * rebuild-from-disk. Unparseable lines are skipped.
 */
export function ingestCoordLog(lines: string[], initial: CoordState = emptyCoordState()): {
  state: CoordState; woken: Waiter[]; ready: Waiter[]; answered: AnsweredWake[]; assigned: AssignedWork[];
  /** Events refused because they crossed a project boundary
   *  (#coord-log-is-app-wide-answers-cross-projects). Surfaced rather than dropped so the sender can
   *  be told its answer never landed. */
  refused: CrossProjectRefusal[];
} {
  let state = initial;
  const woken: Waiter[] = [];
  // `pending`: waiters that became ready (all deps satisfied) and have NOT yet been
  // acknowledged by a `woke` event -- i.e. the ones still awaiting actuation. The woke
  // event is what makes the wake idempotent across polls + app restarts.
  const pending = new Map<string, Waiter>();
  // `answeredPending`: asking sessions the director has answered (#369) but that have not
  // yet acked with a `woke` — the ones still awaiting an auto-wake with the answer.
  const answeredPending = new Map<string, AnsweredWake>();
  // `assignedPending`: workers the director assigned new work (#376), awaiting injection.
  const assignedPending = new Map<string, AssignedWork>();
  const refused: CrossProjectRefusal[] = [];
  for (const line of lines) {
    const ev = parseCoordLine(line);
    if (!ev) continue;
    if (ev.type === "woke") {
      pending.delete(ev.session);
      answeredPending.delete(ev.session);
      assignedPending.delete(ev.session);
      state = applyCoordEvent(state, ev).state;
      continue;
    }
    const r = applyCoordEvent(state, ev);
    state = r.state;
    for (const w of r.woken) {
      woken.push(w);
      pending.set(w.session, w);
    }
    for (const a of r.answered) answeredPending.set(a.session, a);
    for (const a of r.assigned) assignedPending.set(a.session, a);
    if (r.refused) refused.push(...r.refused);
  }
  return {
    state, woken, ready: [...pending.values()],
    answered: [...answeredPending.values()], assigned: [...assignedPending.values()], refused,
  };
}
