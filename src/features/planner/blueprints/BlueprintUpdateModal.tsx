import { Dialog } from "@/shared/ui/overlay/Dialog";
import { BackButton } from "@/shared/ui/controls/BackButton";
import { Button } from "@/shared/ui/controls/Button";

/**
 * Shown when a project is opened whose blueprint / planner-template version differs from the one
 * it was seeded with (#827). Replaces the old silent "context updated · refresh" — which restarted
 * the planner into a destructive reconciliation that deleted plan files — with an explicit
 * three-way choice. Pure presentational: the page owns what each choice does.
 */
export function BlueprintUpdateModal({ busy, onGoBack, onKeep, onRestart, onDismiss }: {
  /** A regenerate/restart is already in flight — disable the mutating choices. */
  busy?: boolean;
  /** Return to the projects list, leaving the plan untouched. */
  onGoBack: () => void;
  /** Adopt the new version but preserve all plan files. */
  onKeep: () => void;
  /** Wipe the plan and start fresh on the new version (destructive). */
  onRestart: () => void;
  /** Dismiss (Escape / click-away) without choosing. */
  onDismiss: () => void;
}) {
  return (
    <Dialog
      title="This project's blueprint has changed"
      onDismiss={onDismiss}
      actions={
        <>
          <BackButton variant="text" label="go back" className="btn ghost" onClick={onGoBack} aria-label="Go back" />
          <Button disabled={busy} onClick={onKeep}>keep previous plan files</Button>
          <Button
            style={{ borderColor: "var(--danger)", color: "var(--danger)" }}
            disabled={busy}
            onClick={onRestart}
          >restart the plan</Button>
        </>
      }
    >
      The blueprint or planner template this project was set up with has been updated since you last
      planned it. Choose how to proceed:
      <ul style={{ margin: "10px 0 0", paddingLeft: 18, lineHeight: 1.6 }}>
        <li><b>Go back</b> — return to the projects list and leave this plan untouched.</li>
        <li><b>Keep previous plan files</b> — adopt the new version but preserve everything you've planned (goal, scope, features, fleet, …).</li>
        <li><b>Restart the plan</b> — wipe the plan and start fresh on the new version. This can't be undone.</li>
      </ul>
    </Dialog>
  );
}
