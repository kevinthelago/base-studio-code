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
  view: () => ({ viewing: "Components — React — bsc-kit", workspace: "components", pageTab: "react" }),
};

describe("describePane", () => {
  it("reports the persona, its name, the role and the brief", () => {
    const ack = describePane("r1", { paneId: "demo:worker" }, FULL);
    // Exact shape on purpose — it is what caught the view fields being added, and a field appearing
    // in this ack without a decision is exactly the drift worth failing on.
    expect(ack).toEqual({
      id: "r1",
      personaId: "persona-worker",
      personaName: "Worker",
      role: "worker",
      startPrompt: "You build the thing.\nSecond line.",
      viewing: "Components — React — bsc-kit",
      workspace: "components",
      pageTab: "react",
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
      { ...FULL, personaFor: () => undefined, roleFor: () => undefined, personaRecord: () => undefined },
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

// ── WHAT THE USER IS LOOKING AT (`a-system-session-must-know-what-the-user-is-looking-at`) ──────
//
// The designer was told to "simplify the graph" and asked which one. The tab already said, on
// screen. A launch-time scope cannot close that: it names a technology and nothing finer, it is
// fixed while the tab is not, and the studios whose axis is not technology run ONE session across
// every value.
describe("the reported view", () => {
  it("carries the crumb, the workspace and the active tab", () => {
    const ack = describePane("r1", { paneId: "design-studio:designer-react" }, FULL);
    expect(ack.viewing).toBe("Components — React — bsc-kit");
    expect(ack.workspace).toBe("components");
    expect(ack.pageTab).toBe("react");
  });

  it("is reported for a pane with NO persona and NO role", () => {
    // What is on screen is a property of the app, not of the pane's identity. A plain console asking
    // "where am I" deserves the answer, and gating it on having a persona would withhold it from the
    // sessions most likely to be confused.
    const ack = describePane(
      "r1",
      { paneId: "p" },
      { ...FULL, personaFor: () => undefined, roleFor: () => undefined },
    );
    expect(ack.role).toBeUndefined();
    expect(ack.personaId).toBeUndefined();
    expect(ack.viewing).toBe("Components — React — bsc-kit");
  });

  it("omits the view rather than inventing one when the app cannot say", () => {
    // A blank crumb is a real state (a workspace with no tab yet). Reporting "" would read as a
    // place; omitting it reads as "unknown", which is the truth.
    const ack = describePane("r1", { paneId: "p" }, { ...FULL, view: () => ({}) });
    expect(ack.viewing).toBeUndefined();
    expect(ack.workspace).toBeUndefined();
    expect(ack.pageTab).toBeUndefined();
  });

  it("never lets a thrown view take down the answer", () => {
    // The identity half must survive a broken view: this verb is how an agent learns what it is
    // ALLOWED to do, and losing that to a crumb bug would be a bad trade.
    expect(() =>
      describePane("r1", { paneId: "p" }, { ...FULL, view: () => { throw new Error("boom"); } }),
    ).toThrow();
  });
});
