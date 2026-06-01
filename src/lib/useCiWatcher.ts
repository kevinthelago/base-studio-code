// The CI watcher (#373): closes the open-PR loop. A worker opens a PR and stops; CI runs
// unattended on GitHub. This hook polls each worker PR's check-run status and, when it
// reaches a terminal state, tells the worker to CONTINUE (passed -> next issue/stop;
// failed -> fix + push) and nudges the director to merge on green. App-side because CI is an
// external event no one can push -- something has to watch it; doing it here means the worker
// stops (no idle tokens) and is resumed only when there is something to do. Mounted once in
// ConsoleScreen. Pure rollup/prompts live in ciStatus.ts; this is the Tauri/React actuator.
import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import {
  rollupChecks, isTerminalCi, ciWorkerPrompt, ciDirectorMergePrompt,
  type CheckRun, type CiState,
} from "./ciStatus";

const POLL_MS = 30000;

interface Pr { number: number; head: { ref: string; sha: string }; }

export function useCiWatcher(): void {
  // Per (repo#pr@sha) last CI state, so we inject once per transition into a terminal state
  // (a re-pushed fix gets a new sha -> a fresh key -> delivered again on its result).
  const lastState = useRef<Map<string, CiState>>(new Map());
  const inFlight = useRef<Set<string>>(new Set());
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      const token = useAppStore.getState().githubToken;
      const streams = useAppStore.getState().paneStream;
      const entries = Object.entries(streams);
      if (!token || entries.length === 0) return;

      const paneByRepoBranch = new Map<string, string>();
      const repos = new Set<string>();
      for (const [paneId, st] of entries) {
        paneByRepoBranch.set(st.repo + "#" + st.branch, paneId);
        repos.add(st.repo);
      }

      for (const repo of repos) {
        const prs = await invoke<Pr[]>("github_request", { token, path: `repos/${repo}/pulls?state=open&per_page=100` }).catch(() => null);
        if (cancelled || !prs) continue;
        for (const pr of prs) {
          const paneId = paneByRepoBranch.get(repo + "#" + pr.head.ref);
          if (!paneId) continue; // a PR from a branch we do not own
          const prKey = `${repo}#${pr.number}@${pr.head.sha}`;
          if (inFlight.current.has(prKey)) continue;
          const checks = await invoke<{ check_runs: CheckRun[] }>("github_request", { token, path: `repos/${repo}/commits/${pr.head.sha}/check-runs` }).catch(() => null);
          if (cancelled || !checks) continue;
          const { state, failing } = rollupChecks(checks.check_runs ?? []);
          if (state === lastState.current.get(prKey)) continue;
          lastState.current.set(prKey, state);
          if (!isTerminalCi(state)) continue;

          inFlight.current.add(prKey);
          const writes: Promise<unknown>[] = [
            invoke("pty_write", { paneId, data: ciWorkerPrompt(pr.number, state, failing) + "\r" }).catch(() => {}),
          ];
          if (state === "passed") {
            // The director for this worker is pane 0 of the same tab (t<n>p0).
            const directorPane = paneId.slice(0, paneId.indexOf("p")) + "p0";
            if (useAppStore.getState().paneDirectorDrive[directorPane]) {
              writes.push(invoke("pty_write", { paneId: directorPane, data: ciDirectorMergePrompt(pr.number, pr.head.ref) + "\r" }).catch(() => {}));
            }
          }
          void Promise.all(writes).finally(() => inFlight.current.delete(prKey));
        }
      }
    };
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);
}
