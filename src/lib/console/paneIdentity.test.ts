import { describe, it, expect } from "vitest";
import {
  paneIdFor, manualPaneId, fleetPaneId, directorPaneId, triagePaneId, isManualPaneId, positionalPaneId,
} from "./paneIdentity";

describe("paneIdentity (#1176)", () => {
  it("mints distinct id schemes", () => {
    expect(manualPaneId("tab-abc", 2)).toBe("man:tab-abc:p2");
    expect(fleetPaneId("payments", "checkout-stream")).toBe("payments:checkout-stream");
    expect(directorPaneId("payments")).toBe("payments:director");
    expect(triagePaneId("payments", "owner/web")).toBe("payments:owner/web:triage");
    expect(positionalPaneId(1, 0)).toBe("t1p0");
  });

  it("only manual ids count as manual (recovery exclusion)", () => {
    expect(isManualPaneId("man:tab-abc:p0")).toBe(true);
    expect(isManualPaneId("payments:checkout-stream")).toBe(false);
    expect(isManualPaneId("payments:owner/web:triage")).toBe(false);
    expect(isManualPaneId("t0p0")).toBe(false);
  });

  describe("paneIdFor", () => {
    it("a manual tab (no kind) with a stable id gets a per-tab man: id — NOT positional", () => {
      // The bug: two different tabs at the same grid index must NOT share an id.
      const tabA = { id: "tab-A" };
      const tabB = { id: "tab-B" };
      expect(paneIdFor(tabA, 0, 0)).toBe("man:tab-A:p0");
      expect(paneIdFor(tabB, 0, 0)).toBe("man:tab-B:p0"); // same index, different id ⇒ different pane
      expect(paneIdFor(tabA, 0, 0)).not.toBe(paneIdFor(tabB, 0, 0));
    });

    it("a fleet/triage tab keeps the positional id in Stage 1 (until paneIds are minted)", () => {
      expect(paneIdFor({ id: "x", kind: "build" }, 2, 1)).toBe("t2p1");
      expect(paneIdFor({ id: "x", kind: "triage" }, 0, 0)).toBe("t0p0");
    });

    it("a minted paneIds[idx] wins over everything (Stage 2)", () => {
      const tab = { id: "x", kind: "build" as const, paneIds: ["payments:checkout", "payments:director"] };
      expect(paneIdFor(tab, 3, 0)).toBe("payments:checkout");
      expect(paneIdFor(tab, 3, 1)).toBe("payments:director");
    });

    it("falls back to positional for an id-less legacy tab", () => {
      expect(paneIdFor({}, 1, 1)).toBe("t1p1");
      expect(paneIdFor(undefined, 0, 0)).toBe("t0p0");
    });
  });
});
