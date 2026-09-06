// `bsc-agent`'s native permission doc, captured from the LIVE TypeScript so the Rust rendering can be
// proved equal.
//
// This doc IS the gate on the model-agnostic harness. There is no `.claude/settings.json` on that path:
// `crates/bsc-agent/src/main.rs` calls `Permissions::from_env()` and enforces the result on every tool
// call, deserializing exactly `deny_tools` / `deny_bash` / `write_globs`. So a Rust runtime enforces,
// per tool call, a permission document computed in a renderer.
//
// Two details a port is most likely to drop, both covered below:
//   * The USER'S GLOBAL DENYLIST rides in here rather than through a settings file, because bsc-agent
//     has none. It is trimmed and de-duplicated against the role denies.
//   * The catastrophic floor (sudo / rm -rf / force-push) is NOT in this doc — it is always-on inside
//     the runtime via `bsc_util::dangerous`, so an empty doc still cannot run those.
//
//     UPDATE_FIXTURES=1 npx vitest run src/shared/lib/session/bscAgentPerms.fixtures.gen.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { roleCapability, bscAgentPerms, type SessionRole } from "@/shared/lib/session/sessionRoles";

const FIXTURE = join(process.cwd(), "src/shared/lib/session/bscAgentPerms.fixtures.json");

const ROLES: SessionRole[] = [
  "planner", "worker", "director", "triage", "tester", "reviewer",
  "issuer", "juror", "documentor", "designer", "architect", "librarian", "sound-designer", "marketer",
] as SessionRole[];

const PUSH_GRANT = ["git push", "gh pr create"];

type Case = { label: string; role: string | null; globs?: string[]; granted?: string[]; extraDeny?: string[]; surfaces?: string[] };

/** A stand-in `bsc surface list` catalog. Small and FIXED rather than the real one: the complement is
 *  what a role did NOT declare, so a live catalog would silently rewrite every expectation here each
 *  time a surface is added. `plan`/`skill` are surfaces no studio role declares; `ui` is one the
 *  designer does, so the pair proves the complement rather than a blanket deny. */
const CATALOG = ["plan", "skill", "ui"];

const SUBJECTS: Case[] = [
  // A role-less ad-hoc console: only the user's denylist applies.
  { label: "NO capability — an ad-hoc bsc-agent console", role: null },
  { label: "NO capability, but the user has a denylist", role: null, extraDeny: ["curl", "wget"] },

  ...ROLES.map((r) => ({ label: `role ${r}`, role: r })),

  // The flow reconciliation (#304), mirroring the Claude path.
  { label: "worker + the flow's push grant", role: "worker", granted: PUSH_GRANT },
  { label: "director + the flow's push grant", role: "director", granted: PUSH_GRANT },
  { label: "designer + a push grant it cannot use", role: "designer", granted: PUSH_GRANT },

  // The user's global denylist — the half that has no settings file to ride in on.
  { label: "worker + user denylist", role: "worker", extraDeny: ["curl", "npm publish"] },
  { label: "user denylist entries are TRIMMED", role: "worker", extraDeny: ["  curl  ", "npm publish"] },
  { label: "empty and whitespace-only denylist entries are dropped", role: "worker", extraDeny: ["", "   ", "curl"] },
  { label: "a user deny DUPLICATING a role deny is de-duplicated", role: "worker", extraDeny: ["gh pr merge"] },
  { label: "user denylist plus a push grant together", role: "worker", granted: PUSH_GRANT, extraDeny: ["curl"] },

  // write_globs: code:write takes its own, a carve-out keeps its scoped set, everything else gets none.
  { label: "worker with own write globs", role: "worker", globs: ["src/**", "docs/**"] },
  { label: "designer — code:none WITH a carve-out keeps its globs", role: "designer" },
  { label: "documentor — the doc-globs carve-out", role: "documentor" },
  { label: "triage — code:none with NO carve-out gets no globs and loses the write tools", role: "triage" },
  { label: "triage handed globs it has no carve-out for", role: "triage", globs: ["src/**"] },

  // The persona SURFACE COMPLEMENT (`a-bsc-agent-session-is-denied-less-than-the-same-role-on-claude`).
  // It used to be absent here entirely, so a bsc-agent session was denied strictly less than the same
  // role on Claude. An EMPTY catalog still denies nothing extra, which is the fail-open the launch
  // relies on when the catalog poll has not resolved.
  { label: "designer + the surface catalog — undeclared surfaces are denied", role: "designer", surfaces: CATALOG },
  { label: "designer + an EMPTY catalog denies no surface", role: "designer", surfaces: [] },
  { label: "worker + the surface catalog", role: "worker", surfaces: CATALOG },
];

