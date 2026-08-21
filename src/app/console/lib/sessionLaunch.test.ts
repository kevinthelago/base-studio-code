import { describe, it, expect } from "vitest";
import { buildAgentEnv, buildSessionSettings, resolveEffectiveInitCmd, resolveStartupPromptFreshOnly, providerLaunchConfig, SCOPE_DENY_ALL, resolveSandboxBackend, usesNamespaceHooks, sandboxPlanFor } from "@/app/console/lib/sessionLaunch";
import { DEBUG_STUDIO_SESSION_ID, designerSessionId,
  librarianSessionId, TEAMS_STUDIO_SESSION_ID } from "@/shared/lib/session/systemSessions";
import { aiderProvider } from "@/app/console/lib/providers/providers/aider";
import { roleCapability, roleDeniedCommands, roleDeniedTools, scopeWriteGlobs, bscAgentPerms, sessionScopes, restrictedRoleCommands } from "@/shared/lib/session/sessionRoles";
import { flowGrantedPushCommands } from "@/features/planner/fleet/flowPermissions";
import { resolveProfileSettings } from "@/shared/lib/security/profileEnforcement";
import { PROFILES } from "@/shared/lib/security/agentProfiles";
import type { AppStore } from "@/store/types";
import type { ConsoleProvider } from "@/app/console/lib/providers";
import type { AgentFlow } from "@/features/planner/fleet/agentFlow";

// sessionLaunch's builders read a store SNAPSHOT — only a known subset of fields. A partial cast is
// the documented unit-test contract (cf. resolveLlmConfig's `LlmConfigSource`).
function mkStore(overrides: Record<string, unknown> = {}): AppStore {
  return {
    paneRoles: {}, paneRoleGlobs: {}, paneFlows: {}, paneProfiles: {}, agentProfiles: [],
    fleetPaneStreams: {},
    deniedCommands: [],
    mcpServers: [], paneHooks: {}, hooks: [],
    paneSkills: {}, skills: [], sessionSkillOverrides: {}, sessionSkillGroups: {}, skillGroups: [],
    paneWasClaude: {}, autoResumeClaude: false, uncleanShutdown: false, restoreRequested: {},
    llmProvider: "anthropic", llmModel: "claude-sonnet-4-6", claudeApiKey: "", openaiKey: "", geminiKey: "", localBaseUrl: "",
    ...overrides,
  } as unknown as AppStore;
}

const flow = (push: AgentFlow["push"]): AgentFlow => ({ autonomy: "continuous", push, trigger: "per-issue", gate: "hard" });
const cmds = (settings: ReturnType<typeof buildSessionSettings>) => settings.hooks.map((h) => h.command);

