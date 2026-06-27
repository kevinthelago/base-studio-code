// useSetupSignature (#1775, extracted from Planning.tsx) — the "context updated · refresh" badge
// signal (#175/#756). `currentSig` is the live signature of the inputs (computed in Rust so its
// format can't drift from the baseline); `lastSetupSig` is the baseline setup_workspaces last wrote.
// When they diverge (a repo linked / blueprint changed mid-session, or the planner template bumped)
// `contextStale` is true. `refreshSetupSig` re-reads the baseline — call after every workspace setup.
import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

export function useSetupSignature(
  effectiveProjectId: string,
  linkedRepos: string[],
  stageIdsFor: (key: string) => string[],
): { currentSig: string | null; lastSetupSig: string | null; refreshSetupSig: () => void; contextStale: boolean } {
  const [currentSig, setCurrentSig] = useState<string | null>(null);
  const [lastSetupSig, setLastSetupSig] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    invoke<string>("compute_context_signature", {
      repoFullNames: linkedRepos,
      enabledStages: stageIdsFor(effectiveProjectId),
    }).then(sig => { if (live) setCurrentSig(sig); }).catch(() => { if (live) setCurrentSig(null); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedRepos, effectiveProjectId]);
  // Re-read the baseline the backend last wrote — called on open and after every workspace setup
  // (mount / link / restart), so the badge reflects the most recent regeneration.
  const refreshSetupSig = useCallback(() => {
    invoke<string>("get_context_signature", { projectKey: effectiveProjectId })
      .then(s => setLastSetupSig(s || null)).catch(() => {});
  }, [effectiveProjectId]);
  useEffect(() => { refreshSetupSig(); }, [refreshSetupSig]);
  const contextStale = !!currentSig && !!lastSetupSig && currentSig !== lastSetupSig;
  return { currentSig, lastSetupSig, refreshSetupSig, contextStale };
}