const render = (c: Case) => {
  const cap = c.role ? roleCapability(c.role as SessionRole, c.globs?.length ? { writeGlobs: c.globs } : {}) ?? null : null;
  return { cap, perms: bscAgentPerms(cap, c.granted ?? [], c.extraDeny ?? [], c.surfaces ?? []) };
};

describe("bscAgentPerms fixtures", () => {
  it("captures the rendered doc over every role and every input", () => {
    const cases = SUBJECTS.map((c) => {
      const { cap, perms } = render(c);
      return {
        label: c.label,
        role: c.role,
        writeGlobs: c.globs ?? [],
        granted: c.granted ?? [],
        extraDenyBash: c.extraDeny ?? [],
        // The catalog the complement was computed against — emitted so the Rust parity test drives
        // the SAME input rather than assuming an empty one, which is the assumption that hid this bug.
        activeSurfaces: c.surfaces ?? [],
        capability: cap,
        perms,
      };
    });
    const next = { note: "GENERATED from @/shared/lib/session/sessionRoles bscAgentPerms — do not hand-edit; see the .gen.test.ts", cases };

    if (process.env.UPDATE_FIXTURES) writeFileSync(FIXTURE, `${JSON.stringify(next, null, 2)}\n`);
    expect(existsSync(FIXTURE), `${FIXTURE} missing — run with UPDATE_FIXTURES=1`).toBe(true);
    expect(JSON.parse(readFileSync(FIXTURE, "utf8"))).toEqual(next);
  });

  it("is non-vacuous: every branch of all three fields actually occurs", () => {
    const rendered = SUBJECTS.map(render);
    expect(rendered.filter((r) => r.perms.deny_tools.length > 0).length, "no case denied the write tools").toBeGreaterThan(0);
    expect(rendered.filter((r) => r.perms.deny_tools.length === 0).length, "no case KEPT the write tools").toBeGreaterThan(0);
    expect(rendered.filter((r) => r.perms.write_globs.length > 0).length, "no case produced write globs").toBeGreaterThan(0);
    expect(rendered.filter((r) => r.perms.deny_bash.length > 0).length, "no case produced bash denies").toBeGreaterThan(0);
  });

  it("the catastrophic floor is NOT in the doc — it lives in the runtime", () => {
    // If it were rendered here, an empty doc would look insufficient and a future edit might "restore"
    // it, hiding that the real floor is `bsc_util::dangerous` inside bsc-agent and cannot be dropped.
    for (const { perms } of SUBJECTS.map(render)) {
      expect(perms.deny_bash.some((d) => d.includes("sudo") || d.includes("rm -rf"))).toBe(false);
    }
  });

  it("a push grant lifts ONLY what the role actually denied", () => {
    const worker = roleCapability("worker" as SessionRole, {})!;
    const plain = bscAgentPerms(worker).deny_bash;
    const granted = bscAgentPerms(worker, PUSH_GRANT).deny_bash;
    const lifted = plain.filter((d) => !granted.includes(d));
    expect(lifted, "a worker is git:write, so only the gh half was ever denied").toEqual(["gh pr create"]);
  });
});
