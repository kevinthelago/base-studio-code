// Session-launch composition for TerminalView (#1645). Pure, React-free builders that turn the
// current app-store snapshot into the exact payloads the PTY launch path feeds to the Tauri
// commands (`pty_create` env, `ensure_session_settings`, and the resolved init command). Extracted
// verbatim from TerminalView's mount effect so the renderer stays a lean terminal host while the
// provider/MCP/skills/permissions/init-cmd assembly lives here.
//
// BEHAVIOR CONTRACT: each builder reads the store via the snapshot it's handed and is called at the
// SAME point in the launch sequence as the inline code it replaced. Every read in the original blocks
// was synchronous (no `await` between them), so a single snapshot is identical to the original's
// repeated `useAppStore.getState()` calls. Do not change what is computed, only where it lives.

import { resolveLlmConfig, bscAgentEnv, aiderEnv } from "@/shared/lib/core/llmConfig";
import { resolveMcpServers, toBscAgentMcp, resolveHooks, toSessionPayloads } from "@/features/mcp";
import { effectiveSessionSkills, expandGroups, toSkillCfgs } from "@/features/skills";
import { resolveInitCmd } from "@/app/console/lib/resumeClaude";
import { isManualPaneId } from "@/app/console/lib/paneIdentity";
import { roleCapability, roleDeniedCommands, roleWriteRules, roleDeniedTools, bscAgentPerms, scopeWriteGlobs, sessionScopes, restrictedRoleCommands } from "@/shared/lib/session/sessionRoles";
import { resolveProfileSettings } from "@/features/security";
import { flowPermissionRules, flowGrantedPushCommands } from "@/features/planner";
import type { ConsoleProvider, ProviderLaunchConfig } from "@/app/console/lib/providers";
import type { AppStore } from "@/store/types";

/**
 * Base session env for `pty_create`. Carries `GH_TOKEN` for gh/git-over-https; the write-scope globs
 * (`BSC_SCOPE_GLOBS`) for the `bsc-scope` PreToolUse hook on any gated pane; the role's per-store
 * access scopes (`BSC_SCOPES`, #2470) for the store CLIs' runtime write check; and, for a bsc-agent
 * session, the selected LLM provider/model/key, role-derived perms (`BSC_AGENT_PERMS`) and resolved
 * MCP servers (`BSC_AGENT_MCP`). Returns undefined when nothing needs to be injected.
 *
 * @param s        store snapshot taken at the launch point (after the claude-launch gate)
 * @param paneId   the pane being launched
 * @param providerId  the resolved provider id (default "claude")
 * @param ghToken  the repo-scoped or global GitHub token already resolved for this pane
 */
/** Sentinel `BSC_SCOPE_GLOBS` value meaning "deny ALL file writes" — set for a `code:none` role with
 *  no write globs so the `bsc-scope` PreToolUse hook hard-blocks every Edit/Write (a write-block that
 *  survives `bypassPermissions`, #1916 Step 3.5). MUST match the literal in `bsc-scope` (shell_rc.rs). */
export const SCOPE_DENY_ALL = "__bsc_deny_all__";

