// personaWhatamiBridge (#a-session-can-ask-what-it-is) — the pure decision behind `bsc persona whatami`.
//
// The point of the verb is that nothing has to GUESS what a session is. So the cases that matter are
// the partial ones: a pane with a role but no persona, a persona whose record has gone, a pane with
// neither. Each has a truthful answer, and none of them is an error.
import { describe, it, expect } from "vitest";
import { describePane, type WhatamiDeps } from "@/app/personaWhatamiBridge";

const FULL: WhatamiDeps = {
  personaFor: () => "persona-worker",
  roleFor: () => "worker",
  personaRecord: (id) =>
    id === "persona-worker"
      ? { name: "Worker", startPrompt: "You build the thing.\nSecond line." }
      : undefined,
};

describe("describePane", () => {
  it("reports the persona, its name, the role and the brief", () => {
    const ack = describePane("r1", { paneId: "demo:worker" }, FULL);
    expect(ack).toEqual({
      id: "r1",
      personaId: "persona-worker",
      personaName: "Worker",
      role: "worker",
      startPrompt: "You build the thing.\nSecond line.",
    });
    expect(ack.error).toBeUndefined();
  });

  it("a pane with a ROLE but no persona reports the role — the field that governs capability", () => {
    const ack = describePane("r1", { paneId: "p" }, { ...FULL, personaFor: () => undefined });
    expect(ack.role).toBe("worker");
    expect(ack.personaId).toBeUndefined();
    expect(ack.personaName).toBeUndefined();
    expect(ack.error, "a pane without a persona is a real state, not a failure").toBeUndefined();
  });

  it("a pane with NEITHER is described, not refused", () => {
    const ack = describePane(
      "r1",
      { paneId: "p" },
      { personaFor: () => undefined, roleFor: () => undefined, personaRecord: () => undefined },
    );
    expect(ack.error).toBeUndefined();
    expect(ack.role).toBeUndefined();
    expect(ack.personaId).toBeUndefined();
  });

  it("a dangling persona id keeps the id and invents no name", () => {
    // The assignment points at a record that is gone. Showing the id makes that visible; making up a
    // display name would smooth over exactly the breakage worth seeing.
    const ack = describePane("r1", { paneId: "p" }, { ...FULL, personaRecord: () => undefined });
    expect(ack.personaId).toBe("persona-worker");
    expect(ack.personaName).toBeUndefined();
  });

  it("refuses an empty pane id rather than describing a blank", () => {
    expect(describePane("r1", { paneId: "   " }, FULL).error).toContain("no pane id");
  });

  it("carries the request id back so a concurrent caller cannot be answered wrongly", () => {
    expect(describePane("req-42", { paneId: "p" }, FULL).id).toBe("req-42");
  });
});
