import { useState, useEffect, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ConfirmButton } from "@/shared/ui/controls/ConfirmButton";
import { fmtBytes } from "@/shared/lib/core/format";
import { Button } from "@/shared/ui/controls/Button";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";

// One fleet worktree's disk footprint (mirrors Rust `WorktreeUsage`, #1080).
interface WorktreeUsage {
  projectKey: string;
  name: string;
  path: string;
  sizeBytes: number;
  targetBytes: number;
}

// The WSL2 agent sandbox's disk footprint (mirrors Rust `SandboxDisk`, #1988) — separate from worktrees.
interface SandboxDisk {
  installed: boolean;
  distroBytes: number;
  tarballBytes: number;
}

// The disk scan is heavy (a recursive walk of every worktree's target/). Cache the last result so the
// card shows instantly on mount, and only re-scan in the BACKGROUND when the cache is missing or stale
// — a normal Planner visit within a few minutes pays nothing. "Refresh" + a reclaim always re-scan.
const STORAGE_CACHE_KEY = "bsc:storageDisk";
const STALE_MS = 5 * 60_000;
interface StorageCache { rows: WorktreeUsage[]; sandbox: SandboxDisk | null; takenAt: number }

function loadStorageCache(): StorageCache | null {
  try {
    const raw = localStorage.getItem(STORAGE_CACHE_KEY);
    return raw ? (JSON.parse(raw) as StorageCache) : null;
  } catch { return null; }
}
function saveStorageCache(c: StorageCache): void {
  try { localStorage.setItem(STORAGE_CACHE_KEY, JSON.stringify(c)); } catch { /* quota / disabled */ }
}

