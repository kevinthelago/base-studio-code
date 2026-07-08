// The CI watcher (#373): closes the open-PR loop. A worker opens a PR and stops; CI runs
// unattended on GitHub. This hook polls each worker PR's check-run status and, when it
// reaches a terminal state, tells the worker to CONTINUE (passed -> next issue/stop;
// failed -> fix + push) and nudges the director to merge on green. App-side because CI is an
// external event no one can push -- something has to watch it; doing it here means the worker
// stops (no idle tokens) and is resumed only when there is something to do. Mounted once in
// ConsoleWorkspace. Pure rollup/prompts live in ciStatus.ts; this is the Tauri/React actuator.
import { useRef } from "react";
import { safeInvoke } from "@/shared/lib/core/safeInvoke";
import { useAppStore } from "@/store";
import { usePoll } from "@/shared/hooks/usePoll";
import { injectPrompt } from "@/shared/lib/fleet/paneInject";
import {
  rollupChecks, isTerminalCi, ciWorkerPrompt, ciDirectorMergePrompt, ciDevelopRedPrompt,
  type CheckRun, type CiState,
} from "./ciStatus";

const POLL_MS = 30000;

interface Pr { number: number; head: { ref: string; sha: string }; }

// Fleet panes use STABLE IDENTITY ids (#1176) — a worker is `<projectKey>:<streamId>`, its director is
// `<projectKey>:director` (project keys are `[A-Za-z0-9-]`, so the first `:` splits off the key). A legacy
// fleet uses positional `t{n}p{m}` ids (director = p0 of the tab). The old `slice(0, indexOf("p"))` math
// silently mis-resolved an identity id (the `p` in e.g. "my**p**roject") to a garbage pane, so the director
// never received the green-PR MERGE nudge and merged nothing (#2604). Both helpers handle either shape.

/** A fleet pane's project GROUP — its stable-identity project key, or a positional pane's tab prefix. */
export function ciGroupKey(paneId: string): string {
  return paneId.includes(":") ? paneId.split(":")[0] : paneId.slice(0, paneId.indexOf("p") + 1);
}
/** The DIRECTOR pane id for a worker pane — `<projectKey>:director`, or p0 of a legacy positional tab. */
export function ciDirectorPaneFor(paneId: string): string {
  return paneId.includes(":") ? `${paneId.split(":")[0]}:director` : `${paneId.slice(0, paneId.indexOf("p"))}p0`;
}

export function useCiWatcher(): void {
  // Per (repo#pr@sha) last CI state, so we inject once per transition into a terminal state
  // (a re-pushed fix gets a new sha -> a fresh key -> delivered again on its result).
  const lastState = useRef<Map<string, CiState>>(new Map());
  const inFlight = useRef<Set<string>>(new Set());
  // Per (repo@developSha) last CI state for the watchdog path (#378): a new develop head
  // re-arms the alert, so we inject the red prompt at most once per failing head.
  const lastDevelop = useRef<Map<string, CiState>>(new Map());
  usePoll(async (isCancelled) => {
      if (isCancelled()) return;
      const token = useAppStore.getState().githubToken;
      const streams = useAppStore.getState().paneStream;
      const directorModes = useAppStore.getState().paneDirectorMode;
      const entries = Object.entries(streams);
      if (!token || entries.length === 0) return;

      // A project's director is in watchdog mode when its pane's mode === "watchdog"; group by project key.
      const watchdogGroups = new Set<string>();
      for (const [paneId, mode] of Object.entries(directorModes)) {
        if (mode === "watchdog") watchdogGroups.add(ciGroupKey(paneId));
      }

      // ── Watchdog path (#378): no worker PRs in a self-merge fleet — watch develop's CI
      // instead and nudge the director to revert + ping the owner when it goes red.
      const developRepos = new Map<string, string>(); // repo -> watchdog director paneId
      for (const [paneId, st] of entries) {
        if (!watchdogGroups.has(ciGroupKey(paneId))) continue;
        if (!developRepos.has(st.repo)) developRepos.set(st.repo, ciDirectorPaneFor(paneId));
      }
      for (const [repo, directorPane] of developRepos) {
        const checks = await safeInvoke<{ check_runs: CheckRun[] } | null>("github_request", { token, path: `repos/${repo}/commits/develop/check-runs` }, null);
        if (isCancelled() || !checks) continue;
        const runs = checks.check_runs ?? [];
        const sha = runs[0]?.head_sha ?? "";
        if (!sha) continue;
        const key = `${repo}@${sha}`;
        if (inFlight.current.has(key)) continue;
        const { state, failing } = rollupChecks(runs);
        if (state === lastDevelop.current.get(key)) continue;
        lastDevelop.current.set(key, state);
        if (!isTerminalCi(state) || state !== "failed") continue;
        inFlight.current.add(key);
        void injectPrompt(directorPane, ciDevelopRedPrompt(repo, sha, failing))
          .catch(() => {})
          .finally(() => inFlight.current.delete(key));
      }

      const paneByRepoBranch = new Map<string, string>();
      const repos = new Set<string>();
      for (const [paneId, st] of entries) {
        // A worker whose project's director is a watchdog has no PR to watch — skip it.
        if (watchdogGroups.has(ciGroupKey(paneId))) continue;
        paneByRepoBranch.set(st.repo + "#" + st.branch, paneId);
        repos.add(st.repo);
      }

      for (const repo of repos) {
        const prs = await safeInvoke<Pr[] | null>("github_request", { token, path: `repos/${repo}/pulls?state=open&per_page=100` }, null);
        if (isCancelled() || !prs) continue;
        for (const pr of prs) {
          const paneId = paneByRepoBranch.get(repo + "#" + pr.head.ref);
          if (!paneId) continue; // a PR from a branch we do not own
          const prKey = `${repo}#${pr.number}@${pr.head.sha}`;
          if (inFlight.current.has(prKey)) continue;
          const checks = await safeInvoke<{ check_runs: CheckRun[] } | null>("github_request", { token, path: `repos/${repo}/commits/${pr.head.sha}/check-runs` }, null);
          if (isCancelled() || !checks) continue;
          const { state, failing } = rollupChecks(checks.check_runs ?? []);
          if (state === lastState.current.get(prKey)) continue;
          lastState.current.set(prKey, state);
          if (!isTerminalCi(state)) continue;

          inFlight.current.add(prKey);
          const writes: Promise<unknown>[] = [
            injectPrompt(paneId, ciWorkerPrompt(pr.number, state, failing)).catch(() => {}),
          ];
          if (state === "passed") {
            // The director for this worker's PROJECT — its stable identity `<projectKey>:director` (#2604).
            const directorPane = ciDirectorPaneFor(paneId);
            if (useAppStore.getState().paneDirectorDrive[directorPane]) {
              writes.push(injectPrompt(directorPane, ciDirectorMergePrompt(pr.number, pr.head.ref)).catch(() => {}));
            }
          }
          void Promise.all(writes).finally(() => inFlight.current.delete(prKey));
        }
      }
  }, POLL_MS);
}