describe("buildAgentEnv", () => {
  it("returns undefined when there is nothing to inject (no token, no role, claude provider)", () => {
    expect(buildAgentEnv(mkStore(), "t0p0", "claude", "")).toBeUndefined();
  });

  it("carries GH_TOKEN when a token is resolved", () => {
    expect(buildAgentEnv(mkStore(), "t0p0", "claude", "ghp_x")).toEqual({ GH_TOKEN: "ghp_x" });
  });

  it("emits BSC_SCOPE_GLOBS for a gated pane with owned write globs", () => {
    const s = mkStore({ paneRoles: { p: "worker" }, paneRoleGlobs: { p: ["src/**"] } });
    const expected = scopeWriteGlobs("worker", ["src/**"]).join(" ");
    expect(buildAgentEnv(s, "p", "claude", "")?.BSC_SCOPE_GLOBS).toBe(expected);
    expect(expected.length).toBeGreaterThan(0);
  });

  it("does not emit BSC_SCOPE_GLOBS for an ungated pane", () => {
    expect(buildAgentEnv(mkStore(), "p", "claude", "tok")).toEqual({ GH_TOKEN: "tok" });
  });

  it("withholds GH_TOKEN from a role denied BOTH git and github (#3357)", () => {
    // The app-owned studio sessions (designer/librarian/architect) are `none` on every axis — they can
    // run neither git nor gh, so a GitHub credential in the environment of the app's MOST restricted
    // sessions would widen them for nothing. Before #3357 these launched via a bespoke hook that passed
    // no token; running them through the generic path must not quietly hand them one.
    for (const role of ["designer", "librarian", "architect"]) {
      const e = buildAgentEnv(mkStore({ paneRoles: { p: role } }), "p", "claude", "ghp_x");
      expect(e?.GH_TOKEN, `${role} must not receive a GitHub token`).toBeUndefined();
      // The rest of the gated-pane env is unaffected — it still gets its write-scope + store scopes.
      // Since #3373 that scope is the sealed staging dir rather than the deny-all sentinel: bsc-scope
      // hard-blocks every write OUTSIDE `scratch/**`, which is the same wall with one door in it.
      expect(e?.BSC_SCOPE_GLOBS).toBe("scratch/**");
    }
  });

  it("resolves a role's symbolic harvest root to the app repo path (#3509)", () => {
    // The designer is `code: none` with `scratch/**` its only writable glob, yet it must be able to
    // MINE the app's own UI (#3451/#3471). The role declares the intent; the launch resolves it.
    const s = mkStore({ paneRoles: { p: "designer" }, appRepoRoot: "C:/src/base-studio-code" });
    const e = buildAgentEnv(s, "p", "claude", "");
    expect(e?.BSC_HARVEST_ROOTS).toBe("C:/src/base-studio-code");
    // Read-only means read-only: the harvest root must NOT widen the write scope.
    expect(e?.BSC_SCOPE_GLOBS).toBe("scratch/**");
  });

  it("adds the whole projects/ dir as a second read-only harvest root for the designer (#3664)", () => {
    // The designer can now mine UI from every downloaded project repo, not just the app's own source.
    const s = mkStore({ paneRoles: { p: "designer" }, appRepoRoot: "C:/src/base-studio-code", bscBaseDir: "C:/Users/k/.base-studio-code" });
    const e = buildAgentEnv(s, "p", "claude", "");
    // Both roots, newline-separated, in declared order (app-repo, then projects).
    expect(e?.BSC_HARVEST_ROOTS).toBe("C:/src/base-studio-code\nC:/Users/k/.base-studio-code/projects");
    // Still read-only — the extra root does NOT widen the write scope.
    expect(e?.BSC_SCOPE_GLOBS).toBe("scratch/**");
  });

  it("omits BSC_HARVEST_ROOTS when the role declares none (#3509)", () => {
    const s = mkStore({ paneRoles: { p: "worker" }, appRepoRoot: "C:/src/base-studio-code" });
    expect(buildAgentEnv(s, "p", "claude", "")?.BSC_HARVEST_ROOTS).toBeUndefined();
  });

  it("resolves the librarian's app-repo harvest root too, read-only (#3516)", () => {
    // The librarian's cwd is `algorithms-studio/`, which holds no source — the same wall #3509 removed
    // for the designer. It declares the SAME symbolic root so `bsc graph harvest` can mine the app's
    // own logic into the algorithms graph. This is the companion capability; the launch resolution is
    // generic, so the only thing to pin here is that the role-capabilities entry actually carries it.
    const s = mkStore({ paneRoles: { p: "librarian" }, appRepoRoot: "C:/src/base-studio-code" });
    const e = buildAgentEnv(s, "p", "claude", "");
    expect(e?.BSC_HARVEST_ROOTS).toBe("C:/src/base-studio-code");
    // Same read/write asymmetry as the designer: a harvest root grants reads, not writes.
    expect(e?.BSC_SCOPE_GLOBS).toBe("scratch/**");
  });

  it("gives the librarian the projects/ tree too, so it can reach mobile-studio-code (#4108)", () => {
    // The Algorithms studio could only ever see `app-repo` — the EXTERNAL dev checkout — so it worked
    // against paths outside application scope and could not find `mobile-studio-code` at all (measured:
    // it ran `Glob mobile-studio-code` and came up empty), even though the repo is cloned at
    // `~/.base-studio-code/projects/studio-code/mobile-studio-code`.
    const s = mkStore({ paneRoles: { p: "librarian" }, appRepoRoot: "C:/src/base-studio-code", bscBaseDir: "C:/Users/k/.base-studio-code" });
    const e = buildAgentEnv(s, "p", "claude", "");
    expect(e?.BSC_HARVEST_ROOTS).toBe("C:/src/base-studio-code\nC:/Users/k/.base-studio-code/projects");
    // The whole point of the grant is READ reach. It must not widen the write scope by one glob.
    expect(e?.BSC_SCOPE_GLOBS).toBe("scratch/**");
  });

  it("still resolves nothing extra for the librarian before the base dir hydrates (#4108)", () => {
    // `projects` depends on `bscBaseDir`. Pre-hydration it must contribute NOTHING rather than an
    // empty or half-formed path — the same fail-closed rule the app-repo token follows.
    const s = mkStore({ paneRoles: { p: "librarian" }, appRepoRoot: "C:/src/base-studio-code" });
    expect(buildAgentEnv(s, "p", "claude", "")?.BSC_HARVEST_ROOTS).toBe("C:/src/base-studio-code");
  });

  it("fails CLOSED when the symbolic root cannot be resolved (#3509)", () => {
    // A shipped binary has no source tree. An unresolvable token must contribute NOTHING rather
    // than emitting an empty entry, which the CLI would otherwise have to interpret.
    const s = mkStore({ paneRoles: { p: "designer" }, appRepoRoot: null });
    expect(buildAgentEnv(s, "p", "claude", "")?.BSC_HARVEST_ROOTS).toBeUndefined();
  });

  it("still carries GH_TOKEN for a role with real gh access (#3357 must not over-reach)", () => {
    // triage is `git:none` but `github:write` — it drives the gh CLI and MUST keep its token.
    expect(buildAgentEnv(mkStore({ paneRoles: { p: "triage" } }), "p", "claude", "ghp_x")?.GH_TOKEN).toBe("ghp_x");
  });

  it("emits the deny-all sentinel for a code:none role with no write globs (#1916 Step 3.5)", () => {
    // triage / reviewer / director-without-commons (code:none, empty globs) → bsc-scope hard-blocks ALL
    // writes, surviving bypassPermissions (where the role's permissions.deny write rule is ignored).
    expect(buildAgentEnv(mkStore({ paneRoles: { p: "triage" } }), "p", "claude", "")?.BSC_SCOPE_GLOBS).toBe(SCOPE_DENY_ALL);
    // A worker (code:write) with no globs is NOT deny-all — it writes code within its worktree.
    expect(buildAgentEnv(mkStore({ paneRoles: { p: "worker" } }), "p", "claude", "")?.BSC_SCOPE_GLOBS).toBeUndefined();
  });

  it("scopes a WORKER pane's bsc plan to its own stream via BSC_STREAM (#3279)", () => {
    // The safety-critical boundary: a worker sees + touches only its own stream's issues (the plandb
    // CLI enforces $BSC_STREAM). fleetPaneStreams carries the raw stream id — it must equal
    // PlanIssue.stream exactly, so use the id verbatim, not a slug.
    const s = mkStore({ paneRoles: { p: "worker" }, fleetPaneStreams: { p: { id: "auth-login" } } });
    expect(buildAgentEnv(s, "p", "claude", "")?.BSC_STREAM).toBe("auth-login");
  });

  it("does NOT scope coordinating roles — they need cross-stream access (#3279)", () => {
    // A director/planner/triage/reviewer pane must keep full access to integrate + judge across
    // streams. Even if a stream is bridged to the pane, a non-worker role gets no $BSC_STREAM.
    for (const role of ["director", "reviewer", "triage", "planner"]) {
      const s = mkStore({ paneRoles: { p: role }, fleetPaneStreams: { p: { id: "auth-login" } } });
      expect(buildAgentEnv(s, "p", "claude", "")?.BSC_STREAM).toBeUndefined();
    }
    // A worker pane with NO bridged stream (a bare manual worker) also gets none — nothing to scope to.
    expect(buildAgentEnv(mkStore({ paneRoles: { p: "worker" } }), "p", "claude", "")?.BSC_STREAM).toBeUndefined();
  });

  it("emits BSC_SCOPES (the role's per-store access tiers) on every gated pane (#2470)", () => {
    // The runtime doc the store CLIs read (`bsc_cli_util::scope_allows_write`): a worker's ui tier
    // is read, so `bsc ui set`/`remove` refuse at the verb handler even if the launch denies are
    // bypassed by a non-Claude runtime.
    const e = buildAgentEnv(mkStore({ paneRoles: { p: "worker" } }), "p", "claude", "");
    expect(e?.BSC_SCOPES).toBe(JSON.stringify(sessionScopes(roleCapability("worker"))));
    expect(JSON.parse(e!.BSC_SCOPES!)).toEqual({ ui: "read" });
    // Role-independent: every gated pane carries the doc (a code:write worker included, above; a
    // code:none triage too).
    const triage = buildAgentEnv(mkStore({ paneRoles: { p: "triage" } }), "p", "claude", "");
    expect(JSON.parse(triage!.BSC_SCOPES!)).toEqual({ ui: "read" });
  });

  it("does not emit BSC_SCOPES for an ungated pane (absent env ⇒ unrestricted, back-compat)", () => {
    expect(buildAgentEnv(mkStore(), "p", "claude", "tok")?.BSC_SCOPES).toBeUndefined();
  });

  it("emits BSC_DENY_BASH (user + role denies) for the bsc-deny hook (#1916)", () => {
    const s = mkStore({ paneRoles: { p: "worker" }, paneFlows: { p: flow("none") }, deniedCommands: ["curl"] });
    const denies = buildAgentEnv(s, "p", "claude", "")?.BSC_DENY_BASH?.split("\n") ?? [];
    expect(denies).toContain("curl"); // global user deny
    const cap = roleCapability("worker", { writeGlobs: [] });
    for (const d of roleDeniedCommands(cap)) expect(denies).toContain(d); // role denies survive bypass
  });

  it("does not emit BSC_DENY_BASH when there are no denies", () => {
    expect(buildAgentEnv(mkStore(), "p", "claude", "tok")?.BSC_DENY_BASH).toBeUndefined();
  });

  describe("bsc-agent provider", () => {
    it("injects the provider/model env", () => {
      const e = buildAgentEnv(mkStore({ llmModel: "gpt-4o", llmProvider: "openai", openaiKey: "sk" }), "p", "bsc-agent", "")!;
      expect(e.BSC_AGENT_PROVIDER).toBe("openai");
      expect(e.BSC_AGENT_MODEL).toBe("gpt-4o");
      expect(e.BSC_AGENT_API_KEY).toBe("sk");
    });

    it("adds role-derived BSC_AGENT_PERMS, lifting the flow's granted push commands (#304)", () => {
      const s = mkStore({ paneRoles: { p: "worker" }, paneRoleGlobs: { p: ["src/**"] }, paneFlows: { p: flow("auto-pr") } });
      const e = buildAgentEnv(s, "p", "bsc-agent", "")!;
      const cap = roleCapability("worker", { writeGlobs: ["src/**"] });
      expect(JSON.parse(e.BSC_AGENT_PERMS)).toEqual(bscAgentPerms(cap, flowGrantedPushCommands(flow("auto-pr"))));
    });

    it("omits BSC_AGENT_PERMS for an ungated bsc-agent pane but still passes the resolved MCP servers", () => {
      const e = buildAgentEnv(mkStore(), "p", "bsc-agent", "")!;
      expect(e.BSC_AGENT_PERMS).toBeUndefined(); // no role ⇒ permissive runtime
      // No per-pane override ⇒ the global servers resolve; they're handed to the bsc-agent client.
      expect(Array.isArray(JSON.parse(e.BSC_AGENT_MCP!))).toBe(true);
    });
  });

  describe("aider provider (#1172)", () => {
    it("injects the provider's API key env alongside GH_TOKEN", () => {
      const e = buildAgentEnv(mkStore({ llmProvider: "anthropic", claudeApiKey: "ant" }), "p", "aider", "ghp_x")!;
      expect(e.ANTHROPIC_API_KEY).toBe("ant");
      expect(e.GH_TOKEN).toBe("ghp_x"); // an aider worker can still push + open its PR
    });

    it("maps an openai config to OPENAI_API_KEY", () => {
      const e = buildAgentEnv(mkStore({ llmProvider: "openai", llmModel: "gpt-4o", openaiKey: "sk" }), "p", "aider", "")!;
      expect(e.OPENAI_API_KEY).toBe("sk");
    });

    it("does NOT inject bsc-agent env for an aider pane", () => {
      const e = buildAgentEnv(mkStore({ claudeApiKey: "ant" }), "p", "aider", "");
      expect(e?.BSC_AGENT_PROVIDER).toBeUndefined();
    });
  });
});

