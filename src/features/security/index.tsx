// Agents screen (#236, made real in #255; tab bodies split out in #1643) — permission
// profiles, console/pane assignments & an audit feed. Profiles + assignments are
// persisted in the store and ENFORCED at session launch via profileEnforcement →
// ensure_session_settings (the same gate as the role model). Shell allowlists resolve
// additively (guaranteed ∪ profile ∪ project ∪ repo); gh/git are guaranteed; a profile
// layers a base policy + per-tool tri-states + path scope. Data model + helpers live in
// ./lib; the four tab bodies in ./{Profiles,Assignments,Activity,Flow}Tab. This file is
// composition + light view state only.
import { useCallback, useMemo, useState } from "react";
import { usePoll } from "@/shared/hooks/usePoll";
import { bscJson } from "@/shared/lib/core/bsc";
import { type TabItem } from "@/app/chrome/TabBar";
import { Screen } from "@/app/chrome/Screen";
import { usePageTabs } from "@/shared/hooks/usePageTabs";
import { usePromptDialog, useConfirmDialog } from "@/shared/ui/overlay/promptDialog";
import { APP_ROLES, type AgentProfile, type Tier, type ToolKey } from "./lib/agentProfiles";
import { deriveConsoles } from "./lib/consoleModel";
import {
  buildAuditRows, auditDecisionCounts, type AuditDisplayRow, type DecFilter,
} from "./lib/auditRows";
import { useAppStore } from "@/store";
import { ProfilesTab } from "./ProfilesTab";
import { AssignmentsTab } from "./AssignmentsTab";
import { ActivityTab } from "./ActivityTab";
import { FlowTab } from "./FlowTab";
import "./security.css";

// Re-exported for tests + back-compat: the pane-profile picker + app-session label
// helpers used to live here; they moved to ./AssignmentsTab and ./lib/appSession (#1643).
export { ProfileSelect } from "./AssignmentsTab";
export { appSessionTag, appSessionOpenLabel, appReachNote } from "./lib/appSession";

// #1545: public API for cross-feature consumers (planner, app/console).
export { type AgentProfile, type Tier, type ToolKey, PROFILES } from "./lib/agentProfiles";
export { resolveProfileSettings } from "./lib/profileEnforcement";
export { parseAuditLog, type AuditRecord } from "./lib/auditLog";

