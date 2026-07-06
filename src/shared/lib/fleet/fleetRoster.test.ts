import { describe, it, expect, vi, beforeEach } from "vitest";
import { recordFleetSessions } from "./fleetRoster";
import { bscWrite } from "@/shared/lib/core/bsc";

vi.mock("@/shared/lib/core/bsc", () => ({ bscWrite: vi.fn(() => Promise.resolve()) }));

describe("recordFleetSessions (#2405)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("records each launched agent in the durable ledger with role + stream from the roster row", () => {
    recordFleetSessions("proj", [
      ["proj:director", "director", "-", "-", "director"].join("\t"),
      ["proj:auth", "auth", "org/app", "auth", "worker"].join("\t"),
    ]);
    expect(bscWrite).toHaveBeenCalledTimes(2);
    // Director: the "director" stream column collapses to an empty streamId.
    expect(bscWrite).toHaveBeenCalledWith("proj", ["plan", "fleet", "session", "set"],
      { paneId: "proj:director", streamId: "", role: "director", status: "running" });
    // Worker: carries its real stream id.
    expect(bscWrite).toHaveBeenCalledWith("proj", ["plan", "fleet", "session", "set"],
      { paneId: "proj:auth", streamId: "auth", role: "worker", status: "running" });
  });

  it("skips a blank / malformed row (no pane id) — never writes a keyless session", () => {
    recordFleetSessions("proj", ["", "\t\t\t\t"]);
    expect(bscWrite).not.toHaveBeenCalled();
  });
});