export function buildAgentEnv(
  s: AppStore,
  paneId: string,
  providerId: string,
  ghToken: string,
): Record<string, string> | undefined {
  const e: Record<string, string> = {};
  if (ghToken) e.GH_TOKEN = ghToken;
  // Write-scope gate (#1297): hand the session its allowed write globs so the `bsc-scope`
  // PreToolUse hook hard-blocks any write outside them — the hard deny the role gate's
  // allow-only rules lack. Applies to every gated pane.
  const scopeRole = s.paneRoles[paneId];
  if (scopeRole) {
    const roleGlobs = s.paneRoleGlobs[paneId] ?? [];
    const scopeCap = roleCapability(scopeRole, { writeGlobs: roleGlobs });
    const sg = scopeWriteGlobs(scopeRole, roleGlobs);
    if (sg.length > 0) {
      e.BSC_SCOPE_GLOBS = sg.join(" ");
    } else if (scopeCap.code === "none") {
      // code:none with no write globs ⇒ DENY ALL writes (#1916 Step 3.5). The sentinel makes bsc-scope
      // hard-block every Edit/Write — surviving bypassPermissions, where the role's permissions.deny
      // write rule is ignored. (A code:none role WITH globs — e.g. a director's commons — is scoped
      // above; an ungated pane has no scopeRole, so it stays allow-all.)
      e.BSC_SCOPE_GLOBS = SCOPE_DENY_ALL;
    }
    // Store scopes (#2470, defense-in-depth): the role's per-store access tiers (currently just `ui`)
    // for the store CLIs — `bsc ui` refuses its mutating verbs when scoped read-only. Guards accidents
    // + non-Claude runtimes; the launch-time deny rules (sessionDeniedCommands) are the boundary.
    e.BSC_SCOPES = JSON.stringify(sessionScopes(scopeCap));
  }
  // Deny-list (#1916): the session's role/user/profile deny patterns for the `bsc-deny` PreToolUse
  // hook (newline-separated; the dangerous floor itself is compiled into `bsc hook bash-deny`). This
  // carries the role/user denies through the bypassPermissions flip.
  const denies = sessionDeniedCommands(s, paneId);
  if (denies.length > 0) e.BSC_DENY_BASH = denies.join("\n");
  if (providerId === "bsc-agent") {
    Object.assign(e, bscAgentEnv(resolveLlmConfig(s)));
    // Gate the runtime by the pane's role (least-privilege parity with Claude); no role ⇒ permissive.
    const bscRole = s.paneRoles[paneId];
    if (bscRole) {
      const cap = roleCapability(bscRole, { writeGlobs: s.paneRoleGlobs[paneId] ?? [] });
      // Reconcile role ↔ flow (#304): the flow owns git push / gh pr create, so lift them from
      // the role denies when it permits pushing/PRing.
      const granted = flowGrantedPushCommands(s.paneFlows[paneId]);
      e.BSC_AGENT_PERMS = JSON.stringify(bscAgentPerms(cap, granted));
    }
    // MCP: pass the resolved stdio servers so bsc-agent's client connects them ($BSC_AGENT_MCP).
    const { mcp } = toSessionPayloads(s.paneMcpServers[paneId] ?? resolveMcpServers(s.mcpServers, ""), []);
    const bscMcp = toBscAgentMcp(mcp);
    if (bscMcp.length > 0) e.BSC_AGENT_MCP = JSON.stringify(bscMcp);
  }
  if (providerId === "aider") {
    // Aider (#1172): inject the provider's API key env (ANTHROPIC_/OPENAI_/GEMINI_API_KEY, or an
    // OPENAI_API_BASE for a local/ollama OpenAI-compatible endpoint) so the `--model` selected in
    // `buildAiderCommand` can actually reach the configured LLM. GH_TOKEN (added above) lets an Aider
    // worker push + open its PR, exactly like the other providers.
    Object.assign(e, aiderEnv(resolveLlmConfig(s)));
  }
  return Object.keys(e).length > 0 ? e : undefined;
}

/**
 * The per-provider launch config handed to a non-Claude provider's `buildLaunchCmd`. Only Aider
 * (#1172) needs one today: it maps the pane's resolved LLM config, its startup prompt, and a worker's
 * `CLAUDE.local.md` scope into `aider --model … --read … --message …`. Every other provider ignores
 * the config (returns undefined so they launch unchanged).
 */
export function providerLaunchConfig(
  s: AppStore,
  paneId: string,
  provider: ConsoleProvider,
  startupPrompt: string | undefined,
): ProviderLaunchConfig | undefined {
  if (provider.id !== "aider") return undefined;
  return {
    llm: resolveLlmConfig(s),
    startupPrompt: startupPrompt && startupPrompt.trim() ? startupPrompt : undefined,
    // A worker's plan scope (CLAUDE.local.md, copied into the worktree by ensure_worktree) — handed to
    // Aider read-only since it does no ancestor-CLAUDE.md walk. Only workers have one.
    readFiles: s.paneRoles[paneId] === "worker" ? ["CLAUDE.local.md"] : undefined,
  };
}

/**
 * The session's denied Bash command patterns (#1916): the user's global denies + the role's denied
 * commands (minus the pushes the flow grants back) + the profile's denies. The SINGLE source for both
 * the `permissions.deny` rules (buildSessionSettings) and the `$BSC_DENY_BASH` env the `bsc-deny`
 * PreToolUse hook enforces — so role/user denies survive `bypassPermissions`, where `permissions.deny`
 * is ignored but the hook still fires + blocks.
 */