describe("providerLaunchConfig (#1172)", () => {
  it("returns undefined for a non-aider provider", () => {
    const ollama = { id: "ollama", buildLaunchCmd: () => "ollama run x" } as unknown as typeof aiderProvider;
    expect(providerLaunchConfig(mkStore(), "p", ollama, "go")).toBeUndefined();
  });

  it("builds the aider config: resolved LLM, prompt, and a worker's CLAUDE.local.md scope", () => {
    const s = mkStore({ paneRoles: { p: "worker" }, llmProvider: "anthropic", claudeApiKey: "k" });
    const cfg = providerLaunchConfig(s, "p", aiderProvider, "kickoff")!;
    expect(cfg.llm?.provider).toBe("anthropic");
    expect(cfg.startupPrompt).toBe("kickoff");
    expect(cfg.readFiles).toEqual(["CLAUDE.local.md"]);
  });

  it("omits readFiles for a non-worker pane and drops a blank prompt", () => {
    const cfg = providerLaunchConfig(mkStore(), "p", aiderProvider, "   ")!;
    expect(cfg.readFiles).toBeUndefined();
    expect(cfg.startupPrompt).toBeUndefined();
  });
});

describe("buildSessionSettings", () => {
  it("confines file tools by default on an ungated pane, leaving commands otherwise unrestricted", () => {
    const s = mkStore({ deniedCommands: ["rm -rf"] });
    const out = buildSessionSettings(s, "p");
    expect(out.allowedCommands).toEqual([]);
    expect(out.bashPosture).toBe("allow");
    expect(out.skills).toEqual([]);
    expect(out.deniedCommands).toEqual(["rm -rf"]); // passes the global denies through
    // FS confinement (bsc-confine, #158) + the dangerous-command floor (bsc-deny, #1916) are the
    // DEFAULT denies — present even with no role/profile — alongside the always-on turn-activity
    // hooks. The audit/scope/taint hooks stay gated.
    // #4005 adds `bsc-activity attn` (the Notification hook) to the always-on turn set — it sits with
    // the other turn-activity hooks because it IS one: the same log, cleared by the same boundaries.
    expect(cmds(out)).toEqual([
      "bsc-confine", "bsc-deny", "bsc-activity run", "bsc-activity attn", "bsc-activity idle",
      "bsc-activity idle", "bsc-tokens", "bsc-tokens",
    ]);
    // ...and the confinement config is write-protected on every pane, so the agent can't edit
    // `.claude/**` to remove the hook or widen its own permissions (#1916).
    // ONE Edit(.claude/**) rule (#3534): Claude Code matches file rules on Edit alone, which covers
    // every file-editing tool — the former Write/MultiEdit/NotebookEdit forms were never enforced.
    expect(out.denyToolRules).toContain("Edit(.claude/**)");
    expect(out.denyToolRules).not.toContain("Write(.claude/**)");
    expect(out.denyToolRules).not.toContain("MultiEdit(.claude/**)");
  });

  it("honours the global bypass posture for an ordinary pane", () => {
    expect(buildSessionSettings(mkStore({ bypassPermissions: false }), "p").bypass).toBe(false);
    expect(buildSessionSettings(mkStore({ bypassPermissions: true }), "p").bypass).toBe(true);
  });

  it("wires bsc-tokens on BOTH Stop and SubagentStop, on every pane (#3452 regression)", () => {
    // The cost regression: bsc-tokens was defined in the rc but registered as a hook NOWHERE, so
    // tokens.log went dead and `bsc logs cost` / the desktop cost UI / `bsc metrics` all read $0.
    // tokens.log is the ONLY per-session token source, so this MUST be present or the whole cost
    // subsystem is blind. Assert the exact event coverage, on an ungated pane AND a gated worker.
    for (const store of [mkStore(), mkStore({ paneRoles: { p: "worker" }, paneFlows: { p: flow("none") } })]) {
      const hooks = buildSessionSettings(store, "p").hooks;
      const tokenEvents = hooks.filter((h) => h.command === "bsc-tokens").map((h) => h.event).sort();
      expect(tokenEvents).toEqual(["Stop", "SubagentStop"]);
    }
  });

  it("forces bypass=true for the DEBUG session regardless of the global posture (#3326)", () => {
    // The full-capability maintenance session is always bypass + role-less — no paneRoles entry, so no
    // role gate — even when the user's global posture is the allow-list.
    const out = buildSessionSettings(mkStore({ bypassPermissions: false }), DEBUG_STUDIO_SESSION_ID);
    expect(out.bypass).toBe(true);
    expect(out.allowedCommands).toEqual([]); // role-less: no restricted role surface
    expect(out.denyToolRules).not.toContain("Task"); // no worker sub-agent block
  });

  it("forces bypass=true for an AUTO-SPAWNED per-request debug session too (#3520)", () => {
    // The spawned per-request session (`debug-studio:req-<id>`) is the same full-capability actor as the
    // standing one: role-less and in the source tree, with the human's PR review as its control gate.
    // Keying the carve-out on the singleton id alone left it falling through to the (off) global toggle,
    // so it stopped to ask for every edit. It must launch bypass even with the global posture off.
    const out = buildSessionSettings(mkStore({ bypassPermissions: false }), "debug-studio:req-7");
    expect(out.bypass).toBe(true);
    expect(out.allowedCommands).toEqual([]); // role-less: no restricted role surface, no write-scope
    expect(out.denyToolRules).not.toContain("Task");
  });

  // ── the per-pane plan (wire-the-namespace-into-the-launch-path) ─────────────────────────────

  it("plans a namespace for a role-carrying pane on a capable host", () => {
    const s = mkStore({ paneRoles: { p: "worker" }, paneFlows: { p: flow("none") } });
    const plan = sandboxPlanFor(s, "p", true);
    expect(plan.backend).toBe("namespace");
    expect(plan.role).toBe("worker");
    expect(plan.namespaceHooks).toBe(true);
  });

  it("does NOT plan a namespace for a role-less pane, because the launcher would refuse it", () => {
    // namespace_argv refuses an absent role rather than launching unsandboxed. Planning one here
    // would make the settings claim a cage the launch never creates — the exact asymmetry that
    // drops the shell gates for an unsandboxed session.
    const plan = sandboxPlanFor(mkStore({}), "man:1", true);
    expect(plan.backend).not.toBe("namespace");
    expect(plan.role).toBeUndefined();
    expect(plan.namespaceHooks).toBe(false);
  });

  it("reports the WSL backend where that is what the legacy path will do", () => {
    // Read from the SAME store fields the distro block downstream reads, so the two cannot disagree.
    const manual = mkStore({ sandboxConsoles: true });
    expect(sandboxPlanFor(manual, "man:1", false).backend).toBe("wsl");
    const identity = mkStore({ paneWslDistro: { p: "bsc-agent-sandbox" } });
    expect(sandboxPlanFor(identity, "p", false).backend).toBe("wsl");
  });

  it("never asks for namespace hooks on the WSL backend", () => {
    // A distro session still has BASH_ENV and bsc, so its shell gates work. Swapping them for
    // /bsc-hook would delete working gates and point at a binary not bound there.
    const s = mkStore({ paneRoles: { p: "worker" }, paneWslDistro: { p: "bsc-agent-sandbox" } });
    const plan = sandboxPlanFor(s, "p", false);
    expect(plan.backend).toBe("wsl");
    expect(plan.namespaceHooks).toBe(false);
    expect(plan.role).toBeUndefined();
  });

  it("plans nothing on a host that cannot isolate, leaving today's launch untouched", () => {
    const s = mkStore({ paneRoles: { p: "worker" }, paneFlows: { p: flow("none") } });
    const plan = sandboxPlanFor(s, "p", false);
    expect(plan.backend).toBe("none");
    expect(plan.namespaceHooks).toBe(false);
    expect(plan.role).toBeUndefined();
    // And the settings it drives are byte-identical to a plain two-arg call.
    expect(buildSessionSettings(s, "p", plan.namespaceHooks).hooks)
      .toEqual(buildSessionSettings(s, "p").hooks);
  });

  // ── which backend, and what that implies (one policy, two backends) ─────────────────────────

  it("prefers the namespace when a host can provide one", () => {
    // Per-agent, proven by an escape test that EXECUTES a sibling-worktree read and gets ENOENT,
    // and measured at 17 ms + 262 kB per agent. Cheapest and strongest — so it wins.
    expect(resolveSandboxBackend({ namespaceAvailable: true, agentSandboxInstalled: true }))
      .toBe("namespace");
    expect(resolveSandboxBackend({ namespaceAvailable: true, agentSandboxInstalled: false }))
      .toBe("namespace");
  });

  it("falls back to the sealed distro rather than to nothing", () => {
    // A Windows host has no mount namespace, but the WSL2 distro is REAL isolation that already
    // satisfies the raw-Bash cross-worktree criteria. Falling through to "none" there would give up
    // isolation the machine can actually provide.
    expect(resolveSandboxBackend({ namespaceAvailable: false, agentSandboxInstalled: true }))
      .toBe("wsl");
  });

  it("reports none ONLY when the host genuinely cannot isolate", () => {
    // There is no "off" input by design. `none` means the host cannot, never that someone declined
    // — a setting that can turn isolation off is one that will be off on the machine where it
    // mattered. This is what "sandboxed by default, no toggle" means in code.
    expect(resolveSandboxBackend({ namespaceAvailable: false, agentSandboxInstalled: false }))
      .toBe("none");
  });

  it("swaps the hook list for ONLY the namespace backend", () => {
    // The asymmetry that makes this a separate question from "is it sandboxed": a WSL distro
    // session still has BASH_ENV and still has `bsc`, so its shell gates work. Swapping its list
    // for /bsc-hook would DELETE working gates and point at a binary not bound there.
    expect(usesNamespaceHooks("namespace")).toBe(true);
    expect(usesNamespaceHooks("wsl")).toBe(false);
    expect(usesNamespaceHooks("none")).toBe(false);
  });

  it("never claims a backend the host did not report", () => {
    // Fails closed. Claiming an unavailable backend is what makes a caller drop the shell gates for
    // a session that never got a cage — the one regression this whole path is shaped to avoid.
    for (const ns of [true, false]) {
      for (const wsl of [true, false]) {
        const got = resolveSandboxBackend({ namespaceAvailable: ns, agentSandboxInstalled: wsl });
        if (got === "namespace") expect(ns).toBe(true);
        if (got === "wsl") expect(wsl).toBe(true);
      }
    }
  });

  // ── the SANDBOXED hook list (a-sandboxed-session-can-launch-its-harness) ────────────────────

  it("leaves the hook list byte-identical when a session is not sandboxed", () => {
    // The `sandboxed` parameter is additive and defaults false. Every existing caller passes two
    // arguments, so nothing about a normal launch may move.
    const s = mkStore({ paneRoles: { p: "worker" }, paneFlows: { p: flow("none") } });
    expect(buildSessionSettings(s, "p").hooks).toEqual(buildSessionSettings(s, "p", false).hooks);
  });

  it("gives a sandboxed session ONLY the two gates a namespace cannot express", () => {
    const s = mkStore({ paneRoles: { p: "worker" }, paneFlows: { p: flow("none") } });
    const out = buildSessionSettings(s, "p", true);
    expect(out.hooks).toEqual([
      { event: "PreToolUse", matcher: "Edit|Write|MultiEdit|NotebookEdit", command: "/bsc-hook scope" },
      { event: "PreToolUse", matcher: "Bash", command: "/bsc-hook bash-deny" },
    ]);
  });

  it("drops bsc-confine from a sandboxed session because the MOUNT subsumes it", () => {
    // Not an oversight and not a weakening: an out-of-root path inside a namespace is ABSENT
    // rather than refused, for every descendant process — which is strictly stronger than the
    // hook, and unlike the hook it survives a fork.
    const s = mkStore({ paneRoles: { p: "worker" }, paneFlows: { p: flow("none") } });
    expect(cmds(buildSessionSettings(s, "p", true))).not.toContain("bsc-confine");
  });

  it("emits NO shell-based gate to a sandboxed session, because none of them can run there", () => {
    // Inside a namespace there is no `bsc` binary and no BASH_ENV, so every one of these is
    // unreachable. Emitting a command that cannot run is worse than emitting none — it reads like
    // a working gate in every settings dump and in the permission log's silence.
    //
    // THE LOSS IS REAL: a sandboxed session has no tool-attempt telemetry and no supply-chain gate.
    // This test exists so that stays a decision rather than becoming a surprise.
    const s = mkStore({ paneRoles: { p: "worker" }, paneFlows: { p: flow("none") } });
    const c = cmds(buildSessionSettings(s, "p", true));
    for (const shellGate of [
      "bsc-audit", "bsc-mcp", "bsc-taint", "bsc-supply", "bsc-fork",
      "bsc-superseded", "bsc-skill", "bsc-activity run", "bsc-tokens",
    ]) {
      expect(c).not.toContain(shellGate);
    }
  });

  it("points the sandboxed gates at the SAME guest path bsc-sandbox binds", () => {
    // HOOK_GUEST_PATH is hard-coded on both sides (here and crates/bsc-sandbox/src/lib.rs). A
    // mismatch does not error — it produces a gate that silently never fires, which is the one
    // failure mode worth a test of its own.
    const s = mkStore({ paneRoles: { p: "worker" }, paneFlows: { p: flow("none") } });
    for (const c of cmds(buildSessionSettings(s, "p", true))) {
      expect(c.startsWith("/bsc-hook ")).toBe(true);
    }
  });

  it("installs the audit/confine/scope/taint/supply hooks for a worker role — and NO Stop bounce", () => {
    const s = mkStore({ paneRoles: { p: "worker" }, paneFlows: { p: flow("none") } });
    const out = buildSessionSettings(s, "p");
    const c = cmds(out);
    // bsc-supply (#3799) is a GATED hook — present on this agent pane, absent from the ungated pane
    // asserted above (the supply-chain add gate targets agents, not the maintainer's manual console).
    expect(c).toEqual(expect.arrayContaining(["bsc-audit", "bsc-mcp", "bsc-confine", "bsc-deny", "bsc-scope", "bsc-taint", "bsc-supply", "bsc-superseded"]));
    // #session-stop-is-honoured: `bsc-defer` is GONE. It refused a worker's Stop while work remained,
    // so a session could not end — measured at 66 bounces on a ~90s cadence for one worker.
    expect(c).not.toContain("bsc-defer");
    // The turn-activity + cost hooks still trail on Stop; nothing can block that Stop now.
    expect(c.slice(-6)).toEqual([
      "bsc-activity run", "bsc-activity attn", "bsc-activity idle", "bsc-activity idle",
      "bsc-tokens", "bsc-tokens",
    ]);
    // role denies flow through; Task is denied for a worker (sub-agent block #1036).
    const cap = roleCapability("worker", { writeGlobs: [] });
    expect(out.deniedCommands).toEqual(expect.arrayContaining(roleDeniedCommands(cap)));
    expect(out.denyToolRules).toEqual(expect.arrayContaining(roleDeniedTools(cap)));
  });

  it("gates a worker's EDITS on the superseded notice, and only a worker's (#4240)", () => {
    // Two actors can land the same issue; the completion is already on the coordination wire but never
    // reached the session. This delivers it — on the mutating tools, because that is where the cost of
    // not knowing is incurred (a conflicting PR), and before the edit rather than at Stop.
    const worker = buildSessionSettings(mkStore({ paneRoles: { p: "worker" }, paneFlows: { p: flow("none") } }), "p");
    const gate = worker.hooks.find((h) => h.command === "bsc-superseded");
    expect(gate).toBeDefined();
    expect(gate!.event).toBe("PreToolUse");
    expect(gate!.matcher).toBe("Edit|Write|MultiEdit|NotebookEdit");

    // A DIRECTOR coordinates rather than doing the work, so it is not the actor at risk of duplicating
    // it — and it is frequently the pane that emitted the completion in the first place.
    const director = buildSessionSettings(mkStore({ paneRoles: { p: "director" }, paneFlows: { p: flow("none") } }), "p");
    expect(cmds(director)).not.toContain("bsc-superseded");
  });

  it("lifts the flow's granted push commands from the role denies under an auto-pr flow (#304)", () => {
    const cap = roleCapability("worker", { writeGlobs: [] });
    const roleDenies = roleDeniedCommands(cap);
    const granted = flowGrantedPushCommands(flow("auto-pr"));
    const out = buildSessionSettings(mkStore({ paneRoles: { p: "worker" }, paneFlows: { p: flow("auto-pr") } }), "p");
    for (const g of granted) expect(out.deniedCommands).not.toContain(g);
    for (const d of roleDenies.filter((x) => !granted.includes(x))) expect(out.deniedCommands).toContain(d);
  });

  it("NO role gets a Stop hook that can refuse the stop — a finished session stays finished", () => {
    // The invariant, asserted over every role rather than the one that regressed: the only Stop hooks
    // left are pure accounting (`bsc-activity idle`, `bsc-tokens`), which RECORD the turn boundary
    // without preventing it. Resuming a stopped session is the user's click.
    const BLOCKING_STOP_HOOKS = ["bsc-defer", "bsc-continue"];
    for (const role of ["worker", "director", "planner", "triage", "designer", "librarian", "curator"]) {
      const out = buildSessionSettings(mkStore({ paneRoles: { p: role } }), "p");
      const stopCmds = out.hooks.filter((h) => h.event === "Stop").map((h) => h.command);
      for (const blocking of BLOCKING_STOP_HOOKS) {
        expect(stopCmds, `${role} must not carry ${blocking}`).not.toContain(blocking);
      }
      // ...and the accounting ones survive, or a stop would stop being observable.
      expect(stopCmds, role).toContain("bsc-activity idle");
      expect(stopCmds, role).toContain("bsc-tokens");
    }
  });

  it("gates a director without ANY Stop bounce (unrestricted, non-worker)", () => {
    const c = cmds(buildSessionSettings(mkStore({ paneRoles: { p: "director" } }), "p"));
    expect(c).toContain("bsc-audit");
    expect(c).not.toContain("bsc-defer");
    expect(c).not.toContain("bsc-continue"); // #3580: the studio bsc-continue Stop hook was removed
  });

  it("gives a restricted STUDIO role NO Stop-bounce — its keep-going is the loop pump, not a hook (#3580)", () => {
    // #3547 installed bsc-continue for every studio role; #3580 dropped it. Keep-going in loop mode is the
    // app-side loop pump (useDesignerLoopPump, #3292), so an interactive studio session stops and hands
    // back instead of being told to power through a queue that isn't there. The pane is still gated.
    for (const role of ["designer", "librarian", "sound-designer", "architect", "curator"]) {
      const c = cmds(buildSessionSettings(mkStore({ paneRoles: { p: role } }), "p"));
      expect(c, role).not.toContain("bsc-continue");
      expect(c, role).not.toContain("bsc-defer");
      expect(c, role).toContain("bsc-audit");
    }
  });

  it("takes allowedCommands + bashPosture from the assigned profile", () => {
    const build = PROFILES.find((p) => p.id === "pf_auto")!;
    const out = buildSessionSettings(mkStore({ paneProfiles: { p: "pf_auto" }, agentProfiles: PROFILES }), "p");
    const prof = resolveProfileSettings(build);
    expect(out.allowedCommands).toEqual(prof.allowedCommands);
    expect(out.allowedCommands).toContain("cargo");
    expect(out.bashPosture).toBe(build.tools.bash);
  });

  // Every studio surface is a `bsc loop` participant (#3262); `stop` is withheld — see sessionRoles.test.ts.
  const CURATOR_LOOP = ["bsc loop new", "bsc loop say", "bsc loop watch", "bsc loop show", "bsc loop list"];
  it("grants a curator pane its fixed bsc ui/graph store surface on top of the profile (#3095)", () => {
    // No profile assigned ⇒ the curator's WHOLE auto-run surface is the two store CLIs it harvests +
    // optimizes with (`bsc ui`, `bsc graph`). Layered, not replaced — see the profile case below.
    const bare = buildSessionSettings(mkStore({ paneRoles: { p: "curator" } }), "p");
    expect(bare.allowedCommands).toEqual(["bsc ui", "bsc graph", ...CURATOR_LOOP]);
    // With a profile, the fixed surface is APPENDED to the profile's own allowedCommands.
    const withProf = buildSessionSettings(
      mkStore({ paneRoles: { p: "curator" }, paneProfiles: { p: "pf_auto" }, agentProfiles: PROFILES }),
      "p",
    );
    const prof = resolveProfileSettings(PROFILES.find((x) => x.id === "pf_auto")!);
    expect(withProf.allowedCommands).toEqual([...prof.allowedCommands, "bsc ui", "bsc graph", ...CURATOR_LOOP]);
    // Every OTHER role is unchanged — the store surface is curator-only, so a worker never auto-runs it.
    const worker = buildSessionSettings(mkStore({ paneRoles: { p: "worker" } }), "p");
    expect(worker.allowedCommands).not.toContain("bsc ui");
    expect(worker.allowedCommands).not.toContain("bsc graph");
  });

  it("tightens a curator pane to restrictedAllow with Read kept, leaving other roles unrestricted (#3098)", () => {
    // The curator suppresses the Bash baselines (restrictedAllow) so its ONLY auto-run command surface
    // is bsc ui/graph — but it keeps the Read TOOL to read generated source before harvesting it.
    const curator = buildSessionSettings(mkStore({ paneRoles: { p: "curator" } }), "p");
    expect(curator.restrictedAllow).toBe(true);
    expect(curator.allowToolRules).toContain("Read");
    // No fixed store surface ⇒ no tightening: a worker keeps its posture-scaled baselines and does NOT
    // get the extra Read grant (Read is folded in only for a restricted role here).
    const worker = buildSessionSettings(mkStore({ paneRoles: { p: "worker" } }), "p");
    expect(worker.restrictedAllow).toBe(false);
    expect(worker.allowToolRules).not.toContain("Read");
    // An ungated pane is likewise unrestricted.
    expect(buildSessionSettings(mkStore(), "p").restrictedAllow).toBe(false);
  });

  // #3357 SECURITY REGRESSION GUARD. The designer/librarian/architect studio sessions were migrated off
  // their bespoke `ensure_session_settings` call onto this generic builder. Their whole confinement now
  // derives from ONE store field — `paneRoles[paneId]` — with deliberately NO `paneProfiles` entry, since
  // a profile's `allowedCommands` are ADDED to the restricted surface (see the curator case above) and
  // would silently hand a `bsc ui`-only session a general shell. This asserts the migrated payload is the
  // one the bespoke launch produced: exactly `restrictedRoleCommands(role)` auto-runs, the baselines are
  // suppressed, Read is granted, git/gh + every write/web tool are denied, and bypass can never be flipped
  // on for them.
  it.each(["designer", "librarian", "architect"] as const)(
    "renders the RESTRICTED studio payload for a %s pane carrying only a role (#3357)",
    (role) => {
      const s = mkStore({ paneRoles: { p: role } });
      const out = buildSessionSettings(s, "p");
      const cap = roleCapability(role);

      // The whole auto-run command surface is the role's fixed store CLI — nothing from a profile.
      expect(out.allowedCommands).toEqual(restrictedRoleCommands(role));
      expect(out.allowedCommands.length).toBeGreaterThan(0);
      // Baselines suppressed + Read granted — `[...write.allow, "Read"]`, where write.allow is the
      // `scratch/**` carve-out (#3373) rather than empty (see the write-tool assertions below).
      expect(out.restrictedAllow).toBe(true);
      expect(out.allowToolRules).toContain("Read");
      // The role gate's denies: git/gh outright, the web tools.
      expect(out.deniedCommands).toEqual(expect.arrayContaining(roleDeniedCommands(cap)));
      expect(out.deniedCommands).toEqual(expect.arrayContaining(["git", "gh"]));
      for (const t of ["WebFetch", "WebSearch"]) {
        expect(out.denyToolRules).toContain(t);
      }
      // The write tools are NOT denied wholesale (#3428/#3373): a studio carries the `scratch/**`
      // carve-out, so they are auto-approved for exactly that sealed staging dir and nothing else.
      // Claude Code's precedence is deny > allow, so a bare deny here would mask the carve-out and
      // leave the session unable to stage the payload `bsc <store> set --file` reads.
      for (const t of ["Edit", "Write", "NotebookEdit"]) {
        expect(out.denyToolRules).not.toContain(t); // no wholesale write deny — the carve-out must survive
      }
      // The carve-out is one Edit(scratch/**) allow (#3534): Edit(path) covers Write/NotebookEdit too.
      expect(out.allowToolRules).toContain("Edit(scratch/**)");
      // A restricted role is NEVER bypass — bypass ignores permissions.deny, which would undo all of it.
      expect(out.bypass).toBe(false);
      expect(buildSessionSettings(mkStore({ paneRoles: { p: role }, bypassPermissions: true }), "p").bypass).toBe(false);
      // The runtime scope doc the studio launch also carried (`BSC_SCOPES`) still comes out of the env
      // builder. Since #3373 the write scope is the sealed staging dir (`scratch/**`) rather than the
      // deny-all sentinel — bsc-scope hard-blocks every write outside it, surviving bypassPermissions.
      const env = buildAgentEnv(s, "p", "claude", "")!;
      expect(env.BSC_SCOPES).toBe(JSON.stringify(sessionScopes(cap)));
      expect(env.BSC_SCOPE_GLOBS).toBe("scratch/**");
    },
  );

  // #3428 — the regression this pins. `paneRoleGlobs` is written ONLY by `fleetStartProject`, so every
  // non-fleet pane reaches buildSessionSettings with an empty entry. Passing that straight through as an
  // override REPLACED the role table's own `writeGlobs` (roleCapability is a plain spread), which silently
  // erased both scoped carve-outs. The builder must FLOOR the empty case, exactly as `scopeWriteGlobs`
  // does — otherwise the launch settings and the bsc-scope hook disagree about the same boundary.
  it.each([
    ["designer", "scratch/**"],
    ["documentor", undefined],
  ] as const)("floors an EMPTY paneRoleGlobs to the %s role's own writeGlobs (#3428)", (role, glob) => {
    const out = buildSessionSettings(mkStore({ paneRoles: { p: role } }), "p");
    const expected = glob ? [glob] : roleCapability(role).writeGlobs;
    expect(expected.length).toBeGreaterThan(0);
    // The carve-out survives: per-glob allows, and NO bare write-tool deny to mask them.
    for (const g of expected) expect(out.allowToolRules).toContain(`Edit(${g})`); // path rules are Edit-only (#3534)
    expect(out.denyToolRules).not.toContain("Write");
    // The launch payload and the runtime hook agree on one boundary.
    expect(scopeWriteGlobs(role, [])).toEqual(expected);
  });

  it("assigned owned globs still OVERRIDE the role default (#3428 must not regress the worker lane)", () => {
    const owned = ["src/features/glance/**"];
    const out = buildSessionSettings(mkStore({ paneRoles: { p: "worker" }, paneRoleGlobs: { p: owned } }), "p");
    expect(out.allowToolRules).toContain("Edit(src/features/glance/**)"); // path rules are Edit-only (#3534)
    expect(scopeWriteGlobs("worker", owned)).toEqual(owned);
  });

  it("a PROFILE would widen a studio pane — so the studio mount must never assign one (#3357)", () => {
    // Documents WHY `StudioSessionMount` sets `paneRoles` and nothing else. If a profile ever leaks onto a
    // studio pane, its allowedCommands are prepended to the restricted surface and the confinement is gone.
    const withProfile = buildSessionSettings(
      mkStore({ paneRoles: { p: "designer" }, paneProfiles: { p: "pf_auto" }, agentProfiles: PROFILES }),
      "p",
    );
    expect(withProfile.allowedCommands).not.toEqual(restrictedRoleCommands("designer"));
    expect(withProfile.allowedCommands.length).toBeGreaterThan(restrictedRoleCommands("designer").length);
  });

  it("installs the bsc-skill telemetry hooks when the session has skills, not otherwise", () => {
    expect(cmds(buildSessionSettings(mkStore(), "p"))).not.toContain("bsc-skill");
    const withSkill = mkStore({ paneSkills: { p: [{ name: "My Skill", desc: "d", prompt: "do x" }] } });
    expect(cmds(buildSessionSettings(withSkill, "p"))).toContain("bsc-skill");
  });
});

