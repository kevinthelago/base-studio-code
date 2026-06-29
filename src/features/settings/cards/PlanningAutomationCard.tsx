import { useAppStore } from "@/store";
import { SettingsCardHead, ToggleRow } from "../pages/SettingsControls";

export function PlanningAutomationCard() {
  const { autoPlanWithClaude, setAutoPlanWithClaude } = useAppStore();
  const autoCompleteGates = useAppStore(s => s.autoCompleteGates);
  const setAutoCompleteGates = useAppStore(s => s.setAutoCompleteGates);
  const allowGateOverride = useAppStore(s => s.allowGateOverride);
  const setAllowGateOverride = useAppStore(s => s.setAllowGateOverride);

  return (
    <div className="card">
      <SettingsCardHead title="Planning automation" />
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <ToggleRow
          on={autoPlanWithClaude}
          onToggle={() => setAutoPlanWithClaude(!autoPlanWithClaude)}
          title="Automate planning with the LLM"
        >
          Adds an <b>Auto-plan</b> control to the project planner: from your pitch, the model
          answers its own discovery questions and drives the plan to a publishable state for
          your review — it never auto-publishes to GitHub. Runs under the least-privilege
          "Planning Autopilot" agent role. Requires an API key for the selected provider (above).
        </ToggleRow>
        <ToggleRow
          on={autoCompleteGates}
          onToggle={() => setAutoCompleteGates(!autoCompleteGates)}
          title="Auto-advance planner gates"
        >
          When a planning stage's sections are drafted and its gate is ready, confirm it
          automatically instead of clicking <b>approve &amp; continue</b> each time. You still drive
          the conversation — only the per-gate approval is automated. Off by default; steps aside
          while Auto-plan is running.
        </ToggleRow>
        <ToggleRow
          on={allowGateOverride}
          onToggle={() => setAllowGateOverride(!allowGateOverride)}
          title="Allow gate override"
        >
          Lets you <b>advance past a planning stage whose gate isn't satisfied</b>. When on, a
          blocked stage's advance button becomes a cautionary <b>override gate &amp; continue</b> you
          can click to move on anyway. Off by default — only the user can override, never the planner.
        </ToggleRow>
      </div>
    </div>
  );
}
