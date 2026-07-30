import { describe, it, expect } from "vitest";
import {
  normalizeDirectorDrive, resolveDirectorDrive, decideDirectorAction,
  eventDirectorPrompt, DEFAULT_DIRECTOR_DRIVE, askKey, pendingAskPrompt,
  briefKey, pendingBriefPrompt, requestKey, pendingRequestPrompt, heartbeatDirectorPrompt, shouldRemind, idleReminderPrompt, ASK_REMINDER_MS, DEFAULT_HEARTBEAT_MS } from "./directorDrive";

const TS = "2026-06-01T00:00:00Z";
const line = (session: string, kind: string, a = "", b = "") => `${TS}	${session}	${kind}	${a}	${b}`;
const HB = 600_000;
const CD = 6_000;

describe("normalizeDirectorDrive", () => {
  it("accepts the four canonical modes", () => {
    for (const v of ["event", "heartbeat", "manual", "off"] as const) {
      expect(normalizeDirectorDrive(v)).toBe(v);
    }
  });
  it("maps the event-driven alias to event", () => {
    expect(normalizeDirectorDrive("event-driven")).toBe("event");
    expect(normalizeDirectorDrive("EVENT-DRIVEN")).toBe("event");
  });
  it("falls back to the default for junk / non-strings", () => {
    expect(normalizeDirectorDrive("nonsense")).toBe(DEFAULT_DIRECTOR_DRIVE);
    expect(normalizeDirectorDrive(undefined)).toBe(DEFAULT_DIRECTOR_DRIVE);
    expect(normalizeDirectorDrive(42)).toBe(DEFAULT_DIRECTOR_DRIVE);
  });
  it("resolveDirectorDrive applies the default when unset", () => {
    expect(resolveDirectorDrive(undefined)).toBe(DEFAULT_DIRECTOR_DRIVE);
    expect(resolveDirectorDrive("off")).toBe("off");
  });
});

const base = { now: 1_000_000, lastInjectAt: 0, heartbeatMs: HB, cooldownMs: CD };

describe("decideDirectorAction — off / manual", () => {
  it("never injects and consumes the log", () => {
    const lines = [line("w1", "landed", "#42")];
    for (const drive of ["off", "manual"] as const) {
      const r = decideDirectorAction({ lines, cursor: 0, drive, idle: true, ...base });
      expect(r.inject).toBeNull();
      expect(r.cursor).toBe(1);
    }
  });
});

describe("decideDirectorAction — heartbeat", () => {
  it("injects when idle and the interval has elapsed", () => {
    const r = decideDirectorAction({ lines: [], cursor: 0, drive: "heartbeat", idle: true, now: 1_000_000, lastInjectAt: 1_000_000 - HB, heartbeatMs: HB, cooldownMs: CD });
    expect(r.inject).toContain("Heartbeat");
    expect(r.lastInjectAt).toBe(1_000_000);
  });
  it("does not inject when the director is busy", () => {
    const r = decideDirectorAction({ lines: [], cursor: 0, drive: "heartbeat", idle: false, now: 1_000_000, lastInjectAt: 0, heartbeatMs: HB, cooldownMs: CD });
    expect(r.inject).toBeNull();
  });
  it("does not inject again within the interval", () => {
    const r = decideDirectorAction({ lines: [], cursor: 0, drive: "heartbeat", idle: true, now: 1_000_000, lastInjectAt: 1_000_000 - 1000, heartbeatMs: HB, cooldownMs: CD });
    expect(r.inject).toBeNull();
  });
});

describe("decideDirectorAction — event-driven", () => {
  it("injects on a new relevant event when idle and past cooldown", () => {
    const lines = [line("w1", "landed", "#42"), line("w2", "blocked", "contract:DBSchema")];
    const r = decideDirectorAction({ lines, cursor: 0, drive: "event", idle: true, now: 1_000_000, lastInjectAt: 0, heartbeatMs: HB, cooldownMs: CD });
    expect(r.inject).toContain("landed");
    expect(r.inject).toContain("#42");
    expect(r.cursor).toBe(2);
    expect(r.lastInjectAt).toBe(1_000_000);
  });
  it("holds the cursor (retries) when the director is busy", () => {
    const lines = [line("w1", "landed", "#42")];
    const r = decideDirectorAction({ lines, cursor: 0, drive: "event", idle: false, ...base });
    expect(r.inject).toBeNull();
    expect(r.cursor).toBe(0); // unconsumed so it retries when idle
  });
  it("holds within the cooldown even when idle", () => {
    const lines = [line("w1", "landed", "#42")];
    const r = decideDirectorAction({ lines, cursor: 0, drive: "event", idle: true, now: 1_000_000, lastInjectAt: 1_000_000 - 1000, heartbeatMs: HB, cooldownMs: CD });
    expect(r.inject).toBeNull();
    expect(r.cursor).toBe(0);
  });
  it("ignores the director own merge/wake events (consumes, no inject)", () => {
    const lines = [line("dir", "merged", "#42"), line("dir", "woke", "")];
    const r = decideDirectorAction({ lines, cursor: 0, drive: "event", idle: true, ...base });
    expect(r.inject).toBeNull();
    expect(r.cursor).toBe(2);
  });
  it("does nothing when there are no fresh lines", () => {
    const lines = [line("w1", "landed", "#42")];
    const r = decideDirectorAction({ lines, cursor: 1, drive: "event", idle: true, ...base });
    expect(r.inject).toBeNull();
    expect(r.cursor).toBe(1);
  });
});

