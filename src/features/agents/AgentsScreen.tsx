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
import { safeInvoke } from "@/shared/lib/core/safeInvoke";
import { TabBar, type TabItem } from "@/app/chrome/TabBar";
import { usePageTabs } from "@/shared/hooks/usePageTabs";
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
import "./agents.css";

// Re-exported for tests + back-compat: the pane-profile picker + app-session label
// helpers used to live here; they moved to ./AssignmentsTab and ./lib/appSession (#1643).
export { ProfileSelect } from "./AssignmentsTab";
export { appSessionTag, appSessionOpenLabel, appReachNote } from "./lib/appSession";

export function AgentsScreen({ sectionOverride }: { sectionOverride?: string } = {}) {
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

  // Coordination & workflows (the Flow tab): the fleet's live work-flow, cross-referenced
  // with the profile each session runs under — the Agents screen's angle on #199/#220.
  const wakePane = useAppStore((s) => s.wakePane);
  const workflowRuns = useAppStore((s) => s.workflowRuns);

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
    { id: "flow", label: "Flow", count: Object.keys(workflowRuns).length, hint: "· coordination & workflows" },
  ], [roles.length, profiles.length, consoles.length, auditRows.length, workflowRuns]);
  const { tabs: agentTabs, activeId, select, reorder, tearOff } = usePageTabs("agents", agentDefs);
  const tab = sectionOverride ?? activeId; // active section

  usePoll(async (isCancelled) => {
    if (tab !== "activity") return;
    const lines = await safeInvoke<string[]>("read_audit_log", { limit: 300 }, []);
    const rows = buildAuditRows(lines, { consoles, profiles, paneProfiles, paneRoles });
    if (!isCancelled()) setAuditRows(rows);
  }, 3000, [tab, paneProfiles, profiles, paneRoles, consoles]);

  const find = (id: string) => [...roles, ...profiles].find((p) => p.id === id);
  const selected = find(selectedId) ?? profiles[0];

  // Resolve the profile a coord/workflow session (a pane id like `t0p1`) runs under, so the
  // Flow tab can show who is parked/flowing and under which permission profile. Falls back
  // to the safe default when a pane has no explicit assignment.
  const profileFor = useCallback(
    (session: string): AgentProfile | undefined => find(paneProfiles[session] ?? "pf_sandbox"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [paneProfiles, profiles],
  );

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
  function addCmd() {
    const v = window.prompt("Allow which command? (e.g. cargo)");
    const k = v?.trim().toLowerCase();
    const p = find(selectedId);
    if (k && p && !p.commands.includes(k)) updateAgentProfile(selectedId, { commands: [...p.commands, k] });
  }
  function toggleAssign(_consoleId: string, paneId: string) {
    setPaneProfile(paneId, paneProfiles[paneId] === selectedId ? null : selectedId);
  }
  function openProfile(id: string) { select("profiles"); setSelectedId(id); }

  // Create a new user profile (#259): sensible defaults, persisted, then selected.
  function createProfile() {
    const name = window.prompt("New role name?")?.trim();
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
  function deleteProfile(id: string) {
    const p = find(id);
    if (!p || p.category === "application" || p.builtin) return;
    if (!window.confirm(`Delete the "${p.name}" role?`)) return;
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
    <div className="agents-page">
      {!sectionOverride && (
        <TabBar
          tabs={agentTabs}
          activeId={activeId}
          onSelect={select}
          onReorder={reorder}
          onTearOff={tearOff}
          right={
            <>
              {tab === "profiles" && <>
                <span className="hint" style={{ fontFamily: "var(--mono)" }}>{roles.length} application · {profiles.length} custom roles</span>
                <button className="btn primary" onClick={createProfile}>+ New role</button>
              </>}
              {tab === "assignments" && <>
                <span className="hint" style={{ fontFamily: "var(--mono)" }}>resolved · guaranteed ∪ profile ∪ project ∪ repo</span>
                <button className="btn">apply to all panes…</button>
              </>}
              {tab === "activity" && <>
                <span className="hint" style={{ fontFamily: "var(--mono)" }}>live · last 1h</span>
                <button className="btn">pause feed</button>
              </>}
              {tab === "flow" && (
                <span className="hint" style={{ fontFamily: "var(--mono)" }}>live · #199 latches + #220 stages</span>
              )}
            </>
          }
        />
      )}

      <div className="body">
        {tab === "profiles" && (
          <ProfilesTab
            roles={roles} profiles={profiles} consoles={consoles} selected={selected}
            onSelect={setSelectedId} setMode={setMode} setTool={setTool}
            removeCmd={removeCmd} addCmd={addCmd} toggleAssign={toggleAssign} find={find}
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
          <FlowTab runs={workflowRuns} wakePane={wakePane} profileFor={profileFor} />
        )}
      </div>
    </div>
  );
}
