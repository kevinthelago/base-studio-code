import { describe, it, expect } from "vitest";
import { useAppStore } from "@/store";

// `pty_create` sets `$BSC_CHECKPOINT_DOC` only when the pane's checkpoint doc is non-empty, and
// `bsc-agent` writes its handoff there when a turn exhausts its step budget. If the doc does not
// survive a restart, a restored pane comes up with a cwd, a role, a model and a provider — and no
// checkpoint doc — so the handoff mechanism is silently INERT for exactly the long-running local
// sessions it exists for. Measured on a live director: 35 other BSC_* vars present, this one absent.
describe("the checkpoint doc survives a restart", () => {
  it("is included in what the store persists", () => {
    // Read the persisted projection the same way the store does, rather than asserting on a copy.
    const persisted = (useAppStore.persist?.getOptions?.().partialize?.(
      useAppStore.getState() as never,
    ) ?? {}) as Record<string, unknown>;
    expect(
      Object.prototype.hasOwnProperty.call(persisted, "paneCheckpointDocs"),
      "paneCheckpointDocs must persist — without it a restored pane cannot checkpoint",
    ).toBe(true);
  });

  it("persists alongside the other per-pane launch facts, not instead of them", () => {
    // The gap was that SOME per-pane facts survived and one did not, which is what made it invisible:
    // the pane looked correctly restored.
    const persisted = (useAppStore.persist?.getOptions?.().partialize?.(
      useAppStore.getState() as never,
    ) ?? {}) as Record<string, unknown>;
    for (const k of ["paneCwds", "paneRoles", "paneModels", "paneProviders", "paneCheckpointDocs"]) {
      expect(Object.prototype.hasOwnProperty.call(persisted, k), k).toBe(true);
    }
  });
});