export function sessionDeniedCommands(s: AppStore, paneId: string): string[] {
  const role = s.paneRoles[paneId];
  const cap = role ? roleCapability(role, { writeGlobs: s.paneRoleGlobs[paneId] ?? [] }) : null;
  const profileId = s.paneProfiles[paneId];
  const profile = profileId ? s.agentProfiles.find((p) => p.id === profileId) : undefined;
  const prof = profile ? resolveProfileSettings(profile) : null;
  const granted = flowGrantedPushCommands(s.paneFlows[paneId]);
  const roleDenies = (cap ? roleDeniedCommands(cap) : []).filter((d) => !granted.includes(d));
  return [...s.deniedCommands, ...roleDenies, ...(prof?.deniedCommands ?? [])];
}

/**
 * The permission + extension payload for `ensure_session_settings` (everything except `cwd` and
 * `replacePermissions`, which the caller adds). Composes the role gate (#219), the per-agent profile
 * (#255), the per-agent flow (#297/#304), resolved MCP servers + hooks, skills (#636), and the audit
 * /confine/scope/taint/defer/skill/activity hooks. Spread the result straight into the invoke args.
 *
 * @param s       store snapshot taken at the settings-composition point
 * @param paneId  the pane being launched
 */
export function buildSessionSettings(s: AppStore, paneId: string) {
  // Role gate (#219): a planner/worker/triage session has its mutating git/gh commands denied at
  // launch (deny > the broad gh/git allow), plus a write-tool guard (#238). Absent role ⇒ unrestricted.
  const role = s.paneRoles[paneId];
  // The worker's write boundary (its owned globs) makes roleWriteRules auto-approve Edit/Write within
  // its lane; without it a worker (code:write, empty writeGlobs) prompts on every edit.
  const roleGlobs = s.paneRoleGlobs[paneId] ?? [];
  const cap = role ? roleCapability(role, { writeGlobs: roleGlobs }) : null;
  const write = cap ? roleWriteRules(cap) : { allow: [], deny: [] };
  // Agents gate (#255): the profile assigned to this pane is the SOLE source of auto-approved
  // commands (#1457), plus its per-tool/path rules, on top of the role gate (deny wins for both).
  const profileId = s.paneProfiles[paneId];
  const profile = profileId
    ? s.agentProfiles.find((p) => p.id === profileId)
    : undefined;
  const prof = profile ? resolveProfileSettings(profile) : null;
  // Per-agent flow (#297): narrow the GitHub-propagation writes per the stream's push policy + gate.
  const paneFlow = s.paneFlows[paneId];
  const flowRules = flowPermissionRules(paneFlow);
  // The profile's auto-run commands, plus the role's fixed store-CLI surface (#3095): a curator pane
  // always auto-runs `bsc ui`/`bsc graph` (its harvest + graph-optimize channels) whether or not a
  // profile assigned them. Empty for every other role, so this is a no-op elsewhere.
  const allowedCommands = [...(prof?.allowedCommands ?? []), ...restrictedRoleCommands(role)];
  // Shell posture (#1572): the profile's bash tier scales the backend's auto-approve baseline.
  // No profile ⇒ the broad default ("allow").
  const bashPosture = prof?.bashPosture ?? "allow";
  // Denied commands (#304/#1916): user + role (minus the flow-granted pushes) + profile denies — the
  // SAME set wired into `$BSC_DENY_BASH` for the bsc-deny hook (see sessionDeniedCommands).
  const denied = sessionDeniedCommands(s, paneId);
  const allowToolRules = [...write.allow, ...(prof?.allowToolRules ?? [])];
  // Confinement self-protection (#1916): the agent must not disable the FS-confinement hook or its own
  // permission set by editing them. Deny the file-write tools on `.claude/**` — the in-repo config the
  // bsc-confine hook itself can't catch (it only blocks paths OUTSIDE the repo root). The app stays
  // authoritative regardless (it re-writes `.claude/settings.json` at every launch). On EVERY pane.
  const confinementConfigDeny = ["Edit", "Write", "MultiEdit", "NotebookEdit"].map((t) => `${t}(.claude/**)`);
  // Worker sub-agent block (#1036): deny the Task tool for workers. Deny wins over any profile allow.
  const denyToolRules = [...confinementConfigDeny, ...write.deny, ...(cap ? roleDeniedTools(cap) : []), ...(prof?.denyToolRules ?? []), ...flowRules.denyToolRules];
  const askToolRules = flowRules.askToolRules;
  // MCP servers + hooks resolved for this session — pre-resolved per pane at tab creation; fall back
  // to globals for ad-hoc consoles.
  const mcpServers = s.paneMcpServers[paneId]
    ?? resolveMcpServers(s.mcpServers, "");
  const hookDefs = s.paneHooks[paneId]
    ?? resolveHooks(s.hooks, "");
  const { mcp, hooks } = toSessionPayloads(mcpServers, hookDefs);
  // Skills resolved for this session — pre-resolved per pane at tab creation (fleet/triage snapshot).
  // Fall back to the global set for an ad-hoc console, still honoring this pane's override (#1056).
  const skillDefs = s.paneSkills[paneId]
    ?? effectiveSessionSkills(
         s.skills, "", s.sessionSkillOverrides[paneId],
         new Set(expandGroups(s.sessionSkillGroups[paneId] ?? [], s.skillGroups)),
       );
  const skills = toSkillCfgs(skillDefs);
  // Agents audit (#257): on a gated pane (role or profile assigned), install PreToolUse hooks: log
  // each tool attempt (bsc-audit), time MCP calls (bsc-mcp), enforce the write-scope gate (bsc-scope,
  // #1297), the tainted-turn gate (bsc-taint, #1167), and the worker-only Stop bounce (bsc-defer,
  // #369). FS confinement (bsc-confine, #158) is NOT gated — it's defaulted onto every pane below (#1916).
  const gatedHooks = (cap || prof)
    ? [...hooks,
       { event: "PreToolUse", matcher: "", command: "bsc-audit" },
       { event: "PreToolUse", matcher: "mcp__.*", command: "bsc-mcp" },
       { event: "PostToolUse", matcher: "mcp__.*", command: "bsc-mcp" },
       { event: "PreToolUse", matcher: "Edit|Write|MultiEdit|NotebookEdit", command: "bsc-scope" },
       { event: "PreToolUse", matcher: "", command: "bsc-taint" },
       ...(role === "worker" ? [{ event: "Stop", matcher: "", command: "bsc-defer" }] : [])]
    : hooks;
  // Skill telemetry (#406) follows the SKILLS, not the role gate: install the bsc-skill Pre/Post hooks
  // whenever skills are present (incl. an ungated console with a per-session skill, #1056).
  const skillHooks = skills.length > 0
    ? [...gatedHooks,
       { event: "PreToolUse", matcher: "Skill", command: "bsc-skill" },
       { event: "PostToolUse", matcher: "Skill", command: "bsc-skill" }]
    : gatedHooks;
  // Turn-activity hooks (#1184): authoritative turn boundaries for the status dot, on EVERY
  // claude-launching pane. Listed AFTER bsc-defer so a worker's Stop records idle even though
  // bsc-defer blocks the stop.
  const sessionHooks = [
    ...skillHooks,
    // FS confinement (#158/#1916): the DEFAULT, un-gated deny — confine the AI's file tools to this
    // session's repo root ($BSC_REPO_ROOT, set per-pane in pty_create) on EVERY claude-launching pane,
    // role/profile or not. The deny every session starts with; the OS sandbox (WSL2/Seatbelt) extends
    // the same boundary to Bash (the one tool a PreToolUse hook can't fully confine).
    { event: "PreToolUse", matcher: "Edit|Write|MultiEdit|NotebookEdit|Read", command: "bsc-confine" },
    // Dangerous-command floor (#1916): the DEFAULT deny — `bsc-deny` hard-blocks (exit 2) any Bash
    // command hitting the shared dangerous floor (`bsc_util::dangerous`), enforced via the `bsc`
    // binary so it survives `bypassPermissions` (where `permissions.deny` is ignored but PreToolUse
    // hooks still fire+block). The foundation the deny-list switch builds on; reads `$BSC_DENY_BASH`
    // for the per-session role/user denies wired in at the bypass flip.
    { event: "PreToolUse", matcher: "Bash", command: "bsc-deny" },
    { event: "UserPromptSubmit", matcher: "", command: "bsc-activity run" },
    { event: "Stop", matcher: "", command: "bsc-activity idle" },
    { event: "SubagentStop", matcher: "", command: "bsc-activity idle" },
  ];
  return {
    allowedCommands,
    deniedCommands: denied,
    mcpServers: mcp,
    hooks: sessionHooks,
    allowToolRules,
    denyToolRules,
    askToolRules,
    skills,
    bashPosture,
    // Permission posture (#1916): bypass=true ⇒ deny-list (auto-run; the PreToolUse hooks gate); false ⇒
    // allow-list (Claude's `default` mode — require approval). User-toggled in Settings; default true.
    bypass: s.bypassPermissions,
  };
}