describe("resolveEffectiveInitCmd", () => {
  const provider = { buildLaunchCmd: () => "ollama run x" } as unknown as ConsoleProvider;

  it("launches a non-claude provider via its own command, unless an explicit initCmd is given", () => {
    expect(resolveEffectiveInitCmd(mkStore(), "p", false, undefined, undefined, provider)).toBe("ollama run x");
    expect(resolveEffectiveInitCmd(mkStore(), "p", false, "custom", undefined, provider)).toBe("custom");
  });

  it("builds the full aider command from the pane config — model, worker scope, fleet-safe git, task (#1172)", () => {
    const s = mkStore({ paneRoles: { p: "worker" }, llmProvider: "anthropic", claudeApiKey: "k" });
    const cmd = resolveEffectiveInitCmd(s, "p", false, undefined, "do it", aiderProvider);
    expect(cmd).toBe(
      "aider --no-auto-commits --no-dirty-commits --model 'anthropic/claude-sonnet-4-6' --read 'CLAUDE.local.md' --message 'do it'",
    );
  });

  it("honors an explicit initCmd for a claude pane", () => {
    expect(resolveEffectiveInitCmd(mkStore(), "p", true, "claude --foo", undefined, provider)).toBe("claude --foo");
  });

  it("does not inject an init cmd when a startup prompt drives the baked launch", () => {
    const s = mkStore({ paneWasClaude: { p: true } });
    expect(resolveEffectiveInitCmd(s, "p", true, undefined, "kickoff…", provider)).toBe("");
  });

  it("resumes a crashed claude pane (restore requested), but never a manual console", () => {
    const positional = mkStore({ paneWasClaude: { t0p0: true }, restoreRequested: { t0p0: true } });
    expect(resolveEffectiveInitCmd(positional, "t0p0", true, undefined, undefined, provider)).toBe("claude --continue 2>/dev/null || claude");

    // A manual pane (man:…) suppresses both auto-resume and restore (#1176), even after an unclean shutdown.
    const manual = mkStore({ paneWasClaude: { "man:tab:p0": true }, autoResumeClaude: true, uncleanShutdown: true, restoreRequested: { "man:tab:p0": true } });
    expect(resolveEffectiveInitCmd(manual, "man:tab:p0", true, undefined, undefined, provider)).toBe("");
  });

  it("silently auto-resumes a non-manual claude pane after an unclean shutdown when opted in", () => {
    const s = mkStore({ paneWasClaude: { t0p1: true }, autoResumeClaude: true, uncleanShutdown: true });
    expect(resolveEffectiveInitCmd(s, "t0p1", true, undefined, undefined, provider)).toBe("claude --continue 2>/dev/null || claude");
  });
});

