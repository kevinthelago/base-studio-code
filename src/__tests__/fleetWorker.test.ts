import { describe, it, expect } from "vitest";
import { permissionRows, flowRows, paneCoords, TOOL_ORDER } from "../screens/planner/fleetWorker";
import type { AgentProfile } from "../screens/agents/agentProfiles";
import { DEFAULT_FLOW } from "../screens/planner/agentFlow";

const profile: AgentProfile = {
  id: "pf_x", name: "Build & test", color: "#fff", category: "generated", origin: "by planner",
  desc: "", mode: "ask", commands: [],
  tools: { read: "allow", grep: "allow", glob: "allow", edit: "allow", write: "allow", bash: "ask", web: "ask", task: "allow" },
  paths: { allow: ["src/**"], deny: ["**/.env"] }, net: { allow: ["crates.io"] }, builtin: false,
};

describe("fleetWorker mappers (#499)", () => {
  it("permissionRows reads every tool's posture from the profile, in display order", () => {
    const rows = permissionRows(profile);
    expect(rows.map(r => r.key)).toEqual(TOOL_ORDER);
    expect(rows.find(r => r.key === "bash")!.tier).toBe("ask");
    expect(rows.find(r => r.key === "write")!.tier).toBe("allow");
  });

  it("permissionRows is empty when there's no profile", () => {
    expect(permissionRows(undefined)).toEqual([]);
  });

  it("flowRows surfaces autonomy/push/trigger/gate with descriptions", () => {
    const rows = flowRows(DEFAULT_FLOW);
    expect(rows.map(r => r.key)).toEqual(["autonomy", "push", "trigger", "gate"]);
    expect(rows.find(r => r.key === "push")!.value).toBe("auto-pr");
    rows.forEach(r => expect(r.desc.length).toBeGreaterThan(0));
  });

  it("paneCoords parses a pane id into tab + pane indices", () => {
    expect(paneCoords("t2p3")).toEqual({ tab: 2, pane: 3 });
    expect(paneCoords("nope")).toBeNull();
  });
});