describe("eventDirectorPrompt", () => {
  it("summarizes landed/blocked/waiting/failed and carries the action", () => {
    const lines = ["landed #1", "landed #2", "blocked alpha", "waiting beta", "failed #9"];
    void lines;
    const p = eventDirectorPrompt([
      { type: "landed", ref: { kind: "issue", number: 1 }, at: 0 },
      { type: "blocked", session: "alpha", deps: [{ kind: "contract", name: "DB" }], at: 0 },
      { type: "waiting", session: "beta", reason: "confirm?", at: 0 },
      { type: "failed", ref: { kind: "issue", number: 9 }, reason: "x", at: 0 },
    ]);
    expect(p).toContain("1 landed (#1)");
    expect(p).toContain("blocked");
    expect(p).toContain("alpha on contract:DB");
    expect(p).toContain("waiting");
    expect(p).toContain("bsc-merged");
  });
});


describe("director Q&A surfacing (#369, state-based)", () => {
  const TAB = String.fromCharCode(9);
  const askLine = (sess: string, q: string) => ["2026-06-01T00:00:00Z", sess, "ask", q, ""].join(TAB);

  it("does NOT surface an ask via the cursor path (handled state-based by the pump)", () => {
    const r = decideDirectorAction({
      lines: [askLine("w1", "API shape?")], cursor: 0, drive: "event", idle: true,
      now: 1_000_000, lastInjectAt: 0, heartbeatMs: 600_000, cooldownMs: 6_000,
    });
    expect(r.inject).toBeNull();   // an ask is not a landed/blocked/failed notification
    expect(r.cursor).toBe(1);      // consumed, nothing to notify
  });

  it("askKey is stable per session + timestamp", () => {
    expect(askKey({ session: "w1", at: 5 })).toBe("w1@5");
  });

  it("pendingAskPrompt lists each question with its bsc-answer instruction", () => {
    const p = pendingAskPrompt([
      { session: "w1", question: "tabs or spaces?", at: 1 },
      { session: "w2", question: "which db?", at: 2 },
    ]);
    expect(p).toContain('w1 asks: "tabs or spaces?"');
    expect(p).toContain("bsc-answer w1");
    expect(p).toContain("bsc-answer w2");
    expect(p).toMatch(/awaiting your answer/);
  });
});

describe("planner brief surfacing (#2377, state-based)", () => {
  it("briefKey is stable per planner + timestamp", () => {
    expect(briefKey({ from: "planner", at: 7 })).toBe("planner@7");
  });

  it("pendingBriefPrompt surfaces each plan update, names a carried ref, and routes onward via bsc-assign", () => {
    const p = pendingBriefPrompt([
      { id: "planner@1", from: "planner", target: "director", body: "add CSV export", at: 1 },
      { id: "planner@2", from: "planner", target: "director", body: "re-sequence auth", ref: { kind: "issue", number: 77 }, at: 2 },
    ]);
    expect(p).toContain("add CSV export");
    expect(p).toContain("re-sequence auth");
    expect(p).toContain("#77");                 // the carried ref is named
    expect(p).toContain("bsc-assign");          // director routes the work onward
    expect(p).toMatch(/plan update/);
    expect(p).toMatch(/Do not ask the user/);
  });
});