describe("resolveStartupPromptFreshOnly (#2052)", () => {
  it("is true only on a crash-restore remount of a claude pane", () => {
    const restored = mkStore({ restoreRequested: { t0p0: true } });
    expect(resolveStartupPromptFreshOnly(restored, "t0p0", true)).toBe(true);
  });

  it("is false on a normal launch (no restore requested) — so triage/fleet kickoffs still deliver", () => {
    expect(resolveStartupPromptFreshOnly(mkStore(), "t0p0", true)).toBe(false);
  });

  it("is false for a manual console even when a restore was requested (#1176)", () => {
    const s = mkStore({ restoreRequested: { "man:tab:p0": true } });
    expect(resolveStartupPromptFreshOnly(s, "man:tab:p0", true)).toBe(false);
  });

  it("is false for a non-claude provider", () => {
    const s = mkStore({ restoreRequested: { t0p0: true } });
    expect(resolveStartupPromptFreshOnly(s, "t0p0", false)).toBe(false);
  });

  it("is true for the DEBUG session even without a restore — its charter is fresh-only across resumes (#3326)", () => {
    // The debug session launches with `claude --continue`, so its inline charter must drop on a resume
    // (delivered only on the first, history-less launch). Matches the old useScreenSession's freshOnly:true.
    expect(resolveStartupPromptFreshOnly(mkStore(), DEBUG_STUDIO_SESSION_ID, true)).toBe(true);
  });

  it("is true for every app-owned STUDIO session — their persona kickoff must not re-fire on resume (#3357)", () => {
    // Migrating the designer/librarian/architect onto the generic launch path had to preserve the bespoke
    // `startupPromptFreshOnly: true`: they launch with `claude --continue`, so re-baking the persona
    // kickoff would re-instruct an already-running conversation on every re-open.
    for (const id of [designerSessionId("react"), librarianSessionId("rust"), TEAMS_STUDIO_SESSION_ID]) {
      expect(resolveStartupPromptFreshOnly(mkStore(), id, true)).toBe(true);
    }
  });
});

