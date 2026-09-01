// What one device-flow poll MEANS, captured from the live TypeScript so Rust can be proved to match.
//
// `github/oauth.rs` performs the exchange — `github_device_poll` returns `{ access_token?, error? }` —
// and the renderer decides whether to keep polling, back off, or stop and why. This fixture is what
// lets that decision move next to the poll.
//
// ## Three sentinels a realistic corpus never produces
//
//   * an EMPTY `access_token` is FALSY, so it falls through to the error branch instead of succeeding;
//   * an ABSENT error (`undefined`, `null`, or `""`) shares one message that an UNKNOWN error string
//     does NOT — collapsing them changes what the user is told;
//   * `slow_down` is the only branch that changes the interval, and by a named constant.
//
//     UPDATE_FIXTURES=1 npx vitest run src/shared/lib/github/githubDeviceFlow.fixtures.gen.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { mapDevicePoll, SLOW_DOWN_BUMP_SEC, type DevicePollResult } from "@/shared/lib/github/githubDeviceFlow";

const FIXTURE = join(process.cwd(), "src/shared/lib/github/githubDeviceFlow.fixtures.json");

const CASES: { label: string; res: DevicePollResult; intervalSec: number }[] = [
  { label: "a token succeeds", res: { access_token: "gho_abc" }, intervalSec: 5 },
  // A token WINS even when an error is also present — the check is ordered, not exclusive.
  { label: "a token wins over a simultaneous error", res: { access_token: "gho_abc", error: "slow_down" }, intervalSec: 5 },
  // SENTINEL: an empty token is falsy and must NOT be reported as success.
  { label: "an EMPTY token is not a success", res: { access_token: "", error: "authorization_pending" }, intervalSec: 5 },
  { label: "an empty token with no error is the unexpected-response error", res: { access_token: "" }, intervalSec: 5 },
  { label: "a null token with no error", res: { access_token: null, error: null }, intervalSec: 5 },

  { label: "authorization_pending keeps the interval", res: { error: "authorization_pending" }, intervalSec: 5 },
  { label: "authorization_pending at a bumped interval", res: { error: "authorization_pending" }, intervalSec: 12 },
  // slow_down is the ONLY branch that changes the interval.
  { label: "slow_down bumps the interval", res: { error: "slow_down" }, intervalSec: 5 },
  { label: "slow_down bumps again from an already-bumped interval", res: { error: "slow_down" }, intervalSec: 10 },
  { label: "slow_down from zero", res: { error: "slow_down" }, intervalSec: 0 },

  { label: "expired_token", res: { error: "expired_token" }, intervalSec: 5 },
  { label: "access_denied", res: { error: "access_denied" }, intervalSec: 5 },

  // SENTINEL: absent / null / empty share ONE message…
  { label: "no error field at all", res: {}, intervalSec: 5 },
  { label: "an explicitly null error", res: { error: null }, intervalSec: 5 },
  { label: "an empty-string error", res: { error: "" }, intervalSec: 5 },
  // …which an UNKNOWN error must not share.
  { label: "an unknown error is echoed", res: { error: "unsupported_grant_type" }, intervalSec: 5 },
  { label: "another unknown error", res: { error: "incorrect_device_code" }, intervalSec: 5 },
];

function build() {
  return {
    note: "GENERATED from the live TypeScript — see githubDeviceFlow.fixtures.gen.test.ts",
    slowDownBumpSec: SLOW_DOWN_BUMP_SEC,
    cases: CASES.map(({ label, res, intervalSec }) => ({
      label,
      res: { access_token: res.access_token ?? null, error: res.error ?? null },
      intervalSec,
      // WHOLE ACTION — kind plus its payload. A kind-only comparison would let a wrong message or a
      // wrong interval pass.
      action: mapDevicePoll(res, intervalSec),
    })),
  };
}

describe("the device-flow poll decision is captured for Rust to match", () => {
  it("matches the committed fixture (UPDATE_FIXTURES=1 to regenerate)", () => {
    const text = JSON.stringify(build(), null, 2) + "\n";
    if (process.env.UPDATE_FIXTURES === "1") writeFileSync(FIXTURE, text);
    expect(existsSync(FIXTURE), `${FIXTURE} is missing — run with UPDATE_FIXTURES=1`).toBe(true);
    expect(readFileSync(FIXTURE, "utf8")).toBe(text);
  });

  /** All three kinds must occur, or a port can hardcode one. */
  it("exercises success, pending and error", () => {
    expect([...new Set(build().cases.map((c) => c.action.kind))].sort()).toEqual(["error", "pending", "success"]);
  });

  /** THE SENTINEL. An empty token must not be a success. */
  it("does not treat an empty token as success", () => {
    const c = build().cases.filter((x) => x.res.access_token === "");
    expect(c).toHaveLength(2);
    expect(c.every((x) => x.action.kind !== "success")).toBe(true);
  });

  /** Absent / null / empty share ONE message, and an unknown error does not. */
  it("keeps the absent-error message distinct from an unknown one", () => {
    const cs = build().cases;
    const absent = cs.filter((c) => ["no error field at all", "an explicitly null error", "an empty-string error"].includes(c.label));
    const msgs = new Set(absent.map((c) => (c.action as { message: string }).message));
    expect(msgs.size).toBe(1);
    const unknown = cs.find((c) => c.label === "an unknown error is echoed")!;
    expect((unknown.action as { message: string }).message).not.toBe([...msgs][0]);
    expect((unknown.action as { message: string }).message).toContain("unsupported_grant_type");
  });

  /** Only slow_down changes the interval, and it changes it by the constant. */
  it("bumps the interval only on slow_down", () => {
    const cs = build().cases;
    for (const c of cs.filter((x) => x.action.kind === "pending")) {
      const want = x_error(c) === "slow_down" ? c.intervalSec + SLOW_DOWN_BUMP_SEC : c.intervalSec;
      expect((c.action as { intervalSec: number }).intervalSec).toBe(want);
    }
    function x_error(c: { res: { error: string | null } }) { return c.res.error; }
  });
});