describe("pendingRequestPrompt / requestKey (#4001)", () => {
  const req = (id: string, from: string, text: string) => ({ id, from, text, at: 1 });

  it("keys on the row id, not session+time", () => {
    // The id is what `request-resolved` carries, so keying on it is what makes the pump's
    // surfaced-once guard prune exactly when the request is answered. A session@time key would
    // never match the resolve event and would suppress the ask forever.
    expect(requestKey({ id: "7" })).toBe("req:7");
    expect(requestKey({ id: "7" })).not.toBe(requestKey({ id: "8" }));
  });

  it("names both of the director's moves, and the escalation verb", () => {
    const p = pendingRequestPrompt([req("7", "cli-platform", "no develop branch")]);
    expect(p).toContain("#7");
    expect(p).toContain("cli-platform");
    expect(p).toContain("no develop branch");
    // Resolve — with the note, which is the answer the worker reads back.
    expect(p).toContain("bsc plan request resolve");
    expect(p).toContain("--note");
    // Escalate — the director is the ONLY sanctioned path from the project lane to the tooling
    // queue (#4000), so the prompt has to say the verb or the two-lane design has no exit.
    expect(p).toContain("bsc request new");
    // And it must not punt to the user; that is what leaves requests rotting.
    expect(p).toContain("Do not ask the user");
  });

  it("lists every open request in one injection", () => {
    // One injection per pane per tick — so a batch must carry all of them, not just the first.
    const p = pendingRequestPrompt([req("1", "a", "first"), req("2", "b", "second")]);
    expect(p).toContain("#1");
    expect(p).toContain("#2");
    expect(p).toContain("2 worker change-request(s)");
  });

  it("survives a request with no requester", () => {
    // `from` defaults to $BSC_STREAM, which is unset for a non-fleet session.
    expect(pendingRequestPrompt([req("3", "", "something")])).toContain("a worker");
  });
});

describe("the sweep clears the waiting queue (#4015)", () => {
  it("names the query and what to do with each kind", () => {
    // "Unblock anyone blocked or waiting" was unactionable prose — the director had no way to SEE who
    // was blocked. The sweep now names the command and the verb for each kind it returns.
    const p = heartbeatDirectorPrompt();
    expect(p).toContain("logs waiting");
    expect(p).toContain("bsc-answer");
    expect(p).toContain("bsc plan request resolve");
  });

  it("tells the director to LEAVE permission rows alone", () => {
    // A permission prompt needs the USER — the director cannot approve on their behalf, and a
    // director that tries will sit there re-reading a row it can never clear.
    expect(heartbeatDirectorPrompt()).toMatch(/permission.*USER/);
  });

  it("rides on the event prompt too, not just the heartbeat", () => {
    // A `heartbeat`-drive director sweeps on a timer; an `event`-drive one only ever sees this tail.
    expect(eventDirectorPrompt([{ type: "landed", ref: { kind: "issue", number: 1 }, at: 1 }])).toContain("logs waiting");
  });
});

describe("idle reminder (#4019)", () => {
  const ask = (session: string, question: string) => ({ session, question, at: 1 });
  const req = (id: string, text: string) => ({ id, from: "auth", text, at: 1 });
  const base = { idle: true, pending: 1, now: 1_000_000, lastRemindAt: 0, everyMs: ASK_REMINDER_MS };

  it("reminds an idle director that has never been reminded", () => {
    expect(shouldRemind(base)).toBe(true);
  });

  it("does NOT interrupt a busy director", () => {
    // The whole point is to spend the moment it has nothing else to do. Injecting mid-turn is what
    // the once-only immediate delivery already does; this is the backstop, not a second interrupt.
    expect(shouldRemind({ ...base, idle: false })).toBe(false);
  });

  it("says nothing when nothing is outstanding", () => {
    expect(shouldRemind({ ...base, pending: 0 })).toBe(false);
  });

  it("rate-limits, then reminds again — a director that keeps ignoring it IS the failure", () => {
    const justReminded = { ...base, lastRemindAt: base.now - 1000 };
    expect(shouldRemind(justReminded)).toBe(false);
    expect(shouldRemind({ ...justReminded, now: base.now + ASK_REMINDER_MS })).toBe(true);
  });

  it("nags faster than the heartbeat, because a worker is parked the whole time", () => {
    expect(ASK_REMINDER_MS).toBeLessThan(DEFAULT_HEARTBEAT_MS);
  });

  it("names the verb for each kind and says a worker is parked", () => {
    const p = idleReminderPrompt([ask("auth", "which pagination?")], [req("7", "no develop branch")]);
    expect(p).toContain("auth");
    expect(p).toContain("which pagination?");
    expect(p).toContain("bsc-answer");
    expect(p).toContain("#7");
    expect(p).toContain("bsc plan request resolve");
    // The cost of ignoring it, stated plainly — this is why it outranks whatever else it was doing.
    expect(p).toContain("PARKED");
    expect(p).toContain("Do not ask the user");
  });

  it("renders cleanly with only one kind outstanding", () => {
    const onlyAsks = idleReminderPrompt([ask("auth", "q")], []);
    expect(onlyAsks).toContain("bsc-answer");
    expect(onlyAsks).not.toContain("request resolve");
    const onlyReqs = idleReminderPrompt([], [req("3", "t")]);
    expect(onlyReqs).toContain("request resolve");
    expect(onlyReqs).not.toContain("bsc-answer");
  });
});
