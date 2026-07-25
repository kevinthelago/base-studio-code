import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";

// Hoisted so the vi.mock factories (which run before imports) can reference them.
const h = vi.hoisted(() => ({
  announceMock: vi.fn(),
  coordState: { alerts: [] as { id: string; kind: string; text: string }[] },
}));

vi.mock("@/shared/lib/a11y/announcer", () => ({ announce: h.announceMock }));
vi.mock("@/shared/lib/fleet/useCoordLog", () => ({ useCoordLog: () => ({ state: h.coordState }) }));
vi.mock("@/features/tunnel", () => ({ coordAlerts: (s: typeof h.coordState) => s.alerts }));

import { useCoordAnnouncer } from "./useCoordAnnouncer";

const alerts = (...a: { id: string; kind: string; text: string }[]) => ({ alerts: a });

describe("useCoordAnnouncer (#3770)", () => {
  beforeEach(() => {
    h.announceMock.mockClear();
    h.coordState = { alerts: [] };
  });

  it("seeds the mount backlog SILENT, then announces only NEW events, deduped by id", () => {
    h.coordState = alerts({ id: "a1", kind: "agent-paused", text: "api-stream paused" });
    const { rerender } = renderHook(() => useCoordAnnouncer());
    expect(h.announceMock).not.toHaveBeenCalled(); // the backlog on mount is never spoken

    h.coordState = alerts(
      { id: "a1", kind: "agent-paused", text: "api-stream paused" },
      { id: "a2", kind: "fleet-landed", text: "ui landed a PR" },
    );
    rerender();
    expect(h.announceMock).toHaveBeenCalledTimes(1);
    expect(h.announceMock).toHaveBeenCalledWith("ui landed a PR", { assertive: false });

    rerender(); // unchanged set → nothing new to announce
    expect(h.announceMock).toHaveBeenCalledTimes(1);
  });

  it("announces a fleet-failed event assertively (it can't wait)", () => {
    const { rerender } = renderHook(() => useCoordAnnouncer()); // seed empty
    h.coordState = alerts({ id: "f1", kind: "fleet-failed", text: "a dependency chain failed" });
    rerender();
    expect(h.announceMock).toHaveBeenCalledWith("a dependency chain failed", { assertive: true });
  });
});
