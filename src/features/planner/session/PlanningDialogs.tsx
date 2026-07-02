// Planning page overlays, split out of Planning.tsx (decomposition pass).
//
// The plan-page modal stack: the blueprint-version-mismatch prompt, the MCP download-confirmation
// queue, the clear-plan confirmation, and the switch-blueprint picker. Each is conditionally
// rendered from state Planning.tsx owns; this component is pure presentation (no hooks/refs), so it
// does not affect the parent's hook-call order. (The self-rendering quarantine dialog stays in
// Planning.tsx — it is a ready-made node, not a modal built here.)
import { Dialog } from "@/shared/ui/overlay/Dialog";
import { Button } from "@/shared/ui/controls/Button";
import { Chip } from "@/shared/ui/data/Chip";
import { Box } from "@/shared/ui/layout/Box";
import { Stack } from "@/shared/ui/layout/Stack";
import { Text } from "@/shared/ui/typography/Text";
import { BlueprintUpdateModal } from "../blueprints/BlueprintUpdateModal";
import { McpDownloadModal, type McpDownloadItem } from "../pane/McpDownloadModal";
import { blueprintCategory, type Blueprint } from "../stages/blueprints";

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
  // Switch-blueprint picker (#923/#1281).
  switchOpen: boolean;
  onDismissSwitch: () => void;
  switchTargets: Blueprint[];
  onSwitchBlueprint: (id: string) => void;
}

export function PlanningDialogs({
  showBlueprintModal, restarting,
  onBlueprintGoBack, onBlueprintKeep, onBlueprintRestart, onBlueprintDismiss,
  mcpDownloads, onConfirmMcpDownloads, onCancelMcpDownloads,
  showClearConfirm, onDismissClear, onClearPlan,
  switchOpen, onDismissSwitch, switchTargets, onSwitchBlueprint,
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

      {switchOpen && (
        <Dialog
          title="Switch blueprint"
          onDismiss={onDismissSwitch}
          actions={<Button onClick={onDismissSwitch}>cancel</Button>}
        >
          <Text as="div" size={12} tone="muted" style={{ marginBottom: 12, lineHeight: 1.6 }}>
            Switch this project to a different blueprint. This re-seeds the plan for the chosen blueprint and
            <b> clears the current plan + progress</b> — this can't be undone. Pick a target:
          </Text>
          <Stack gap={8}>
            {switchTargets.map((bp) => (
              <Button key={bp.id} variant="ghost" style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 3, height: "auto", padding: "10px 12px", textAlign: "left" }}
                onClick={() => onSwitchBlueprint(bp.id)}>
                <Box as="span" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Text as="span" weight={600} style={{ color: "var(--fg)" }}>{bp.name}</Text>
                  <Chip style={{ fontSize: 9 }}>{blueprintCategory(bp)}</Chip>
                </Box>
                {bp.desc && <Text as="span" size={11} tone="dim" style={{ fontFamily: "var(--sans)" }}>{bp.desc}</Text>}
              </Button>
            ))}
          </Stack>
        </Dialog>
      )}
    </>
  );
}
