// GraphPageFallback (#3648, epic #3604) — the shared fallback for a graph-hosted page (Fleet / Automations
// / Security …) whose source isn't loadable from the components graph: missing (the store hasn't re-seeded
// after a migration landed) or failing to compile/load. Instead of sending the user to Settings/Studio to
// re-seed, it offers a ONE-CLICK re-seed right here — `hydrateComponents()` reconciles the store toward the
// packaged seed and pushes any missing built-ins. GraphComponent subscribes to the page's `srcText`, so a
// successful re-seed makes the source appear and the host re-renders straight into the real page (this
// fallback unmounts). If the source seeds but the load still fails (a page's platform modules register at
// startup, so a mid-session code update needs one reload), the button's done-state points at that.
import { useState, type ReactNode } from "react";
import { useAppStore } from "@/store";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";
import { Button } from "@/shared/ui/controls/Button";

export function GraphPageFallback({ page, icon = "⑃" }: { page: string; icon?: ReactNode }) {
  const hydrateComponents = useAppStore((s) => s.hydrateComponents);
  const [status, setStatus] = useState<"idle" | "seeding" | "done" | "error">("idle");

  async function reseed() {
    setStatus("seeding");
    try {
      await hydrateComponents();
      // On success with the source present, GraphComponent re-renders into the page and this unmounts.
      // If it's still here after this, the source seeded but the load failed → the done-copy guides a reload.
      setStatus("done");
    } catch {
      setStatus("error");
    }
  }

  const description =
    status === "done"
      ? `Re-seeded the component library. If ${page} is still blank, reload the window — a page's modules register at startup.`
      : status === "error"
        ? "Re-seed failed. Reload the window and try again."
        : `The ${page} workspace loads from the components graph, and its source isn't in the library yet. Re-seed to restore it — no need to leave the page.`;

  return (
    <EmptyState
      icon={icon}
      title={`${page} page unavailable`}
      description={description}
      actions={
        status === "done" ? undefined : (
          <Button variant="primary" onClick={reseed} disabled={status === "seeding"}>
            {status === "seeding" ? "Re-seeding…" : "Re-seed component library"}
          </Button>
        )
      }
      style={{ padding: 48 }}
    />
  );
}
