// Planning page overlays, split out of Planning.tsx (decomposition pass).
//
// The plan-page modal stack: the blueprint-version-mismatch prompt, the MCP download-confirmation
// queue, and the clear-plan confirmation. Each is conditionally rendered from state Planning.tsx
// owns; this component is pure presentation (no hooks/refs), so it does not affect the parent's
// hook-call order. (The self-rendering quarantine dialog stays in Planning.tsx — it is a ready-made
// node, not a modal built here.)
import { Dialog } from "@/shared/ui/overlay/Dialog";
import { Button } from "@/shared/ui/controls/Button";
import { BlueprintUpdateModal } from "../blueprints/BlueprintUpdateModal";
import { McpDownloadModal, type McpDownloadItem } from "../pane/McpDownloadModal";

export interface PlanningDialogsProps {
  // Blueprint version-mismatch prompt (#827/#1296).
  showBlueprintModal: boolean;
  restarting: boolean;
  onBlueprintGoBack: () => void;
  onBlueprintKeep: () => void;
  onBlueprintRestart: () => void;
  onBlueprintDismiss: () => void;
  // MCP download-confirmation queue (#1474).
  mcpDownloads: McpDownloadItem[];
  onConfirmMcpDownloads: () => void;
  onCancelMcpDownloads: () => void;
  // Clear-plan confirmation (#664).
  showClearConfirm: boolean;
  onDismissClear: () => void;
  onClearPlan: () => void;
}

export function PlanningDialogs({
  showBlueprintModal, restarting,
  onBlueprintGoBack, onBlueprintKeep, onBlueprintRestart, onBlueprintDismiss,
  mcpDownloads, onConfirmMcpDownloads, onCancelMcpDownloads,
  showClearConfirm, onDismissClear, onClearPlan,
}: PlanningDialogsProps) {
  return (
    <>
      {showBlueprintModal && (
        <BlueprintUpdateModal
          busy={restarting}
          onGoBack={onBlueprintGoBack}
          onKeep={onBlueprintKeep}
          onRestart={onBlueprintRestart}
          onDismiss={onBlueprintDismiss}
        />
      )}

      {mcpDownloads.length > 0 && (
        <McpDownloadModal
          items={mcpDownloads}
          onConfirm={onConfirmMcpDownloads}
          onCancel={onCancelMcpDownloads}
        />
      )}

      {showClearConfirm && (
        <Dialog
          title="Clear this plan?"
          danger
          onDismiss={onDismissClear}
          actions={
            <>
              <Button onClick={onDismissClear}>cancel</Button>
              <Button
                style={{ borderColor: "var(--danger)", color: "var(--danger)" }}
                onClick={onClearPlan}
              >clear plan</Button>
            </>
          }
        >
          This wipes the entire plan for this project — sections, stage config, the fleet, and the
          on-disk plan files — then restarts the planner with a blank slate. This can't be undone.
        </Dialog>
      )}
    </>
  );
}
