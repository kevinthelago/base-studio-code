// Session-readiness state for a terminal pane (#1645). Owns the preflight verdict (#564) that
// TerminalView renders as the SessionFailure / SessionReadinessBanner, the critical/warning splits it
// derives, and the manual retry. The mount-effect launch path sets the verdict via `setReadinessVerdict`
// after its own preflight probe (which runs with the resolved GH token); this hook owns the same probe
// for the user-triggered retry. Kept here (not in lib/) because it carries React state.

import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { log } from "@/shared/lib/core/log";
import { interpretDiagnostics, sessionVerdictFromReport, type PrereqStatus, type SessionVerdict } from "@/shared/lib/core/diagnostics";
import { tokenForRepo } from "@/shared/lib/github/repoCredentials";
import { useAppStore } from "@/store";

export function useTerminalSession(paneId: string, initialCwd?: string) {
  // Session readiness verdict (#564). Set after the preflight probe runs in the mount effect (after
  // the GH token is resolved so gh-auth uses the right env), or by `retryReadiness` below.
  const [readinessVerdict, setReadinessVerdict] = useState<SessionVerdict | null>(null);

  // Derive critical + warning lists from the verdict for rendering.
  const criticalChecks = readinessVerdict?.failed.filter((c) => c.severity === "critical") ?? [];
  const warningChecks  = readinessVerdict?.failed.filter((c) => c.severity === "warning")  ?? [];

  function retryReadiness() {
    const cwd = initialCwd ?? "";
    // #3984: say so rather than returning silently. A no-op retry is indistinguishable from one that
    // ran and got the same verdict — which is exactly how the button read while the probe was failing
    // to spawn (#3984): it fired 15 times a boot and looked dead every time.
    if (!cwd) {
      log.warn(`console[${paneId}] readiness retry skipped — this pane has no cwd, so there is nothing to probe`);
      return;
    }
    const ghToken = tokenForRepo(
      useAppStore.getState().paneRepos[paneId],
      useAppStore.getState().repoGithubTokens,
      useAppStore.getState().githubToken,
    );
    const env = ghToken ? { GH_TOKEN: ghToken } : null;
    invoke<PrereqStatus[]>("preflight", { cwd, env })
      .then((prereqs) => setReadinessVerdict(sessionVerdictFromReport(interpretDiagnostics(prereqs))))
      .catch((e) => log.error(`console[${paneId}] preflight retry failed: ${e}`));
  }

  return { setReadinessVerdict, criticalChecks, warningChecks, retryReadiness };
}