// #3423: `paneRoles` is written only by `seedStudioLaunchState`, inside `StudioSessionMount`'s effect —
// which renders only for a studio in `wantedStudios`, a transient set that is empty after every restart.
// A studio opened in that window launched with NO role, and a missing role means no gate, no
// restrictedAllow and no denies: an unconfined general shell on the app's most restricted surface.
// The role is now derived from the (stable, app-owned) pane id, so confinement travels with identity.
describe("studio confinement survives an unseeded store (#3423)", () => {
  const STUDIOS = [designerSessionId("react"), librarianSessionId("rust"), TEAMS_STUDIO_SESSION_ID];

  it("a studio pane with an EMPTY paneRoles is still confined — the regression", () => {
    for (const paneId of STUDIOS) {
      const r = buildSessionSettings(mkStore({ paneRoles: {} }), paneId);
      expect(r.restrictedAllow).toBe(true);
      expect(r.allowedCommands.length).toBeGreaterThan(0);
      // A confined studio must NEVER be flipped to bypass — that ignores permissions.deny outright.
      expect(r.bypass).toBe(false);
    }
  });

  it("derives the SAME settings whether the store seeded the role or not", () => {
    const seeded = buildSessionSettings(mkStore({ paneRoles: { [designerSessionId("react")]: "designer" } }), designerSessionId("react"));
    const bare = buildSessionSettings(mkStore({ paneRoles: {} }), designerSessionId("react"));
    expect(bare.allowedCommands).toEqual(seeded.allowedCommands);
    expect(bare.deniedCommands).toEqual(seeded.deniedCommands);
    expect(bare.restrictedAllow).toEqual(seeded.restrictedAllow);
  });

  it("each studio pane derives its OWN role, never another's surface", () => {
    const designer = buildSessionSettings(mkStore({ paneRoles: {} }), designerSessionId("react"));
    const librarian = buildSessionSettings(mkStore({ paneRoles: {} }), librarianSessionId("typescript"));
    expect(designer.allowedCommands).toContain("bsc ui");
    expect(librarian.allowedCommands).not.toContain("bsc ui");
    expect(librarian.allowedCommands).toContain("bsc graph");
  });

  // The fallback is studio-ONLY: a normal pane with no role keeps its existing (unrestricted) behaviour,
  // so this cannot silently confine a manual console.
  it("leaves a non-studio pane's roleless behaviour unchanged", () => {
    const r = buildSessionSettings(mkStore({ paneRoles: {} }), "t0p0");
    expect(r.restrictedAllow).toBeFalsy();
  });
});

