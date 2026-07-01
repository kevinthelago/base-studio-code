import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "@/store";

const PID = "prj_test";

beforeEach(() => useAppStore.setState({ planFleet: {}, pinnedContext: {} }));

describe("project pane store persistence", () => {
  it("togglePinnedContext adds then removes a file name", () => {
    useAppStore.getState().togglePinnedContext(PID, "CLAUDE.md");
    expect(useAppStore.getState().pinnedContext[PID]).toEqual(["CLAUDE.md"]);
    useAppStore.getState().togglePinnedContext(PID, "CLAUDE.md");
    expect(useAppStore.getState().pinnedContext[PID]).toEqual([]);
  });
});
