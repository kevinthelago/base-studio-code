import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { applyPushedPlanPush } from "./tunnelClient";
import type { CanonicalFile } from "@/features/planner";

// The mobile→desktop plan-push handler (#3248): apply the pushed files to the hub, then ack the
// outcome back to the phone. `invoke` is globally mocked (src/test/setup.ts).
describe("applyPushedPlanPush (#3248)", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  const files: CanonicalFile[] = [{ relpath: "goal.md", content: "the goal" }];

  it("applies the files, then acks applied:true on success", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    const applied = await applyPushedPlanPush("proj-1", files);
    expect(applied).toBe(true);
    expect(invoke).toHaveBeenCalledWith("apply_pushed_plan_files", { projectId: "proj-1", files });
    expect(invoke).toHaveBeenCalledWith("tunnel_ack_plan_push", { projectId: "proj-1", applied: true });
  });

  it("acks applied:FALSE when applying the files fails — so mobile still learns it was dropped", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "apply_pushed_plan_files") throw new Error("unsafe relpath — refused");
      return undefined; // the ack still goes through
    });
    const applied = await applyPushedPlanPush("proj-1", [{ relpath: "../escape.md", content: "x" }]);
    expect(applied).toBe(false);
    expect(invoke).toHaveBeenCalledWith("tunnel_ack_plan_push", { projectId: "proj-1", applied: false });
  });
});
