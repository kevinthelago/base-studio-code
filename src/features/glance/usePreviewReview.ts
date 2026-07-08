// usePreviewReview (#2623 slice 5b) — the reviewer loop's actuator for the open preview node. Owns the
// display-capture stream, turns a "Capture & review" click into a shot → Claude review (5c) → findings
// merged into the confirm-gated inbox (5a store), and exposes confirm/dismiss. Findings live in the store
// keyed by project so the strip re-renders; the stream is a ref (one OS "share" pick, reused per shot).

import { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore } from "@/store";
import { resolveLlmConfig } from "@/shared/lib/core/llmConfig";
import { startPreviewCapture, grabFrame, stopCapture, screenCaptureAvailable } from "@/shared/lib/preview/captureFrame";
import { reviewShot } from "@/shared/lib/preview/reviewShot";
import { injectPrompt } from "@/shared/lib/fleet/paneInject";
import {
  mergeFindings,
  setFindingStatus,
  pendingFindings,
  confirmedFindings,
  routedFindings,
  reviewDispatchPrompt,
  type PreviewShot,
  type ReviewFinding,
} from "@/shared/lib/preview/previewReview";

const EMPTY: ReviewFinding[] = [];
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A readable screen label from a shot id (`<key>:<seq>` → "Screen N") for the dispatch prose. */
function screenLabel(shotId: string): string {
  const seq = Number(shotId.split(":").pop());
  return Number.isFinite(seq) ? `Screen ${seq + 1}` : shotId;
}

export interface PreviewReview {
  findings: ReviewFinding[];
  pending: ReviewFinding[];
  confirmed: ReviewFinding[];
  /** Findings already routed to the fleet (a tally; they don't re-dispatch). */
  routed: ReviewFinding[];
  /** Screen capture is available in this webview (gate the capture button). */
  canCapture: boolean;
  /** A capture + review is in flight. */
  busy: boolean;
  /** The last capture/review/dispatch failure, or null. */
  error: string | null;
  /** Capture the current preview frame and review it — folds new findings into the inbox. */
  captureAndReview: () => Promise<void>;
  confirm: (id: string) => void;
  dismiss: (id: string) => void;
  /** Route all confirmed findings to the project's director (bsc-issue → bsc-assign) and mark them routed. */
  dispatch: () => Promise<void>;
}

export function usePreviewReview(projectKey: string | null): PreviewReview {
  const findings = useAppStore((s) => (projectKey ? s.reviewFindings[projectKey] : undefined) ?? EMPTY);
  const streamRef = useRef<MediaStream | null>(null);
  const seqRef = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // End the OS "sharing" stream when the preview closes / the hook unmounts.
  useEffect(() => () => { stopCapture(streamRef.current); streamRef.current = null; }, []);

  const captureAndReview = useCallback(async () => {
    if (!projectKey || busy) return;
    setError(null);
    setBusy(true);
    try {
      if (!streamRef.current) streamRef.current = await startPreviewCapture();
      const image = await grabFrame(streamRef.current);
      const seq = seqRef.current++;
      const shot: PreviewShot = { id: `${projectKey}:${seq}`, label: `Screen ${seq + 1}`, image };
      const found = await reviewShot(resolveLlmConfig(useAppStore.getState()), shot, seq);
      const store = useAppStore.getState();
      store.setReviewFindings(projectKey, mergeFindings(store.reviewFindings[projectKey] ?? [], found));
    } catch (e) {
      setError(errText(e));
      // A failure often means the user stopped sharing — drop the stream so the next try re-prompts.
      stopCapture(streamRef.current);
      streamRef.current = null;
    } finally {
      setBusy(false);
    }
  }, [projectKey, busy]);

  const setStatus = useCallback((id: string, status: ReviewFinding["status"]) => {
    if (!projectKey) return;
    const store = useAppStore.getState();
    store.setReviewFindings(projectKey, setFindingStatus(store.reviewFindings[projectKey] ?? [], id, status));
  }, [projectKey]);

  const dispatch = useCallback(async () => {
    if (!projectKey) return;
    const store = useAppStore.getState();
    const confirmed = confirmedFindings(store.reviewFindings[projectKey] ?? []);
    if (confirmed.length === 0) return;
    // The director is where the fleet's coordination runs — no live fleet, nowhere to route.
    if (store.findFleetTabIdx(projectKey) < 0) {
      setError("No running fleet — launch it first so the director can pick up the review.");
      return;
    }
    setError(null);
    try {
      await injectPrompt(`${projectKey}:director`, reviewDispatchPrompt(confirmed, screenLabel));
      let next = store.reviewFindings[projectKey] ?? [];
      for (const f of confirmed) next = setFindingStatus(next, f.id, "routed");
      store.setReviewFindings(projectKey, next);
    } catch (e) {
      setError(errText(e));
    }
  }, [projectKey]);

  return {
    findings,
    pending: pendingFindings(findings),
    confirmed: confirmedFindings(findings),
    routed: routedFindings(findings),
    canCapture: screenCaptureAvailable(),
    busy,
    error,
    captureAndReview,
    confirm: useCallback((id: string) => setStatus(id, "confirmed"), [setStatus]),
    dismiss: useCallback((id: string) => setStatus(id, "dismissed"), [setStatus]),
    dispatch,
  };
}
