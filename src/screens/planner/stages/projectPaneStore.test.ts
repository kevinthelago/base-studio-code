import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "../../../store";
import { emptyFleet } from "./planSections";
import type { AgentStream } from "./planSections";

const PID = "prj_test";

function stream(over: Partial<AgentStream> = {}): AgentStream {
  return { id: "s1", name: "@s1", repo: "o/r", owns: [], issues: [], dependsOn: [], ...over };
}

beforeEach(() => useAppStore.setState({ planFleet: {}, pinnedContext: {} }));

describe("project pane store persistence", () => {
  it("setPlanAgentStreamPerm persists the perm and marks the preset custom", () => {
    useAppStore.getState().setPlanFleet(PID, { ...emptyFleet(), streams: [stream({ preset: "Build" })] });
    const perm = { read: "allow", edit: "deny", create: "deny", run: "ask", net: "deny", push: "deny", pkg: "deny" } as const;
    useAppStore.getState().setPlanAgentStreamPerm(PID, "s1", perm);
    const s = useAppStore.getState().planFleet[PID].streams[0];
    expect(s.perm).toEqual(perm);
    expect(s.preset).toBe("custom");
  });

  it("setPlanAgentStreamPreset persists both preset and perm", () => {
    useAppStore.getState().setPlanFleet(PID, { ...emptyFleet(), streams: [stream()] });
    const perm = { read: "allow", edit: "allow", create: "allow", run: "allow", net: "ask", push: "ask", pkg: "ask" } as const;
    useAppStore.getState().setPlanAgentStreamPreset(PID, "s1", "Build", perm);
    const s = useAppStore.getState().planFleet[PID].streams[0];
    expect(s.preset).toBe("Build");
    expect(s.perm).toEqual(perm);
  });

  it("perm/preset actions are no-ops when the project has no fleet", () => {
    const perm = { read: "allow" } as Record<string, "allow" | "ask" | "deny">;
    useAppStore.getState().setPlanAgentStreamPerm("missing", "s1", perm);
    expect(useAppStore.getState().planFleet["missing"]).toBeUndefined();
  });

  it("togglePinnedContext adds then removes a file name", () => {
    useAppStore.getState().togglePinnedContext(PID, "CLAUDE.md");
    expect(useAppStore.getState().pinnedContext[PID]).toEqual(["CLAUDE.md"]);
    useAppStore.getState().togglePinnedContext(PID, "CLAUDE.md");
    expect(useAppStore.getState().pinnedContext[PID]).toEqual([]);
  });
});
