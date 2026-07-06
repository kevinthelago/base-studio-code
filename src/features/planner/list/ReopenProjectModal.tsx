// The reopen-mismatch modal (#2409) — a board project whose `projectSlug(name)` has no local hub.
// The only job the retired node-id alias did, now an explicit one-time choice:
//   • Link to an existing local project — a REAL on-disk move of the chosen hub onto the name key
//     (`relink_project_hub`: hub + worktrees + `git worktree repair`), plus the store-side rekey
//     (`rekeyProjectData`), so every later open derives straight to it. One-time by construction.
//   • Start fresh — proceed under the name key; the planner scaffolds a new hub there.
// Shared by the Projects list (`PublishedProjects.handleEditPlan`) and the GitHub board header
// (`ProjectsHeader.handlePlan`) via the `useReopenProject` hook.

import { useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import { Dialog } from "@/shared/ui/overlay/Dialog";
import { Button } from "@/shared/ui/controls/Button";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { InlineError } from "@/shared/ui/feedback/InlineError";
import { timeAgoMs } from "@/shared/lib/core/format";
import { resolveReopen } from "./reopenProject";
import type { LocalProjectLite } from "./drafts";

interface PendingReopen<T> {
  target: T;
  title: string;
  key: string;
  candidates: LocalProjectLite[];
  selected: string | null; // the candidate hub key picked for linking
}

export interface ReopenController<T> {
  /**
   * Open `target` (a board project named `title`) against the local hubs: a hub at
   * `projectSlug(title)` opens immediately; otherwise the mismatch modal takes over (when there is
   * at least one local hub to link — with none, linking is impossible and it starts fresh).
   */
  begin: (target: T, title: string, locals: LocalProjectLite[]) => void;
  /** The modal to render (null when idle). */
  modal: ReactNode;
}

/**
 * The reopen flow (#2409): derivation first, modal for the mismatch. `open(target, key)` is the
 * caller's own "enter the planning session under this key" step, invoked once the key is settled.
 */
export function useReopenProject<T>(
  open: (target: T, key: string) => void,
  onLinked?: () => void,
): ReopenController<T> {
  const rekeyProjectData = useAppStore((s) => s.rekeyProjectData);
  const [pending, setPending] = useState<PendingReopen<T> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function begin(target: T, title: string, locals: LocalProjectLite[]) {
    const res = resolveReopen(title, locals);
    // Hub found at the name key (the normal case), or nothing local to link — open directly.
    if (res.hub || res.candidates.length === 0) {
      open(target, res.key);
      return;
    }
    setError(null);
    setPending({ target, title, key: res.key, candidates: res.candidates, selected: res.suggested?.key ?? null });
  }

  async function link() {
    if (!pending?.selected) return;
    setBusy(true);
    setError(null);
    try {
      // The one-time on-disk move: projects/<old> → projects/<key>, worktrees too, links repaired.
      await invoke("relink_project_hub", { oldKey: pending.selected, newKey: pending.key });
      // …and the store half: move every per-project map entry onto the name key.
      rekeyProjectData(pending.selected, pending.key);
      const { target, key } = pending;
      setPending(null);
      onLinked?.();
      open(target, key);
    } catch (e) {
      setError(String(e)); // keep the modal up — the hub may be open in a console session
    } finally {
      setBusy(false);
    }
  }

  function fresh() {
    if (!pending) return;
    const { target, key } = pending;
    setPending(null);
    open(target, key);
  }

  const modal = pending ? (
    <Dialog
      title={`No local copy of “${pending.title}”`}
      onDismiss={busy ? () => {} : () => setPending(null)}
      actions={
        <>
          <Button variant="ghost" onClick={() => setPending(null)} disabled={busy}>cancel</Button>
          <Button variant="ghost" onClick={fresh} disabled={busy}>start fresh</Button>
          <Button variant="primary" onClick={link} disabled={busy || !pending.selected}>
            {busy ? "linking…" : "link selected"}
          </Button>
        </>
      }
    >
      <Text as="p" size={12} style={{ margin: "0 0 12px" }}>
        No local project folder is named <Text as="span" mono style={{ color: "var(--fg)" }}>{pending.key}</Text> —
        the name is the project's identity, so its files are expected there. Link an existing local
        project (a one-time move onto that name) or start fresh.
      </Text>
      <Box border="soft" radius="md" style={{ maxHeight: 220, overflow: "auto" }}>
        {pending.candidates.map((lp) => (
          <Box
            key={lp.key}
            onClick={busy ? undefined : () => setPending((p) => (p ? { ...p, selected: lp.key } : p))}
            pad={[7, 10]}
            bg={pending.selected === lp.key ? "var(--bg-elev2)" : undefined}
            style={{ cursor: "pointer", borderTop: "1px solid var(--border-soft)", display: "flex", alignItems: "center", gap: 8 }}
          >
            <Box as="span" bg={pending.selected === lp.key ? "var(--accent)" : "var(--border)"} radius={99} style={{ width: 7, height: 7, flexShrink: 0 }} />
            <Text as="span" size={12} style={{ color: "var(--fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{lp.title}</Text>
            <Text as="span" mono size={10} tone="dim" style={{ marginLeft: "auto", whiteSpace: "nowrap" }}>
              {lp.key} · {timeAgoMs(lp.updatedAt)}
            </Text>
          </Box>
        ))}
      </Box>
      {error && <InlineError style={{ marginTop: 12 }}>{error}</InlineError>}
    </Dialog>
  ) : null;

  return { begin, modal };
}
