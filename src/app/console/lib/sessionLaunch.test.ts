import { describe, it, expect } from "vitest";
import { buildAgentEnv, buildSessionSettings, resolveEffectiveInitCmd, resolveStartupPromptFreshOnly, providerLaunchConfig, SCOPE_DENY_ALL } from "./sessionLaunch";
import { aiderProvider } from "@/app/console/lib/providers/providers/aider";
import { roleCapability, roleDeniedCommands, roleDeniedTools, scopeWriteGlobs, bscAgentPerms, sessionScopes } from "@/shared/lib/session/sessionRoles";
import { flowGrantedPushCommands } from "@/features/planner/fleet/flowPermissions";
import { resolveProfileSettings } from "@/features/security/lib/profileEnforcement";
import { PROFILES } from "@/features/security/lib/agentProfiles";
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
    paneMcpServers: {}, mcpServers: [], paneHooks: {}, hooks: [],
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
    expect(cmds(out)).toEqual(["bsc-confine", "bsc-deny", "bsc-activity run", "bsc-activity idle", "bsc-activity idle"]);
    // ...and the confinement config is write-protected on every pane, so the agent can't edit
    // `.claude/**` to remove the hook or widen its own permissions (#1916).
    expect(out.denyToolRules).toEqual(expect.arrayContaining(
      ["Edit(.claude/**)", "Write(.claude/**)", "MultiEdit(.claude/**)", "NotebookEdit(.claude/**)"]));
  });

  it("installs the audit/confine/scope/taint hooks + worker Stop-bounce for a worker role", () => {
    const s = mkStore({ paneRoles: { p: "worker" }, paneFlows: { p: flow("none") } });
    const out = buildSessionSettings(s, "p");
    const c = cmds(out);
    expect(c).toEqual(expect.arrayContaining(["bsc-audit", "bsc-mcp", "bsc-confine", "bsc-deny", "bsc-scope", "bsc-taint", "bsc-defer"]));
    // turn-activity hooks remain last (after bsc-defer) so a worker's Stop still records idle.
    expect(c.slice(-3)).toEqual(["bsc-activity run", "bsc-activity idle", "bsc-activity idle"]);
    // role denies flow through; Task is denied for a worker (sub-agent block #1036).
    const cap = roleCapability("worker", { writeGlobs: [] });
    expect(out.deniedCommands).toEqual(expect.arrayContaining(roleDeniedCommands(cap)));
    expect(out.denyToolRules).toEqual(expect.arrayContaining(roleDeniedTools(cap)));
  });

  it("lifts the flow's granted push commands from the role denies under an auto-pr flow (#304)", () => {
    const cap = roleCapability("worker", { writeGlobs: [] });
    const roleDenies = roleDeniedCommands(cap);
    const granted = flowGrantedPushCommands(flow("auto-pr"));
    const out = buildSessionSettings(mkStore({ paneRoles: { p: "worker" }, paneFlows: { p: flow("auto-pr") } }), "p");
    for (const g of granted) expect(out.deniedCommands).not.toContain(g);
    for (const d of roleDenies.filter((x) => !granted.includes(x))) expect(out.deniedCommands).toContain(d);
  });

  it("gates a director without the worker-only Stop bounce", () => {
    const c = cmds(buildSessionSettings(mkStore({ paneRoles: { p: "director" } }), "p"));
    expect(c).toContain("bsc-audit");
    expect(c).not.toContain("bsc-defer");
  });

  it("takes allowedCommands + bashPosture from the assigned profile", () => {
    const build = PROFILES.find((p) => p.id === "pf_auto")!;
    const out = buildSessionSettings(mkStore({ paneProfiles: { p: "pf_auto" }, agentProfiles: PROFILES }), "p");
    const prof = resolveProfileSettings(build);
    expect(out.allowedCommands).toEqual(prof.allowedCommands);
    expect(out.allowedCommands).toContain("cargo");
    expect(out.bashPosture).toBe(build.tools.bash);
  });

  it("grants a curator pane its fixed bsc ui/graph store surface on top of the profile (#3095)", () => {
    // No profile assigned ⇒ the curator's WHOLE auto-run surface is the two store CLIs it harvests +
    // optimizes with (`bsc ui`, `bsc graph`). Layered, not replaced — see the profile case below.
    const bare = buildSessionSettings(mkStore({ paneRoles: { p: "curator" } }), "p");
    expect(bare.allowedCommands).toEqual(["bsc ui", "bsc graph"]);
    // With a profile, the fixed surface is APPENDED to the profile's own allowedCommands.
    const withProf = buildSessionSettings(
      mkStore({ paneRoles: { p: "curator" }, paneProfiles: { p: "pf_auto" }, agentProfiles: PROFILES }),
      "p",
    );
    const prof = resolveProfileSettings(PROFILES.find((x) => x.id === "pf_auto")!);
    expect(withProf.allowedCommands).toEqual([...prof.allowedCommands, "bsc ui", "bsc graph"]);
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
    expect(resolveEffectiveInitCmd(positional, "t0p0", true, undefined, undefined, provider)).toBe("claude --continue");

    // A manual pane (man:…) suppresses both auto-resume and restore (#1176), even after an unclean shutdown.
    const manual = mkStore({ paneWasClaude: { "man:tab:p0": true }, autoResumeClaude: true, uncleanShutdown: true, restoreRequested: { "man:tab:p0": true } });
    expect(resolveEffectiveInitCmd(manual, "man:tab:p0", true, undefined, undefined, provider)).toBe("");
  });

  it("silently auto-resumes a non-manual claude pane after an unclean shutdown when opted in", () => {
    const s = mkStore({ paneWasClaude: { t0p1: true }, autoResumeClaude: true, uncleanShutdown: true });
    expect(resolveEffectiveInitCmd(s, "t0p1", true, undefined, undefined, provider)).toBe("claude --continue");
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
});
