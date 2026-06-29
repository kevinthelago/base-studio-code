import { describe, it, expect } from "vitest";
import { buildAgentEnv, buildSessionSettings, resolveEffectiveInitCmd } from "./sessionLaunch";
import { roleCapability, roleDeniedCommands, roleDeniedTools, scopeWriteGlobs, bscAgentPerms } from "@/shared/lib/session/sessionRoles";
import { flowGrantedPushCommands } from "@/features/planner/fleet/flowPermissions";
import { resolveProfileSettings } from "@/features/agents/lib/profileEnforcement";
import { PROFILES } from "@/features/agents/lib/agentProfiles";
import type { AppStore } from "@/store/types";
import type { ConsoleProvider } from "@/app/console/lib/providers";
import type { AgentFlow } from "@/features/planner/fleet/agentFlow";

// sessionLaunch's builders read a store SNAPSHOT — only a known subset of fields. A partial cast is
// the documented unit-test contract (cf. resolveLlmConfig's `LlmConfigSource`).
function mkStore(overrides: Record<string, unknown> = {}): AppStore {
  return {
    paneRoles: {}, paneRoleGlobs: {}, paneFlows: {}, paneProfiles: {}, agentProfiles: [],
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
