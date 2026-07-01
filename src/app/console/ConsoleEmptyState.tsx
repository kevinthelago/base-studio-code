import { LayoutGrid } from "lucide-react";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";
import { Button } from "@/shared/ui/controls/Button";

/** Shown in the console page when there are no tabs yet — built on the shared <EmptyState>. */
export function ConsoleEmptyState({ onNew }: { onNew: () => void }) {
  return (
    <EmptyState
      icon={<LayoutGrid size={26} />}
      title="No workspaces"
      description="Create a workspace to start running agents in parallel."
      actions={<Button variant="primary" onClick={onNew}>New workspace</Button>}
    />
  );
}
