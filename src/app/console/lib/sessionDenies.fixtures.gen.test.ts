// The session's denied Bash commands, captured from the LIVE TypeScript so the Rust composition can be
// proved equal.
//
// WHY THIS ONE MATTERS MORE THAN MOST. This list is the single source for both the `permissions.deny`
// rules and the `$BSC_DENY_BASH` env — and under the BYPASS posture `permissions.deny` is ignored
// entirely, so the `bsc-deny` PreToolUse hook reading `$BSC_DENY_BASH` is the only thing left enforcing
// it. `crates/bsc-hook/src/main.rs` BLOCKS on these patterns and cannot compute them; `console/pty` just
// copies the string into the child env. Rust enforces a policy it never derived.
//
// Three sources compose it: the user's global denies, the ROLE's denies minus the pushes the pane's FLOW
// grants back (#304), and the PROFILE's denies.
//
//     UPDATE_FIXTURES=1 npx vitest run src/app/console/lib/sessionDenies.fixtures.gen.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { sessionDeniedCommands } from "@/app/console/lib/sessionLaunch";
import { deniableSurfaceNames } from "@/shared/lib/session/surfaceCatalog";
import { flowGrantedPushCommands } from "@/features/planner";
import { roleCapability, roleDeniedCommands, type SessionRole } from "@/shared/lib/session/sessionRoles";
import type { AppStore } from "@/store/types";

const FIXTURE = join(process.cwd(), "src/app/console/lib/sessionDenies.fixtures.json");
const PANE = "p1";

type Snap = {
  deniedCommands?: string[];
  paneRoles?: Record<string, string>;
  paneRoleGlobs?: Record<string, string[]>;
  paneProfiles?: Record<string, string>;
  agentProfiles?: unknown[];
  paneFlows?: Record<string, unknown>;
  surfaceCatalog?: Array<{ name: string; status?: string }> | null;
};

const store = (s: Snap) =>
  ({ deniedCommands: [], paneRoles: {}, paneRoleGlobs: {}, paneProfiles: {}, agentProfiles: [], paneFlows: {}, surfaceCatalog: [], ...s }) as unknown as AppStore;

/** A small catalog covering all three statuses. `internal` must NEVER be deniable — `bsc hook` is what
 *  the deny mechanism itself runs through, so denying it is a self-inflicted outage. */
const CATALOG = [
  { name: "plan" },
  { name: "skill", status: "active" },
  { name: "org", status: "deprecated" },
  { name: "hook", status: "internal" },
  { name: "serve", status: "internal" },
];

const SUBJECTS: Array<[string, Snap]> = [
  ["no role, no profile, no flow — only the user's own denies", { deniedCommands: ["rm -rf /"] }],
  ["no role at all — an ungated pane gets no role denies", { deniedCommands: ["curl"], surfaceCatalog: CATALOG }],

  ["a worker role, empty catalog — denies nothing EXTRA by design", { paneRoles: { [PANE]: "worker" } }],
  ["a worker role with the catalog — the surface complement appears", { paneRoles: { [PANE]: "worker" }, surfaceCatalog: CATALOG }],
  ["a triage role (git:none, github:write)", { paneRoles: { [PANE]: "triage" }, surfaceCatalog: CATALOG }],
  ["a director role", { paneRoles: { [PANE]: "director" }, surfaceCatalog: CATALOG }],
  ["a planner role", { paneRoles: { [PANE]: "planner" }, surfaceCatalog: CATALOG }],
  ["a documentor role", { paneRoles: { [PANE]: "documentor" }, surfaceCatalog: CATALOG }],
  ["a designer role — the most restricted", { paneRoles: { [PANE]: "designer" }, surfaceCatalog: CATALOG }],

  // #304 — the flow lifts EXACTLY the two pushes and nothing else.
  ["worker + auto-pr flow: the two pushes are granted back", { paneRoles: { [PANE]: "worker" }, paneFlows: { [PANE]: { push: "auto-pr" } }, surfaceCatalog: CATALOG }],
  ["worker + push-confirm flow: same two", { paneRoles: { [PANE]: "worker" }, paneFlows: { [PANE]: { push: "push-confirm" } }, surfaceCatalog: CATALOG }],
  ["worker + commit-only flow: grants nothing", { paneRoles: { [PANE]: "worker" }, paneFlows: { [PANE]: { push: "commit-only" } }, surfaceCatalog: CATALOG }],
  ["worker + none flow: grants nothing", { paneRoles: { [PANE]: "worker" }, paneFlows: { [PANE]: { push: "none" } }, surfaceCatalog: CATALOG }],
  // DEFAULT_FLOW.push is `local`, changed FROM auto-pr so an untouched default does not push.
  ["worker + NO flow: the default is `local`, which grants nothing", { paneRoles: { [PANE]: "worker" }, surfaceCatalog: CATALOG }],
  ["director + auto-pr", { paneRoles: { [PANE]: "director" }, paneFlows: { [PANE]: { push: "auto-pr" } }, surfaceCatalog: CATALOG }],

  ["a null catalog — the field can genuinely be absent on a store snapshot", { paneRoles: { [PANE]: "worker" }, surfaceCatalog: null }],
  ["user denies come FIRST and are never filtered by the flow", { deniedCommands: ["git push"], paneRoles: { [PANE]: "worker" }, paneFlows: { [PANE]: { push: "auto-pr" } }, surfaceCatalog: CATALOG }],
  ["role write-globs are passed through to the capability", { paneRoles: { [PANE]: "worker" }, paneRoleGlobs: { [PANE]: ["src/**"] }, surfaceCatalog: CATALOG }],
];

