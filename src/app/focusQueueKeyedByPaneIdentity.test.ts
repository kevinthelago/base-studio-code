// THE FOCUS QUEUE IS KEYED BY PANE IDENTITY — the guard for `the-focus-queue-is-keyed-by-pane-identity`.
//
// THE REGRESSION THIS CLOSES. `project-fleet-panes-live-only-in-glance` took project panes out of the
// console tabs. The focus queue held `{ tab, pane }` console indices, and nothing fed it any more, so the
// two things that read it went quiet together: the tunnel's awaiting-input flag (the phone never marked a
// waiting agent) and the store projector's prompt-waiting alerts (none fired). Both were left empty on
// purpose, with a comment, until the queue could name a pane by identity.
//
// THE THREE CRITERIA, each driven through the REAL store rather than a fixture:
//   · an awaiting-input pane marks the phone again;
//   · prompt alerts fire for a pane with no console tab;
//   · nothing indexes panes by tab or cell.
// The last is a claim about SOURCE, and a behaviour test cannot see the absence of an index, so it reads
// the committed record store — the build authority — the way `storesAgree` and friends do.
import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "@/store";
import { awaitingIds, awaitingSessions } from "@/app/console/lib/focusQueue";
import { buildPanePayload } from "@/features/tunnel/lib/tunnel";
import { promptAlerts } from "@/features/tunnel/lib/alerts";
import { loadStore } from "@scripts/lib/recordStore.mjs";

const DIRECTOR = "politician-review:director";

function finishTurn(paneId: string) {
  const s = useAppStore.getState();
  s.setPaneStatus(paneId, "run");
  s.setPaneStatus(paneId, "idle");
}

describe("the focus queue is keyed by pane identity", () => {
  beforeEach(() => {
    useAppStore.setState({
      tabs: [],
      focusQueue: [],
      focusCursor: null,
      focusTarget: "director",
      paneStatus: {},
      paneRoles: { [DIRECTOR]: "director" } as never,
    });
  });

  it("a pane in NO console tab that finishes a turn is queued under its own id", () => {
    finishTurn(DIRECTOR);
    const st = useAppStore.getState();
    expect(st.tabs).toEqual([]);
    expect(st.focusQueue).toEqual([DIRECTOR]);
  });

  it("marks the phone: the tunnel payload reports that pane awaiting_input", () => {
    finishTurn(DIRECTOR);
    const st = useAppStore.getState();
    const roster = [{ id: DIRECTOR, name: "director" }];
    const { sessions } = buildPanePayload({
      panes: roster,
      paneCwds: {},
      paneStatuses: st.paneStatus,
      disabledPanes: {},
      awaiting: awaitingIds(st.focusQueue, roster.map((p) => p.id)),
      nowIso: "2026-09-15T00:00:00.000Z",
    });
    expect(sessions).toEqual([expect.objectContaining({ paneId: DIRECTOR, status: "awaiting_input" })]);
  });

  it("fires a prompt-waiting alert for that pane, named from the live session", () => {
    finishTurn(DIRECTOR);
    const awaiting = awaitingSessions(useAppStore.getState().focusQueue, [{ id: DIRECTOR, name: "director" }])
      .map((s) => ({ paneId: s.id, name: s.name }));
    const [alert] = promptAlerts([], awaiting, 7);
    expect(alert).toMatchObject({ kind: "prompt-waiting", paneId: DIRECTOR, text: "director is waiting for your input." });
  });

  it("answering the pane clears the mark: it runs again and leaves the queue", () => {
    finishTurn(DIRECTOR);
    useAppStore.getState().setPaneStatus(DIRECTOR, "run");
    expect(awaitingIds(useAppStore.getState().focusQueue, [DIRECTOR]).size).toBe(0);
  });
});

describe("nothing indexes a queued pane by tab or cell", () => {
  const records = new Map(
    ((loadStore("graph/algorithms.db") as { implementations?: { id?: string; code?: string }[] }).implementations ?? [])
      .map((r) => [r.id, r.code ?? ""]),
  );
  const code = (id: string) => {
    const c = records.get(id);
    expect(c, `record ${id} did not resolve from graph/algorithms.db`).toBeTruthy();
    return c as string;
  };

  it("the queue type is an identity id, not a { tab, pane } pair", () => {
    expect(code("focus-queue.ts")).toMatch(/export type QueuedPane = string;/);
    expect(code("focus-queue.ts")).not.toMatch(/tab:\s*number/);
  });

  it("the store resolves a queued pane's role by its id, never by a t{tab}p{pane} key", () => {
    expect(code("console.ts")).not.toMatch(/paneRoles\[`t\$\{/);
    expect(code("console.ts")).not.toContain("remapFocusQueue");
  });

  it("neither reader of the queue ships a stand-in empty set any more", () => {
    expect(code("use-tunnel-sync.ts")).not.toContain("NONE_AWAITING");
    expect(code("use-tunnel-sync.ts")).toContain("awaitingIds(focusQueue");
    expect(code("use-store-projector.ts")).not.toMatch(/const awaiting: AwaitingPane\[\] = \[\];/);
    expect(code("use-store-projector.ts")).toContain("awaitingSessions(focusQueue");
  });
});