export function SecurityWorkspace({ pageOverride }: { pageOverride?: string } = {}) {
  const [selectedId, setSelectedId] = useState("sys_planner");
  const [actDecision, setActDecision] = useState<DecFilter>("all");
  const [actConsole, setActConsole] = useState("all");

  // Persisted profiles + assignment (#255); console panes come from the real workspace.
  const profiles = useAppStore((s) => s.agentProfiles);
  const updateAgentProfile = useAppStore((s) => s.updateAgentProfile);
  const setAgentProfiles = useAppStore((s) => s.setAgentProfiles);
  const setPaneProfile = useAppStore((s) => s.setPaneProfile);
  const tabs = useAppStore((s) => s.tabs);
  const paneNames = useAppStore((s) => s.paneNames);
  const disabledPanes = useAppStore((s) => s.disabledPanes);
  const paneProfiles = useAppStore((s) => s.paneProfiles);
  const activeRepoName = useAppStore((s) => s.activeRepoName);

  // Coordination (the Flow tab): the fleet's live work-flow, cross-referenced with the
  // profile each session runs under — the Agents screen's angle on #199.
  const wakePane = useAppStore((s) => s.wakePane);

  // Application roles are app-managed singletons (display-only here).
  const roles = APP_ROLES;

  // Live console/pane model derived from the real workspace tabs (see ./lib/consoleModel).
  const consoles = useMemo(
    () => deriveConsoles({ tabs, paneNames, disabledPanes, paneProfiles, activeRepoName }),
    [tabs, paneNames, disabledPanes, paneProfiles, activeRepoName],
  );

  // Activity audit (#257): load the real per-pane tool log and derive each decision
  // from the pane's resolved gate (profile ∪ role) — the same rules the launch gate
  // applies. Refreshed while the Activity tab is open.
  const paneRoles = useAppStore((s) => s.paneRoles);
  const [auditRows, setAuditRows] = useState<AuditDisplayRow[]>([]);

  const agentDefs: TabItem[] = useMemo(() => [
    { id: "profiles", label: "Profiles", count: roles.length + profiles.length, hint: "· application + custom roles" },
    { id: "assignments", label: "Assignments", count: consoles.length, hint: "· consoles & panes" },
    { id: "activity", label: "Activity", count: auditRows.length },
    { id: "flow", label: "Flow", hint: "· coordination" },
  ], [roles.length, profiles.length, consoles.length, auditRows.length]);
  const { tabs: agentTabs, activeId, select, reorder, tearOff } = usePageTabs("security", agentDefs);
  const tab = pageOverride ?? activeId; // active section

  usePoll(async (isCancelled) => {
    if (tab !== "activity") return;
    const lines = await bscJson<string[]>(null, ["logs", "tail", "audit", "--limit", "300", "--json"], []);
    const rows = buildAuditRows(lines, { consoles, profiles, paneProfiles, paneRoles });
    if (!isCancelled()) setAuditRows(rows);
  }, 3000, [tab, paneProfiles, profiles, paneRoles, consoles]);

  const find = (id: string) => [...roles, ...profiles].find((p) => p.id === id);
  const selected = find(selectedId) ?? profiles[0];

  // Resolve the profile a coordination session (a pane id like `t0p1`) runs under, so the
  // Flow tab can show who is parked and under which permission profile. Falls back to the
  // safe default when a pane has no explicit assignment.
  const profileFor = useCallback(
    (session: string): AgentProfile | undefined => find(paneProfiles[session] ?? "pf_sandbox"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [paneProfiles, profiles],
  );

  // App-styled prompt/confirm dialogs (#1738) — replace the blocking, unstyled, untestable
  // native window.prompt/window.confirm. Each returns the value/decision as a promise; render
  // their `dialog` elements once at the page root below.
  const { prompt, dialog: promptDialog } = usePromptDialog();
  const { confirm, dialog: confirmDialog } = useConfirmDialog();

  // Edits persist to the store. Application-role ids won't match a stored profile, so
  // their controls are effectively read-only (they're system-managed).
  function setMode(m: Tier) { updateAgentProfile(selectedId, { mode: m }); }
  function setTool(t: ToolKey, v: Tier) {
    const p = find(selectedId);
    if (p) updateAgentProfile(selectedId, { tools: { ...p.tools, [t]: v } });
  }
  function removeCmd(c: string) {
    const p = find(selectedId);
    if (p) updateAgentProfile(selectedId, { commands: p.commands.filter((x) => x !== c) });
  }
  async function addCmd() {
    const v = await prompt({ title: "Allow a command", label: "Command to allow (e.g. cargo)", placeholder: "cargo", confirmLabel: "Allow" });
    const k = v?.trim().toLowerCase();
    const p = find(selectedId);
    if (k && p && !p.commands.includes(k)) updateAgentProfile(selectedId, { commands: [...p.commands, k] });
  }
  // Filesystem write-scope (#1795): add/edit/remove allow & deny globs. Mirrors addCmd/removeCmd
  // — updateAgentProfile no-ops for application-role ids (not in agentProfiles), so app roles
  // stay read-only even though find() resolves them.
  async function addPath(kind: "allow" | "deny") {
    const v = await prompt({
      title: kind === "allow" ? "Allow a write path" : "Block a path",
      label: kind === "allow" ? "Glob the agent may write to (e.g. src/**)" : "Glob the agent is blocked from (e.g. .env)",
      placeholder: kind === "allow" ? "src/**" : ".env",
      confirmLabel: kind === "allow" ? "Allow" : "Block",
    });
    const g = v?.trim();
    const p = find(selectedId);
    if (g && p && !p.paths[kind].includes(g)) updateAgentProfile(selectedId, { paths: { ...p.paths, [kind]: [...p.paths[kind], g] } });
  }
  function editPath(kind: "allow" | "deny", index: number, value: string) {
    const p = find(selectedId);
    if (!p) return;
    updateAgentProfile(selectedId, { paths: { ...p.paths, [kind]: p.paths[kind].map((g, i) => (i === index ? value : g)) } });
  }
  function removePath(kind: "allow" | "deny", index: number) {
    const p = find(selectedId);
    if (!p) return;
    updateAgentProfile(selectedId, { paths: { ...p.paths, [kind]: p.paths[kind].filter((_, i) => i !== index) } });
  }
  // Network allowlist (#1795): add/remove reachable hosts.
  async function addHost() {
    const v = await prompt({ title: "Allow a host", label: "Hostname the agent may reach (e.g. api.github.com, or * for all)", placeholder: "api.github.com", confirmLabel: "Allow" });
    const h = v?.trim();
    const p = find(selectedId);
    if (h && p && !p.net.allow.includes(h)) updateAgentProfile(selectedId, { net: { allow: [...p.net.allow, h] } });
  }
  function removeHost(host: string) {
    const p = find(selectedId);
    if (p) updateAgentProfile(selectedId, { net: { allow: p.net.allow.filter((h) => h !== host) } });
  }
  function toggleAssign(_consoleId: string, paneId: string) {
    setPaneProfile(paneId, paneProfiles[paneId] === selectedId ? null : selectedId);
  }
  function openProfile(id: string) { select("profiles"); setSelectedId(id); }

  // Create a new user profile (#259): sensible defaults, persisted, then selected.
  async function createProfile() {
    const name = (await prompt({ title: "New role", label: "Role name", placeholder: "e.g. Reviewer", confirmLabel: "Create" }))?.trim();
    if (!name) return;
    const taken = new Set(profiles.map((p) => p.id));
    const base = "pf_" + (name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "role");
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    const colors = ["oklch(0.7 0.12 290)", "oklch(0.72 0.12 175)", "oklch(0.78 0.14 70)", "oklch(0.68 0.18 25)", "oklch(0.72 0.10 230)"];
    const next: AgentProfile = {
      id, name, color: colors[profiles.length % colors.length],
      category: "user", origin: "user-defined",
      desc: "Custom role.", mode: "ask", commands: [],
      tools: { read: "allow", grep: "allow", glob: "allow", edit: "ask", write: "ask", bash: "ask", web: "ask", task: "ask" },
      paths: { allow: [], deny: [] }, net: { allow: [] }, builtin: false,
    };
    setAgentProfiles([...profiles, next]);
    select("profiles");
    setSelectedId(id);
  }

  // Delete a custom profile (#259): drop it + any pane assignments pointing at it.
  async function deleteProfile(id: string) {
    const p = find(id);
    if (!p || p.category === "application" || p.builtin) return;
    if (!(await confirm({ title: "Delete role", message: `Delete the "${p.name}" role?`, danger: true, confirmLabel: "Delete" }))) return;
    setAgentProfiles(profiles.filter((x) => x.id !== id));
    for (const [paneId, pid] of Object.entries(paneProfiles)) {
      if (pid === id) setPaneProfile(paneId, null);
    }
    setSelectedId("sys_planner");
  }

  const editable = selected?.category !== "application";

  const paneTotal = consoles.reduce((a, c) => a + c.panes.length, 0);
  const { allow, ask, block } = auditDecisionCounts(auditRows);

  return (
    <Screen
      tabs={agentTabs}
      active={tab}
      onSelect={select}
      onReorder={reorder}
      onTearOff={tearOff}
      pageOverride={pageOverride}
      className="security-page"
      bodyClassName="body"
      overlay={<>{promptDialog}{confirmDialog}</>}
    >
      {tab === "profiles" && (
        <ProfilesTab
          roles={roles} profiles={profiles} consoles={consoles} selected={selected}
          onSelect={setSelectedId} setMode={setMode} setTool={setTool}
          removeCmd={removeCmd} addCmd={addCmd} toggleAssign={toggleAssign} find={find}
          addPath={addPath} editPath={editPath} removePath={removePath}
          addHost={addHost} removeHost={removeHost}
          editable={editable} onCreate={createProfile} onDelete={deleteProfile}
        />
      )}
      {tab === "assignments" && (
        <AssignmentsTab
          roles={roles} consoles={consoles} paneTotal={paneTotal}
          profiles={profiles} onAssign={(_c, paneId, profileId) => setPaneProfile(paneId, profileId)}
          onOpen={openProfile} find={find}
        />
      )}
      {tab === "activity" && (
        <ActivityTab
          rows={auditRows} consoles={consoles}
          actDecision={actDecision} setActDecision={setActDecision}
          actConsole={actConsole} setActConsole={setActConsole}
          allow={allow} ask={ask} block={block} find={find}
        />
      )}
      {tab === "flow" && (
        <FlowTab wakePane={wakePane} profileFor={profileFor} />
      )}
    </Screen>
  );
}
