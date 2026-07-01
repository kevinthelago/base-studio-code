// The MCP screen's install/version machinery (#885) lifted out of the screen: the per-server
// status map keyed by NAME, the version check on page open (mcp_check_update for each installed
// downloadable server), and the download (catalog) / update (installed) flows that drive it. Only
// downloadable first-party servers have this; built-in/remote servers carry no status.

import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { catalogLink, repoNameFromLink, mcpRepoName } from "./lib/mcpInstall";
import { type McpStat, type McpCheckResult, deriveCheckStat, installedDownloadableNames } from "./lib/mcpVersioning";
import type { McpServer } from "./lib/mcpServers";
import type { CatalogItem } from "@/shared/data/mcpCatalog";

export interface UseMcpInstallStatus {
  /** Per-server install/version status (#885), keyed by server NAME. */
  mcpStatus: Record<string, McpStat>;
  /** One-click install (#885): clone → `onCloned` (add to Installed silently) → build. */
  downloadFromCatalog(item: CatalogItem, onCloned: (item: CatalogItem) => void): Promise<void>;
  /** Update (or finish building) an installed downloadable server (#885): pull then rebuild. */
  updateInstalled(server: McpServer): Promise<void>;
}

export function useMcpInstallStatus(mcpServers: McpServer[]): UseMcpInstallStatus {
  // Keyed by server NAME. Refreshed on page open via mcp_check_update; advanced by the download
  // (catalog) and update (installed) actions.
  const [mcpStatus, setMcpStatus] = useState<Record<string, McpStat>>({});
  const setStat = (name: string, s: McpStat) => setMcpStatus(m => ({ ...m, [name]: s }));

  // Version check on every page open (#885): for each installed downloadable server, ask the
  // backend whether its clone is behind its remote (and whether it's built). Best-effort + async;
  // an in-flight download/update is left alone.
  useEffect(() => {
    const servers = installedDownloadableNames(mcpServers);
    if (servers.length === 0) return;
    let cancelled = false;
    for (const name of servers) {
      setMcpStatus(m => (m[name] ? m : { ...m, [name]: "checking" }));
      invoke<McpCheckResult>("mcp_check_update", { name: mcpRepoName(name) })
        .then(r => {
          if (cancelled) return;
          const next = deriveCheckStat(r);
          setMcpStatus(m => (m[name] === "downloading" || m[name] === "building" || m[name] === "updating" ? m : { ...m, [name]: next }));
        })
        .catch(() => {});
    }
    return () => { cancelled = true; };
    // Re-check when the set of installed downloadable servers changes (and on mount).
  }, [installedDownloadableNames(mcpServers).join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  /** One-click install (#885): clone → add to Installed silently (`onCloned`) → build. */
  async function downloadFromCatalog(item: CatalogItem, onCloned: (item: CatalogItem) => void) {
    if (!item.link) return;
    const repo = repoNameFromLink(item.link);
    setStat(item.name, "downloading");
    try {
      await invoke<string>("mcp_clone", { name: repo, url: item.link });
    } catch {
      setStat(item.name, "error");
      return;
    }
    onCloned(item);
    setStat(item.name, "building");
    try {
      const r = await invoke<{ ok: boolean }>("mcp_build", { name: repo });
      setStat(item.name, r.ok ? "current" : "needs-build");
    } catch {
      setStat(item.name, "needs-build");
    }
  }

  /** Update (or finish building) an installed downloadable server (#885): pull then rebuild. */
  async function updateInstalled(e: McpServer) {
    const link = catalogLink(e.name);
    if (!link) return;
    const repo = repoNameFromLink(link);
    setStat(e.name, "updating");
    try {
      await invoke("mcp_clone", { name: repo, url: link });
      setStat(e.name, "building");
      const r = await invoke<{ ok: boolean }>("mcp_build", { name: repo });
      setStat(e.name, r.ok ? "current" : "needs-build");
    } catch {
      setStat(e.name, "error");
    }
  }

  return { mcpStatus, downloadFromCatalog, updateInstalled };
}
