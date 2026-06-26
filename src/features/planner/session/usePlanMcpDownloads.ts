// usePlanMcpDownloads (#1474) — the planner's MCP download-confirmation queue, extracted verbatim
// from Planning.tsx. A blueprint / planner-assigned first-party MCP server can install from source;
// rather than cloning that third-party code silently, each not-yet-installed server is queued here
// and surfaced in a modal for the user to confirm. `enqueueMcpDownloads` is a stable callback safe
// to call from the blueprint effect AND the plan.db poll without staleness; `confirm` clones+builds
// the queue; `cancel` dismisses it (keeping the seen-set so skipped servers don't re-prompt).

import { useCallback, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { catalogLink, repoNameFromLink } from "@/features/mcp/lib/mcpInstall";
import { type McpDownloadItem } from "../pane/McpDownloadModal";
import { MCP_CATALOG } from "@/shared/data/mcpCatalog";

export interface PlanMcpDownloads {
  /** Queue downloadable catalog servers (by name) for the confirmation modal, skipping any already
   *  installed or already queued. */
  enqueueMcpDownloads: (names: string[]) => Promise<void>;
  /** The pending download queue (rendered by McpDownloadModal). */
  mcpDownloads: McpDownloadItem[];
  /** Download (clone + build) every still-pending/failed queued server, advancing its row status. */
  confirmMcpDownloads: () => Promise<void>;
  /** Dismiss the modal: drop the queue but keep the seen-set so skipped servers don't re-prompt. */
  cancelMcpDownloads: () => void;
}

export function usePlanMcpDownloads(): PlanMcpDownloads {
  // Download-confirmation queue (#1055): the blueprint a project uses and the servers the planner
  // assigns can pull in first-party MCP servers that install from source. Instead of cloning that
  // third-party code silently, we queue each not-yet-installed server here and surface a modal with
  // its repo link; the user confirms before anything downloads. `mcpDownloadSeen` guards against
  // re-queuing the same server (so a re-applied blueprint / poll tick doesn't nag).
  const [mcpDownloads, setMcpDownloads] = useState<McpDownloadItem[]>([]);
  const mcpDownloadSeen = useRef<Set<string>>(new Set());

  // Queue downloadable catalog servers (by name) for the confirmation modal, skipping any already
  // installed or already queued. State-free (refs + functional setState) so it's a stable callback
  // safe to invoke from the blueprint effect AND the plan.db poll without staleness.
  const enqueueMcpDownloads = useCallback(async (names: string[]) => {
    const fresh: McpDownloadItem[] = [];
    for (const name of names) {
      const link = catalogLink(name);
      if (!link) continue; // not a downloadable first-party server
      const key = name.toLowerCase();
      if (mcpDownloadSeen.current.has(key)) continue;
      const repo = repoNameFromLink(link);
      try {
        const r = await invoke<{ downloaded: boolean; built: boolean }>("mcp_status", { name: repo });
        if (r.downloaded && r.built) { mcpDownloadSeen.current.add(key); continue; } // already installed
      } catch { /* not installed → prompt */ }
      mcpDownloadSeen.current.add(key);
      const cat = MCP_CATALOG.find((c) => c.name.toLowerCase() === key);
      fresh.push({ name, repo, link, desc: cat?.desc, install: cat?.install, status: "pending" });
    }
    if (fresh.length) setMcpDownloads((prev) => [...prev, ...fresh]);
  }, []);

  // Download (clone + build) every still-pending/failed queued server, advancing its row status.
  const confirmMcpDownloads = useCallback(async () => {
    const setStatus = (name: string, status: McpDownloadItem["status"]) =>
      setMcpDownloads((p) => p.map((d) => (d.name === name ? { ...d, status } : d)));
    const targets = mcpDownloads.filter((d) => d.status === "pending" || d.status === "error");
    await Promise.all(targets.map(async (it) => {
      setStatus(it.name, "downloading");
      try { await invoke("mcp_clone", { name: it.repo, url: it.link }); }
      catch { setStatus(it.name, "error"); return; }
      setStatus(it.name, "building");
      try {
        const r = await invoke<{ ok: boolean }>("mcp_build", { name: it.repo });
        setStatus(it.name, r.ok ? "ready" : "error");
      } catch { setStatus(it.name, "error"); }
    }));
  }, [mcpDownloads]);

  // Dismiss the modal: drop the queue but keep the seen-set so skipped servers don't immediately
  // re-prompt (the user can still install them later from the MCP screen).
  const cancelMcpDownloads = useCallback(() => setMcpDownloads([]), []);

  return { enqueueMcpDownloads, mcpDownloads, confirmMcpDownloads, cancelMcpDownloads };
}