// ── the pane's PERSONA decides its capability (epic `the-persona-is-the-whole-agent`) ─────────────
//
// The gap this closes: `applyPersonaToPane` stored `persona.role`, so a user persona derived from
// `worker` with a NARROWED floor was assigned to a pane and then launched with the FULL worker
// capability. The narrowing lived on the persona and only the role name travelled — the one moment it
// had to survive was the one place it did not.
//
// These drive the real builders against a store snapshot, so they assert what a session actually gets.
// Each narrowing case is paired with the SAME store minus the persona binding, because the claim is a
// DIFFERENCE ("the persona is what changed this"), and a one-sided assertion would still pass if the
// role happened to produce the same denies.
describe("launch resolves MCP SERVERS from the pane's persona too", () => {
  // The same primitive as the capability block below, applied to the axis that was left behind.
  // Three mechanisms used to answer this — project scoping, per-stream assignment, and a per-pane
  // override map — and all three are gone.
  const server = (id: string, over: Record<string, unknown> = {}) => ({
    id, name: id, enabled: true, projects: [], transport: "stdio", command: "x", ...over,
  });
  const carrier = (mcp: string[]) => ({
    id: "p-carrier", name: "Carrier", blurb: "", role: "worker", startPrompt: "", skills: [], mcp,
  });
  const withPersona = (mcp: string[], servers: unknown[]) => mkStore({
    personas: [carrier(mcp)], panePersonas: { p: "p-carrier" }, paneRoles: { p: "worker" },
    mcpServers: servers,
  });
  const names = (s: AppStore) =>
    JSON.parse(buildAgentEnv(s, "p", "bsc-agent", "")?.BSC_AGENT_MCP ?? "[]").map((m: { name: string }) => m.name);

  it("gives the session what its persona carries", () => {
    expect(names(withPersona(["acme"], [server("acme")]))).toContain("acme");
  });

  it("does NOT give it a stored server nobody carries", () => {
    // Under project scoping this server was global and every session got it. That is the behaviour
    // this slice deliberately removes: reaching a session now requires being carried.
    expect(names(withPersona([], [server("acme")]))).not.toContain("acme");
  });

  it("still gives every session the ambient built-ins", () => {
    // A persona carrying nothing is a working session, not a toolless one.
    expect(names(withPersona([], []))).toContain("Research");
  });

  it("a pane with NO persona gets the built-ins and nothing else", () => {
    // An interactive console, or a pane whose persona was deleted.
    const s = mkStore({ paneRoles: { p: "worker" }, mcpServers: [server("acme")] });
    expect(names(s)).toContain("Research");
    expect(names(s)).not.toContain("acme");
  });
});

