// The profile → session-settings bridge, captured from the LIVE TypeScript so the Rust port can be
// proved equal.
//
// This is the role-gate inversion one record over. `ensure_session_settings` already RECEIVES
// `bash_posture` and scales the entire auto-approve baseline by it (settings.rs:211 — an `allow` doer
// gets the read-only AND build command tiers, an `ask` coordinator gets read-only only, `deny` gets
// neither). Rust acts on that value at every launch and has no way to compute it: the breadth of a
// session's shell surface is decided in a renderer and the backend obeys.
//
// The subjects are EVERY PACKAGED ROLE under `src-tauri/data/roles/`, not invented inputs — these are
// the profiles that actually ship, so parity over them is parity over what users get. Synthetic cases
// follow for the three deliberate edges, which no packaged role happens to exercise and each of which
// is a real defect if the port smooths it.
//
//     UPDATE_FIXTURES=1 npx vitest run src/shared/lib/security/profileEnforcement.fixtures.gen.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { resolveProfileSettings } from "@/shared/lib/security/profileEnforcement";
// ALL_ROLES itself is not exported, and these two partition it exactly (APP_ROLES is the
// category === "application" half, PROFILES the rest) — so this is the whole packaged set without
// widening the module's public surface just to test it.
import { APP_ROLES, PROFILES } from "@/shared/lib/security/agentProfiles";
import type { AgentProfile, Tier, ToolKey } from "@/shared/lib/security/agentProfiles";

const ALL_PROFILE_ROLES: AgentProfile[] = [...APP_ROLES, ...PROFILES].sort((a, b) => a.id.localeCompare(b.id));

const FIXTURE = join(process.cwd(), "src/shared/lib/security/profileEnforcement.fixtures.json");

const TOOLS: ToolKey[] = ["read", "grep", "glob", "edit", "write", "bash", "web", "task"];

/** A minimal profile with every tool at `tier`, for the synthetic edge cases. */
const synth = (id: string, tier: Tier, over: Partial<AgentProfile> = {}): AgentProfile => ({
  id,
  name: id,
  color: "#000",
  category: "user",
  desc: "",
  mode: tier,
  commands: [],
  tools: Object.fromEntries(TOOLS.map((t) => [t, tier])) as Record<ToolKey, Tier>,
  paths: { allow: [], deny: [] },
  net: { allow: [] },
  ...over,
});

/** The three edges, each deliberate and each a defect if the port drops it. */
const SYNTHETIC: Array<[string, AgentProfile]> = [
  // A bare `Bash` deny would also kill the guaranteed gh/git, so shell control flows through the
  // command allowlist and the role gate instead — `bash: deny` must emit NO tool rule.
  ["every tool denied — bash must still not be blanket-denied", synth("edge-all-deny", "deny")],
  ["every tool allowed", synth("edge-all-allow", "allow")],
  // `ask` is left unlisted so Claude Code prompts, which is its default.
  ["every tool asked — ask emits no rule at all", synth("edge-all-ask", "ask")],
  [
    // Path rules are Edit(<glob>) ONLY (#3534). `Write(<glob>)` was never enforced — a silent no-op for
    // an allow and an UNENFORCED DENY for a deny, which is the dangerous half.
    "path globs become Edit(glob) rules, allow and deny",
    synth("edge-paths", "ask", { paths: { allow: ["src/**", "docs/**"], deny: ["src/secrets/**"] } }),
  ],
  [
    "commands are deduped and deniedCommands stays empty — the role gate supplies those",
    synth("edge-commands", "ask", { commands: ["git status", "npm test", "git status"] }),
  ],
  [
    // mode and net are advisory: every capability the gate can express is in tools + paths, and
    // host-level network limits are not expressible through settings.json at all.
    "mode and net are advisory and produce no rule",
    synth("edge-advisory", "allow", { mode: "deny", net: { allow: ["api.example.com"] } }),
  ],
  [
    // The TypeScript iterates `Object.entries(profile.tools)`, so its OUTPUT ORDER follows whatever
    // order the keys were written in. Every packaged role uses the same canonical order, so this never
    // shows — which is exactly why the case is here. A hand-edited or store-round-tripped profile can
    // have any order, and a fixture built only from the packaged set would have hidden it.
    "tool keys in a SHUFFLED order — output order follows the input",
    synth("edge-shuffled", "ask", {
      tools: { task: "allow", bash: "allow", read: "allow", web: "deny", glob: "deny", write: "allow", edit: "deny", grep: "allow" },
    }),
  ],
  [
    "a mixed profile — the shape a real custom profile has",
    synth("edge-mixed", "ask", {
      commands: ["cargo test"],
      tools: { read: "allow", grep: "allow", glob: "ask", edit: "allow", write: "deny", bash: "deny", web: "deny", task: "ask" },
      paths: { allow: ["crates/**"], deny: ["**/*.env"] },
    }),
  ],
];

describe("profileEnforcement fixtures", () => {
  it("captures resolveProfileSettings over every packaged role and every edge", () => {
    const packaged = ALL_PROFILE_ROLES.map((p) => [`packaged: ${p.id}`, p] as [string, AgentProfile]);
    const subjects = [...packaged, ...SYNTHETIC];
    const cases = subjects.map(([label, profile]) => ({
      label,
      profile,
      settings: resolveProfileSettings(profile),
    }));
    const next = {
      note: "GENERATED from src/shared/lib/security/profileEnforcement.ts — do not hand-edit; see the .gen.test.ts",
      cases,
    };

    if (process.env.UPDATE_FIXTURES) {
      writeFileSync(FIXTURE, `${JSON.stringify(next, null, 2)}\n`);
    }
    expect(existsSync(FIXTURE), `${FIXTURE} missing — run with UPDATE_FIXTURES=1`).toBe(true);
    expect(JSON.parse(readFileSync(FIXTURE, "utf8"))).toEqual(next);
  });

  it("is non-vacuous: the packaged roles are actually present and actually produce rules", () => {
    expect(ALL_PROFILE_ROLES.length, "no packaged roles found — the glob resolved to nothing").toBeGreaterThanOrEqual(5);
    const withRules = ALL_PROFILE_ROLES.filter((p) => {
      const s = resolveProfileSettings(p);
      return s.allowToolRules.length + s.denyToolRules.length + s.allowedCommands.length > 0;
    });
    expect(withRules.length, "every packaged role resolved to nothing — the bridge is not being exercised").toBeGreaterThanOrEqual(3);
  });

  it("covers all three bash postures, so the value settings.rs scales its baseline by is pinned", () => {
    const postures = new Set([...ALL_PROFILE_ROLES, ...SYNTHETIC.map(([, p]) => p)].map((p) => resolveProfileSettings(p).bashPosture));
    expect([...postures].sort()).toEqual(["allow", "ask", "deny"]);
  });
});
