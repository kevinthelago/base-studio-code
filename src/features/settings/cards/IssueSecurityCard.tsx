import { useAppStore } from "@/store";
import { SettingsCardHead, ToggleRow } from "../screens/SettingsControls";

export function IssueSecurityCard() {
  const { restrictToBscIssues, setRestrictToBscIssues } = useAppStore();

  return (
    <div className="card">
      <SettingsCardHead title="Issue security" />
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