describe("launch resolves capability from the pane's PERSONA, not its role name", () => {
  /** A persona on the `worker` role whose floor is deliberately tighter than the worker row. */
  const narrowed = {
    id: "p-narrow", name: "Narrow worker", blurb: "", role: "worker", startPrompt: "", skills: [],
    derivesFrom: "persona-worker",
    floor: { github: "none", git: "none", code: "none", net: "none", ui: "none" },
  };

  const bound = (extra: Record<string, unknown> = {}) => mkStore({
    personas: [narrowed],
    panePersonas: { p: "p-narrow" },
    paneRoles: { p: "worker" },   // the role is STILL set, exactly as applyPersonaToPane leaves it
    ...extra,
  });
  const roleOnly = () => mkStore({ paneRoles: { p: "worker" } });
  const bashDenies = (s: AppStore) => buildAgentEnv(s, "p", "claude", "")?.BSC_DENY_BASH?.split("\n") ?? [];

  it("denies the persona what its ROLE would have allowed", () => {
    // `worker` is git:write; the persona says git:none, and a `none` tier denies the whole program.
    expect(bashDenies(bound())).toContain("git");
    expect(bashDenies(roleOnly())).not.toContain("git");   // the difference is the persona
  });

  it("carries the narrowing into the write-tool rules, not just the shell denies", () => {
    // code:none ⇒ the whole-tool write deny. Two different enforcement surfaces read the same
    // capability, and a fix reaching only one of them would be half a fix.
    expect(buildSessionSettings(bound(), "p").denyToolRules).toContain("Write");
    expect(buildSessionSettings(roleOnly(), "p").denyToolRules).not.toContain("Write");
  });

  it("carries it into the bsc-agent permission doc too", () => {
    // BSC_AGENT_PERMS is emitted ONLY for the `bsc-agent` provider — the model-agnostic runtime reads
    // its own permission doc where Claude reads settings.json. Both must see the narrowing, since the
    // whole point of the role gate is that it does not depend on which harness drives the session.
    const perms = JSON.parse(buildAgentEnv(bound(), "p", "bsc-agent", "")?.BSC_AGENT_PERMS ?? "{}");
    expect(perms.deny_bash).toContain("git");
    const wide = JSON.parse(buildAgentEnv(roleOnly(), "p", "bsc-agent", "")?.BSC_AGENT_PERMS ?? "{}");
    expect(wide.deny_bash).not.toContain("git");
  });

  it("a pane with NO persona and NO role still launches exactly as before", () => {
    expect(buildSessionSettings(mkStore(), "p")).toBeTruthy();  // no capability ⇒ no role gate
  });

  it("a STALE persona id falls back to the role rather than failing open or closed", () => {
    // Persona deleted, pane not yet re-seeded. Must degrade to the role — the behaviour from before
    // personas were bound at all — rather than silently dropping the gate.
    const stale = mkStore({ personas: [], panePersonas: { p: "p-gone" }, paneRoles: { p: "worker" } });
    expect(bashDenies(stale)).not.toContain("git");
    expect(bashDenies(stale)).toEqual(bashDenies(roleOnly()));
  });

  it("a floor that OMITS writeGlobs does not produce an undefined where the type promises an array", () => {
    // REGRESSION. `writeGlobs` is required on RoleCapability and optional on a floor, and the packaged
    // floors omit it whenever it is empty — so `persona-worker` genuinely has no such key. The
    // `as Omit<RoleCapability, "role">` cast asserted the required shape without supplying it, handing
    // `roleWriteRules` / `hasScopedWriteCarveOut` / `scopeWriteGlobs` an `undefined` the type says
    // cannot occur. Found by the Teams panel, which throws on `cap.writeGlobs.length` — the launch path
    // merely misbehaved quietly, which is worse.
    const noGlobs = {
      id: "p-noglobs", name: "No globs", blurb: "", role: "worker", startPrompt: "", skills: [],
      floor: { github: "read", git: "write", code: "write", net: "read", ui: "read" },  // no writeGlobs
    };
    const s = mkStore({ personas: [noGlobs], panePersonas: { p: "p-noglobs" }, paneRoles: { p: "worker" } });
    expect(() => buildSessionSettings(s, "p")).not.toThrow();
    expect(() => buildAgentEnv(s, "p", "bsc-agent", "")).not.toThrow();
  });

  it("a persona with NO floor falls back to its role — floor is optional on the type", () => {
    const noFloor = mkStore({
      personas: [{ ...narrowed, floor: undefined }],
      panePersonas: { p: "p-narrow" }, paneRoles: { p: "worker" },
    });
    expect(bashDenies(noFloor)).toEqual(bashDenies(roleOnly()));
  });
});