export function StorageCard() {
  const initialCache = useMemo(() => loadStorageCache(), []);
  const [rows, setRows] = useState<WorktreeUsage[]>(initialCache?.rows ?? []);
  const [sandbox, setSandbox] = useState<SandboxDisk | null>(initialCache?.sandbox ?? null);
  const [takenAt, setTakenAt] = useState<number | null>(initialCache?.takenAt ?? null);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [notice, setNotice] = useState("");

  const flash = (msg: string) => { setNotice(msg); setTimeout(() => setNotice(""), 6000); };

  // A full re-scan. The commands now run off the main thread (#1916), so this never blocks the UI; it
  // updates the rows + the cache when it lands.
  const refresh = useCallback(async () => {
    setScanning(true);
    let nextRows: WorktreeUsage[] = [];
    let nextSandbox: SandboxDisk | null = null;
    try { nextRows = await invoke<WorktreeUsage[]>("worktrees_disk_usage"); } catch { /* keep empty */ }
    // The WSL2 agent sandbox lives outside the worktrees tree, so it needs its own scan (#1988).
    try { nextSandbox = await invoke<SandboxDisk>("sandbox_disk_usage"); } catch { /* keep null */ }
    const now = Date.now();
    setRows(nextRows);
    setSandbox(nextSandbox);
    setTakenAt(now);
    saveStorageCache({ rows: nextRows, sandbox: nextSandbox, takenAt: now });
    setScanning(false);
  }, []);

  // Cached numbers render instantly (state init); only re-scan when there's no cache or it's stale.
  useEffect(() => {
    if (!initialCache || Date.now() - initialCache.takenAt > STALE_MS) void refresh();
  }, [initialCache, refresh]);

  // Reclaim every worktree of one project (drops the dir + git admin records + build artifacts).
  const reclaim = useCallback(async (projectKey: string) => {
    setBusy(true);
    try {
      const n = await invoke<number>("reclaim_worktrees", { projectKey });
      flash(`Reclaimed ${n} worktree${n === 1 ? "" : "s"}.`);
      await refresh();
    } catch (e) { flash(String(e)); }
    setBusy(false);
  }, [refresh]);

  // Remove the WSL2 agent sandbox: unregister the distro + delete its image and cached tarball (#1988).
  const removeSandbox = useCallback(async () => {
    setBusy(true);
    try {
      const freed = await invoke<number>("remove_sandbox");
      flash(`Removed the agent sandbox — freed ${fmtBytes(freed)}.`);
      await refresh();
    } catch (e) { flash(String(e)); }
    setBusy(false);
  }, [refresh]);

  // Group by project so the user reclaims a whole project's fleet at once.
  const byProject = new Map<string, WorktreeUsage[]>();
  for (const r of rows) {
    const list = byProject.get(r.projectKey) ?? [];
    list.push(r);
    byProject.set(r.projectKey, list);
  }
  const projects = [...byProject.entries()]
    .map(([key, list]) => ({
      key,
      list,
      total: list.reduce((s, r) => s + r.sizeBytes, 0),
      targetTotal: list.reduce((s, r) => s + r.targetBytes, 0),
    }))
    .sort((a, b) => b.total - a.total);
  const grandTotal = rows.reduce((s, r) => s + r.sizeBytes, 0);

  return (
    <Stack gap={0} style={{ maxWidth: 760 }}>
      <Box style={{ marginBottom: 20 }}>
        <Text as="div" size={16} style={{ fontFamily: "var(--sans)", color: "var(--fg)", marginBottom: 6 }}>Storage</Text>
        <Text as="div" size={11.5} tone="muted" style={{ fontFamily: "var(--sans)", lineHeight: 1.5 }}>
          Each fleet agent builds in its own git worktree, and every worktree accumulates its own{" "}
          <code className="mono">target/</code> (build artifacts) — which Cargo never garbage-collects.
          Worktrees are removed automatically when a project is deleted; reclaim them here at any time to free disk space.
          Reclaiming removes a worktree's checkout and its build artifacts (the agent's committed work is on its branch and is preserved).
        </Text>
      </Box>

      <Row gap={10} style={{ marginBottom: 12 }}>
        <Text mono size={11} style={{ color: "var(--fg)" }}>
          {rows.length} worktree{rows.length === 1 ? "" : "s"} · {fmtBytes(grandTotal)} total
        </Text>
        <Box as="span" style={{ flex: 1 }} />
        {scanning ? (
          <Text mono size={10} tone="dim">scanning…</Text>
        ) : takenAt ? (
          <Text mono size={10} tone="dim">checked {new Date(takenAt).toLocaleTimeString()}</Text>
        ) : null}
        <Button size="sm" disabled={busy || scanning} onClick={() => void refresh()}>Refresh</Button>
      </Row>

      {projects.length === 0 ? (
        <Box className="mono" pad={[20, 16]} bg="var(--bg-panel)" border="soft" radius={8} style={{ fontSize: 11.5, color: "var(--fg-dim)" }}>
          {scanning ? "Scanning…" : "No fleet worktrees on disk."}
        </Box>
      ) : (
        projects.map((p) => (
          <Box key={p.key} pad={[4, 16]} bg="var(--bg-panel)" border="soft" radius={8} style={{ marginBottom: 12 }}>
            <Row gap={12} style={{ padding: "10px 0", borderBottom: "1px solid var(--border-soft)" }}>
              <Box style={{ flex: 1, minWidth: 0 }}>
                <Text as="div" size={13} style={{ fontFamily: "var(--sans)", color: "var(--fg)" }}>{p.key}</Text>
                <Text as="div" mono size={10.5} tone="dim" style={{ marginTop: 2 }}>
                  {p.list.length} worktree{p.list.length === 1 ? "" : "s"} · {fmtBytes(p.total)} ({fmtBytes(p.targetTotal)} in target/)
                </Text>
              </Box>
              <ConfirmButton size="sm" label="Reclaim" armedLabel="Confirm" disabled={busy} onConfirm={() => reclaim(p.key)} />
            </Row>
            {p.list.map((w) => (
              <Row key={w.path} gap={12} style={{ padding: "8px 0 8px 12px", borderBottom: "1px solid var(--border-soft)" }}>
                <Box style={{ flex: 1, minWidth: 0 }}>
                  <Text as="div" mono size={11.5} tone="muted">{w.name}</Text>
                </Box>
                <Text as="div" mono size={10.5} tone="dim" style={{ whiteSpace: "nowrap" }}>
                  {fmtBytes(w.sizeBytes)}{w.targetBytes > 0 ? ` · ${fmtBytes(w.targetBytes)} target/` : ""}
                </Text>
              </Row>
            ))}
          </Box>
        ))
      )}

      {sandbox && (sandbox.installed || sandbox.tarballBytes > 0) && (
        <Box pad={[4, 16]} bg="var(--bg-panel)" border="soft" radius={8} style={{ marginBottom: 12 }}>
          <Row gap={12} style={{ padding: "10px 0" }}>
            <Box style={{ flex: 1, minWidth: 0 }}>
              <Text as="div" size={13} style={{ fontFamily: "var(--sans)", color: "var(--fg)" }}>Agent sandbox (WSL2)</Text>
              <Text as="div" mono size={10.5} tone="dim" style={{ marginTop: 2 }}>
                {fmtBytes(sandbox.distroBytes)} distro image{sandbox.tarballBytes > 0 ? ` · ${fmtBytes(sandbox.tarballBytes)} cached image` : ""} · the sealed WSL2 isolation cage
              </Text>
            </Box>
            <ConfirmButton size="sm" label="Remove" armedLabel="Confirm" disabled={busy} onConfirm={removeSandbox} />
          </Row>
        </Box>
      )}

      {notice && (
        <Text as="div" mono size={11} tone="accent" style={{ marginTop: 4, wordBreak: "break-all" }}>{notice}</Text>
      )}

      <Text as="div" size={10.5} tone="dim" style={{ fontFamily: "var(--sans)", lineHeight: 1.5, marginTop: 12 }}>
        Worktrees live under <code className="mono">~/.base-studio-code/worktrees/</code>; the agent sandbox under <code className="mono">~/.base-studio-code/wsl/</code>. Removing the sandbox is reversible — reinstall it from <strong>Settings → Security</strong>.
      </Text>
    </Stack>
  );
}
