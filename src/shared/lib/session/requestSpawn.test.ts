import { describe, it, expect } from "vitest";
import { poolPaneId, poolNodeId, poolSlotFromNodeId, poolSlotFromPaneId } from "./requestSpawn";

// The spawn DECISION moved to poolPlan.ts (#3535, tested in poolPlan.test.ts); this file now only covers
// pool-slot identity — the pane/node ids and the inverse the Glance graph uses to open a slot.
describe("pool-slot identity (#3535)", () => {
  it("names a slot's pane under the full-capability debug-studio prefix", () => {
    expect(poolPaneId(0)).toBe("debug-studio:pool-0");
    expect(poolPaneId(7)).toBe("debug-studio:pool-7");
    // Under `debug-studio:` so isFullCapabilitySession matches it (#3520).
    expect(poolPaneId(3).startsWith("debug-studio:")).toBe(true);
  });

  it("names a slot's Glance node distinctly from its pane", () => {
    expect(poolNodeId(0)).toBe("debugger-pool-0");
    expect(poolNodeId(7)).toBe("debugger-pool-7");
    expect(poolNodeId(1)).not.toBe(poolPaneId(1));
  });

  it("resolves a node back to its slot, and rejects non-pool nodes", () => {
    expect(poolSlotFromNodeId("debugger-pool-0")).toBe(0);
    expect(poolSlotFromNodeId("debugger-pool-42")).toBe(42);
    expect(poolSlotFromNodeId(poolNodeId(5))).toBe(5); // round-trip
    expect(poolSlotFromNodeId("debugger")).toBeNull(); // the standing session node
    expect(poolSlotFromNodeId("designer")).toBeNull();
    expect(poolSlotFromNodeId("debugger-pool-x")).toBeNull(); // non-numeric
  });

  it("resolves a pane id back to its slot", () => {
    expect(poolSlotFromPaneId("debug-studio:pool-0")).toBe(0);
    expect(poolSlotFromPaneId(poolPaneId(9))).toBe(9); // round-trip
    expect(poolSlotFromPaneId("debug-studio:debugger")).toBeNull(); // the standing session pane
    expect(poolSlotFromPaneId("proj:auth")).toBeNull();
  });
});