/** Catalog shapes for `deniableSurfaceNames` on its own — the security-relevant filter. */
const CATALOGS: Array<[string, Array<{ name: string; status?: string }> | null]> = [
  ["all three statuses", CATALOG],
  ["absent status means ACTIVE (the catalog omits it for the common case)", [{ name: "plan" }]],
  ["deprecated IS deniable — an alias serves the same store as its live surface", [{ name: "org", status: "deprecated" }]],
  ["internal is NEVER deniable — denying `bsc hook` breaks the deny mechanism itself", [{ name: "hook", status: "internal" }]],
  ["an unknown status is not active and not deprecated", [{ name: "x", status: "experimental" }]],
  ["empty", []],
  ["null", null],
];

/** Every flow push value, so the default and the two granting values are all pinned. */
const FLOWS: Array<[string, unknown]> = [
  ["undefined — DEFAULT_FLOW.push is `local`", undefined],
  ["auto-pr", { push: "auto-pr" }],
  ["push-confirm", { push: "push-confirm" }],
  ["local", { push: "local" }],
  ["commit-only", { push: "commit-only" }],
  ["none", { push: "none" }],
  ["an unknown push value falls back to the default", { push: "nonsense" }],
];

describe("sessionDenies fixtures", () => {
  it("captures the composition and both helpers", () => {
    const next = {
      note: "GENERATED from @/app/console/lib/sessionLaunch sessionDeniedCommands + its two helpers — do not hand-edit; see the .gen.test.ts",
      cases: SUBJECTS.map(([label, snap]) => ({
        label,
        role: snap.paneRoles?.[PANE] ?? null,
        flowPush: (snap.paneFlows?.[PANE] as { push?: string } | undefined)?.push ?? null,
        userDenies: snap.deniedCommands ?? [],
        surfaceCatalog: snap.surfaceCatalog ?? null,
        writeGlobs: snap.paneRoleGlobs?.[PANE] ?? [],
        // The RESOLVED capability, captured so the Rust side can deserialize it rather than needing a
        // role→capability function of its own. The self-check below proves this is the same capability
        // the live composition actually used, so capturing it is not a second opinion.
        capability: snap.paneRoles?.[PANE]
          ? roleCapability(snap.paneRoles[PANE] as SessionRole, { writeGlobs: snap.paneRoleGlobs?.[PANE] ?? [] }) ?? null
          : null,
        denied: sessionDeniedCommands(store(snap), PANE),
      })),
      deniableSurfaces: CATALOGS.map(([label, rows]) => ({ label, rows, names: deniableSurfaceNames(rows) })),
      flowGrants: FLOWS.map(([label, flow]) => ({ label, flow: flow ?? null, granted: flowGrantedPushCommands(flow as never) })),
    };

    if (process.env.UPDATE_FIXTURES) writeFileSync(FIXTURE, `${JSON.stringify(next, null, 2)}\n`);
    expect(existsSync(FIXTURE), `${FIXTURE} missing — run with UPDATE_FIXTURES=1`).toBe(true);
    expect(JSON.parse(readFileSync(FIXTURE, "utf8"))).toEqual(next);
  });

  it("the CAPTURED capability is the one the live composition used — not a second opinion", () => {
    // `paneCapability` (private to sessionLaunch) also consults personas; on these snapshots there is
    // no persona, so it must reduce to `roleCapability`. Recomputing the whole composition from the
    // captured capability and asserting it equals the live answer is what proves that — without it,
    // the fixture could hand Rust a capability the real launch never used.
    for (const [label, snap] of SUBJECTS) {
      const role = snap.paneRoles?.[PANE];
      if (!role) continue;
      const cap = roleCapability(role as SessionRole, { writeGlobs: snap.paneRoleGlobs?.[PANE] ?? [] });
      const granted = flowGrantedPushCommands(snap.paneFlows?.[PANE] as never);
      const recomposed = [
        ...(snap.deniedCommands ?? []),
        ...(cap ? roleDeniedCommands(cap, deniableSurfaceNames(snap.surfaceCatalog)) : []).filter((d) => !granted.includes(d)),
      ];
      expect(recomposed, `${label}: the captured capability does not reproduce the live answer`)
        .toEqual(sessionDeniedCommands(store(snap), PANE));
    }
  });

  it("is non-vacuous: roles really do contribute denies, and the flow really does lift two", () => {
    const gated = sessionDeniedCommands(store({ paneRoles: { [PANE]: "worker" }, surfaceCatalog: CATALOG }), PANE);
    expect(gated.length, "a gated worker produced no denies — the fixture would prove nothing").toBeGreaterThan(0);

    const withFlow = sessionDeniedCommands(store({ paneRoles: { [PANE]: "worker" }, paneFlows: { [PANE]: { push: "auto-pr" } }, surfaceCatalog: CATALOG }), PANE);
    expect(withFlow.length, "auto-pr must lift at least one deny (#304)").toBeLessThan(gated.length);
  });

  it("the PROFILE contributes no command denies — the role gate alone supplies them", () => {
    // resolveProfileSettings hard-codes deniedCommands: []. Asserted so the invariant that the two must
    // not both claim this field cannot break silently.
    const noProfile = sessionDeniedCommands(store({ paneRoles: { [PANE]: "worker" }, surfaceCatalog: CATALOG }), PANE);
    const withProfile = sessionDeniedCommands(
      store({
        paneRoles: { [PANE]: "worker" },
        surfaceCatalog: CATALOG,
        paneProfiles: { [PANE]: "pf_x" },
        agentProfiles: [{ id: "pf_x", name: "x", color: "#000", category: "user", desc: "", mode: "deny", commands: [], tools: {}, paths: { allow: [], deny: [] }, net: { allow: [] } }],
      }),
      PANE,
    );
    expect(withProfile).toEqual(noProfile);
  });
});