/**
 * Resolve the effective `init_cmd` for `pty_create`.
 * - Claude panes: explicit initCmd wins, then the startup-prompt baking path (pty_create handles it —
 *   don't also inject an init_cmd), then ad-hoc auto-resume (`claude --continue`). Manual consoles are
 *   never auto-recovered (#1176) — their crash-resume signals are suppressed.
 * - Non-Claude providers: explicit initCmd wins; otherwise the provider's own launch command.
 *
 * @param s        store snapshot taken at the init-cmd resolution point
 * @param paneId   the pane being launched
 * @param isClaudeProvider  whether the resolved provider is Claude
 * @param initCmd  the pane's explicit init command, if any
 * @param startupPrompt  the composed startup prompt, if any (drives the baking path)
 * @param provider the resolved provider (for its `buildLaunchCmd`)
 */
export function resolveEffectiveInitCmd(
  s: AppStore,
  paneId: string,
  isClaudeProvider: boolean,
  initCmd: string | undefined,
  startupPrompt: string | undefined,
  provider: ConsoleProvider,
): string {
  const manual = isManualPaneId(paneId);
  if (isClaudeProvider) {
    return resolveInitCmd({
      explicit: initCmd,
      startupPrompt,
      paneWasClaude: !!s.paneWasClaude[paneId],
      autoResumeClaude: manual ? false : s.autoResumeClaude,
      // Crash recovery (#1041): resume only after an unclean shutdown (silent, if opted in) or a
      // banner "restore" click — never on a clean restart, and never for a manual console.
      wasUncleanShutdown: s.uncleanShutdown,
      restoreRequested: manual ? false : !!s.restoreRequested[paneId],
    });
  }
  // Non-Claude: an explicit initCmd wins; otherwise the provider builds its own launch command from
  // the per-provider config (Aider maps LLM/model/prompt/worker-scope → flags, #1172; others ignore it).
  if (initCmd && initCmd.length > 0) return initCmd;
  return provider.buildLaunchCmd(providerLaunchConfig(s, paneId, provider, startupPrompt));
}

/**
 * Whether a Claude pane's baked startup prompt must be SUPPRESSED when it resumes a prior
 * conversation on a crash-restore remount (#2052). Keyed off the transient per-pane
 * `restoreRequested` flag set by `restoreSessionsFromCrash` — so it is true ONLY on the
 * crash-recovery relaunch, never on an intentional launch (a fresh triage/fleet kickoff, a
 * manual console, or a tab-switch reconnect all leave it false, so their prompts deliver as
 * usual). The backend's `fresh_only` only bites when the resumed session actually has history
 * (`fresh_only && has_history`), so a prompt still fires on a genuinely fresh launch.
 *
 * Without this, the crash-restore remount re-bakes the pane's persisted startup prompt /
 * checkpoint note as `claude --continue`'s initial message, which Claude then SUBMITS into the
 * already-resumed conversation — re-running (or, if that persisted text was a slash command like
 * `/clear`, WIPING) the restored history. Mirrors the planner's `startupPromptFreshOnly`
 * (`plannerLaunch`).
 */
export function resolveStartupPromptFreshOnly(s: AppStore, paneId: string, isClaudeProvider: boolean): boolean {
  if (!isClaudeProvider || isManualPaneId(paneId)) return false;
  return !!s.restoreRequested[paneId];
}
