// usePlanMcpManagement (#1474) — the planner's MCP install lifecycle, extracted verbatim from
// Planning.tsx (the download-confirmation queue is its own hook, usePlanMcpDownloads). Owns the
// disk-probe, the blueprint-attached-MCP scoping, the project + planner-session MCP context writes,
// and the toggle/add/build/remove handlers.
//
// `mcpInstallState` STAYS in Planning (it feeds the paneData memo); this hook only WRITES it via the
// passed `setMcpInstallState` (always functional updates), which breaks the paneData→probe render
// cycle with no behavior change. Call it immediately after paneData so `mcpServersUi` is available.

import { useCallback, useEffect, useMemo, type Dispatch, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { fireInvoke } from "@/shared/lib/core/safeInvoke";
import { useAppStore } from "@/store";
import { applyBlueprintMcp, collectBlueprintMcp } from "../blueprints/blueprintMcp";
import { writeProjectMcpContext } from "../lib/mcpContext";
import { catalogLink, repoNameFromLink, mcpRepoName } from "@/features/mcp";
import { applyMcpAssign } from "../lib/planExtensions";
import { MCP_CATALOG } from "@/shared/data/mcpCatalog";
import { roleCapability, roleWriteRules, roleDeniedCommands } from "@/shared/lib/session/sessionRoles";
import { resolveAllInstalledMcp, toSessionPayloads, mcpAllowRules } from "@/features/mcp";
import { type McpInstallState } from "../lib/mcpPaneData";
import { type Blueprint } from "../stages/blueprints";

type StoreMcpServers = Parameters<typeof resolveAllInstalledMcp>[0];
/** The probe only reads id/name/downloadable off paneData.mcpServers. */
interface ProbeServer { id: string; name: string; downloadable?: boolean }

interface McpManagementDeps {
  effectiveProjectId: string;
  effectiveBlueprintId: string;
  blueprints: Blueprint[];
  planningDir: string;
  /** paneData.mcpServers — the UI server list the probe filters for downloadable servers. */
  mcpServersUi: ProbeServer[] | undefined;
  /** The store's mcpServers value — drives the installed-server context writes. */
  mcpServers: StoreMcpServers;
  /** Writes install status (functional updates only — the value lives in Planning, feeding paneData). */
  setMcpInstallState: Dispatch<SetStateAction<McpInstallState>>;
  /** Queue first-party MCP servers for the download-confirmation modal (from usePlanMcpDownloads). */
  enqueueMcpDownloads: (names: string[]) => Promise<void>;
}

export interface PlanMcpManagement {
  onToggleMcp: (id: string) => void;
  onRemoveMcp: (id: string) => void;
  onAddMcp: (input: string) => void;
  onBuildMcp: (s: { id: string; name: string; status: string }) => Promise<void>;
}

export function usePlanMcpManagement(deps: McpManagementDeps): PlanMcpManagement {
  const { effectiveProjectId, effectiveBlueprintId, blueprints, planningDir, mcpServersUi, mcpServers, setMcpInstallState, enqueueMcpDownloads } = deps;

  // Probe each downloadable MCP server's on-disk state so the pane opens with real status
  // (downloaded? built?) instead of "available" for already-installed servers.
  useEffect(() => {
    const probe = mcpServersUi?.filter(s => s.downloadable) ?? [];
    if (probe.length === 0) return;
    let cancelled = false;
    Promise.all(probe.map(async (s) => {
      try {
        const r = await invoke<{ downloaded: boolean; built: boolean }>("mcp_status", { name: mcpRepoName(s.name) });
        return [s.id, r.built ? "ready" : r.downloaded ? "downloaded" : "available"] as const;
      } catch { return [s.id, "available"] as const; }
    })).then((rows) => {
      if (cancelled) return;
      setMcpInstallState((prev) => {
        const next = { ...prev };
        // Don't clobber an in-flight downloading/building status with a probe result.
        for (const [id, st] of rows) if (next[id] !== "downloading" && next[id] !== "building") next[id] = st;
        return next;
      });
    });
    return () => { cancelled = true; };
    // Re-probe only when the set of downloadable server ids changes.
  }, [mcpServersUi?.filter(s => s.downloadable).map(s => s.id).join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  // Scope the active blueprint's attached MCP servers to this project (#897 Phase 2), so the
  // planner + fleet get the tools the blueprint declares. Idempotent (applyMcpAssign enables +
  // scopes existing, or adds). The downloadable (first-party) ones are queued for the
  // download-confirmation modal (#1055) rather than cloned silently. Re-runs when the project or
  // the blueprint's attached-MCP set changes.
  const bpMcpKey = useMemo(() => {
    const bp = blueprints.find(b => b.id === effectiveBlueprintId);
    return bp ? collectBlueprintMcp(bp).join("\n") : "";
  }, [blueprints, effectiveBlueprintId]);
  useEffect(() => {
    if (!effectiveProjectId || !bpMcpKey) return;
    const store = useAppStore.getState();
    const bp = store.blueprints.find(b => b.id === effectiveBlueprintId);
    if (!bp) return;
    void enqueueMcpDownloads(applyBlueprintMcp(store, bp, effectiveProjectId, store.bscBaseDir));
  }, [bpMcpKey, effectiveProjectId, effectiveBlueprintId, enqueueMcpDownloads]);

  // Write the planner's live extensions.md — the installed MCP servers it can call + the per-worker
  // assignment directive (#1054). Supersedes the static catalogue setup_workspaces used to write;
  // re-runs whenever the installed-server set or the project changes.
  const installedMcpKey = useMemo(
    () => resolveAllInstalledMcp(mcpServers).map((e) => `${e.id}:${e.name}`).join("\n"),
    [mcpServers],
  );
  useEffect(() => {
    if (!effectiveProjectId) return;
    void writeProjectMcpContext({ projectKey: effectiveProjectId, servers: resolveAllInstalledMcp(useAppStore.getState().mcpServers) })
      .catch((e) => console.warn("writeProjectMcpContext failed:", e));
  }, [installedMcpKey, effectiveProjectId]);

  // Keep the planner session's .mcp.json current as servers are downloaded (#1054). Claude loads MCP
  // config at startup, so a newly downloaded server is picked up on the planner's next launch /
  // resume; this keeps the file ready. No-op until the planner dir is known.
  useEffect(() => {
    if (!planningDir) return;
    const cap = roleCapability("planner");
    const write = roleWriteRules(cap);
    const mcp = toSessionPayloads(resolveAllInstalledMcp(useAppStore.getState().mcpServers), []).mcp;
    fireInvoke("ensure_session_settings", {
      cwd:             planningDir,
      allowedCommands: [],
      deniedCommands:  roleDeniedCommands(cap),
      mcpServers:      mcp,
      hooks:           null,
      // Auto-approve every MCP server the planner is given (Research included) so calling them
      // while planning never hits a per-tool prompt — replacePermissions:true here would otherwise
      // drop the launch-time rules, so this refresh must re-assert them too.
      allowToolRules:  [...write.allow, "Read", "WebFetch", ...mcpAllowRules(mcp)],
      denyToolRules:   write.deny,
      replacePermissions: true,
    }, (e: unknown) => console.warn("planner mcp refresh failed:", e));
  }, [installedMcpKey, planningDir]);

  // ── MCP stage handlers (#878) ──────────────────────────────────────────────
  const onToggleMcp = useCallback((id: string) => useAppStore.getState().toggleMcpServer(id), []);
  const onRemoveMcp = useCallback((id: string) => useAppStore.getState().removeMcpServer(id), []);
  const onAddMcp = useCallback((input: string) => {
    const store = useAppStore.getState();
    // A bare catalog name maps to its template; anything with a scheme is a remote URL; else a
    // stdio command line. New servers are enabled + scoped to this project so the fleet gets them.
    const link = catalogLink(input);
    if (link || MCP_CATALOG.some(c => c.name.toLowerCase() === input.toLowerCase())) {
      const name = MCP_CATALOG.find(c => c.name.toLowerCase() === input.toLowerCase())?.name ?? input;
      applyMcpAssign(store, name, effectiveProjectId, store.bscBaseDir);
      if (link) fireInvoke("mcp_clone", { name: repoNameFromLink(link), url: link });
      return;
    }
    const isUrl = /^https?:\/\//i.test(input);
    store.addMcpServer({
      name: input.split(/\s+/)[0].slice(0, 40) || "server", enabled: true, projects: [effectiveProjectId],
      transport: isUrl ? "http" : "stdio",
      ...(isUrl ? { url: input } : { command: input.split(/\s+/)[0], args: input.split(/\s+/).slice(1).join(" ") }),
      env: [],
    });
  }, [effectiveProjectId]);
  const onBuildMcp = useCallback(async (s: { id: string; name: string; status: string }) => {
    const repo = mcpRepoName(s.name);
    const link = catalogLink(s.name);
    // Ensure it's downloaded, then build, tracking status so the pane reflects progress.
    if (link && (s.status === "available")) {
      setMcpInstallState(p => ({ ...p, [s.id]: "downloading" }));
      try { await invoke("mcp_clone", { name: repo, url: link }); }
      catch { setMcpInstallState(p => ({ ...p, [s.id]: "available" })); return; }
    }
    setMcpInstallState(p => ({ ...p, [s.id]: "building" }));
    try {
      const r = await invoke<{ ok: boolean }>("mcp_build", { name: repo });
      setMcpInstallState(p => ({ ...p, [s.id]: r.ok ? "ready" : "error" }));
    } catch {
      setMcpInstallState(p => ({ ...p, [s.id]: "error" }));
    }
  }, [setMcpInstallState]);

  return { onToggleMcp, onRemoveMcp, onAddMcp, onBuildMcp };
}
