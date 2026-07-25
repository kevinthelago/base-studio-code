// GraphPageFallback (#3648/#3652, epic #3604) — the shared fallback for a graph-hosted page (Fleet /
// Automations / Security / GitHub …) whose source isn't loadable from the components graph. It offers TWO
// in-app recoveries, because the two failure modes need DIFFERENT fixes:
//
//   • "Reload to apply" — `window.location.reload()`. A JUST-MERGED/updated page brings NEW platform-module
//     registrations (appModules + register<X>Platform — BOOT-bound + guarded) and a NEW `SEED_COMPONENTS`
//     glob entry (`import.meta.glob` resolves at module-eval). Neither can be applied mid-session by a
//     re-seed — only a fresh boot re-runs registration + re-globs the seed + re-hydrates. This reload does
//     exactly that, so it reliably applies a new/updated page live without hunting for F5. (#3652)
//
//   • "Re-seed in place" — `hydrateComponents()` reconciles the store toward the packaged seed and pushes
//     missing built-ins. Fixes the lighter case where the library only LOST this page's record but its
//     platform is already live (the common shipped-app case). GraphComponent subscribes to the page's
//     srcText, so a successful re-seed makes the source appear and the host re-renders into the real page.
import { useState, type ReactNode } from "react";
import { useAppStore } from "@/store";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";
import { Button } from "@/shared/ui/controls/Button";

export function GraphPageFallback({ page, icon = "⑃" }: { page: string; icon?: ReactNode }) {
  const hydrateComponents = useAppStore((s) => s.hydrateComponents);
  const [status, setStatus] = useState<"idle" | "seeding" | "seeded" | "error">("idle");

  async function reseed() {
    setStatus("seeding");
    try {
      // If the record seeds AND its platform is already registered, GraphComponent re-renders into the page
      // and this unmounts. If it's still here after, the page was just added/updated → Reload to apply.
      await hydrateComponents();
      setStatus("seeded");
    } catch {
      setStatus("error");
    }
  }

  const description =
    status === "seeded"
      ? `Re-seeded the library in place. If ${page} is still blank it was just added or updated — use Reload to apply it.`
      : status === "error"
        ? "Re-seed failed. Use Reload to apply the latest."
        : `${page} loads from the components graph. If ${page} was just added or updated, Reload to apply it; if the library only lost its record, Re-seed restores it in place.`;

  return (
    <EmptyState
      icon={icon}
      title={`${page} page unavailable`}
      description={description}
      actions={
        <>
          <Button variant="primary" onClick={() => window.location.reload()}>Reload to apply</Button>
          <Button onClick={reseed} disabled={status === "seeding"}>
            {status === "seeding" ? "Re-seeding…" : "Re-seed in place"}
          </Button>
        </>
      }
      style={{ padding: 48 }}
    />
  );
}
