import { useAppStore } from "@/store";
import { ToggleRow } from "../screens/SettingsControls";

export function IssueSecurityCard() {
  const { restrictToBscIssues, setRestrictToBscIssues } = useAppStore();

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "baseline", marginBottom: 12, gap: 10 }}>
        <h3 style={{ margin: 0 }}>Issue security</h3>
      </div>
      <ToggleRow
        on={restrictToBscIssues}
        onToggle={() => setRestrictToBscIssues(!restrictToBscIssues)}
        title="Only act on base-studio-code-authored issues"
      >
        GitHub issues are an untrusted input channel. When on (recommended), triage and any
        agent that pulls live issues work <b>only</b> issues base-studio-code created (the{" "}
        <code>bsc-generated</code> label) — a hand-created or injected issue is ignored, so a
        malicious issue can't drive a worker. Turn off to triage every open issue.
      </ToggleRow>
    </div>
  );
}
