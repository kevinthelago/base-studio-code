// The kit library's store reads, and the one distinction the reader they replace could not make:
// an index that could not be READ is not an index that is EMPTY
// (`the-kit-cluster-folds-into-bsc-ui`).
//
// The thing worth pinning is not that the read works. It is that nothing here can turn a failed read
// into a consumer count of zero — "no project uses this kit" is the input someone acts on to retire a
// kit, and a bridge that never answered must not be able to say it.
//
// Mocks `invoke`, NOT `@/shared/lib/core/bsc`, mirroring `paneIdentityRead.test.ts` and
// `rolePermsRead.test.ts`: that exercises the real bridge (so a change to how `bsc` propagates a
// non-zero exit is actually covered) and avoids replacing a module that is itself a record.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  readKitUsage, readKitDispatches, consumersOf, isUnread,
  type KitUsageIndex,
} from "@/features/designs/lib/kitStoreRead";

type BscPayload = { projectKey: unknown; args: string[] };

const callsFor = (noun: string): BscPayload[] =>
  vi.mocked(invoke).mock.calls
    .filter(([cmd, payload]) => cmd === "bsc" && (payload as BscPayload | undefined)?.args?.[1] === noun)
    .map(([, payload]) => payload as BscPayload);

const dispatch = (projectKey: string, changeId: string) => ({
  projectKey,
  kind: "notify",
  reason: "notify-only (default / non-breaking / not opted-in)",
  change: { id: changeId, kitId: "react-ui", component: "Button", class: "additive", summary: "Button extended" },
});

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

describe("the kit consumer index read", () => {
  it("asks the store ONCE and keeps only well-formed edges", async () => {
    vi.mocked(invoke).mockResolvedValue(
      JSON.stringify([
        { id: "proj-a>react-ui", projectKey: "proj-a", kitId: "react-ui" },
        { id: "proj-b>react-ui", projectKey: "proj-b", kitId: "react-ui" },
        { id: "junk", projectKey: "", kitId: "react-ui" },
      ]) as never,
    );
    const index = await readKitUsage();

    expect(callsFor("usage")).toHaveLength(1);
    expect(callsFor("usage")[0]).toEqual({ projectKey: null, args: ["ui", "usage", "list", "--json"] });
    expect(index?.edges).toEqual([
      { projectKey: "proj-a", kitId: "react-ui" },
      { projectKey: "proj-b", kitId: "react-ui" },
    ]);
  });

  it("resolves NULL when the read could not run, and that is not an empty index", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("no such subcommand `dispatch`") as never);
    await expect(readKitUsage()).resolves.toBeNull();
  });

  it("distinguishes a store that answered with NOTHING from a store that did not answer", async () => {
    vi.mocked(invoke).mockResolvedValue("[]" as never);
    const answered = await readKitUsage();
    expect(answered).toEqual({ edges: [] });
    expect(answered).not.toBeNull();
  });
});

describe("consumersOf — a zero count and an unknown count are different answers", () => {
  const index: KitUsageIndex = {
    edges: [
      { projectKey: "proj-b", kitId: "react-ui" },
      { projectKey: "proj-a", kitId: "react-ui" },
      { projectKey: "proj-c", kitId: "spring-kotlin" },
    ],
  };

  it("counts a kit's consumers from a resolved index, sorted for a stable render", () => {
    const view = consumersOf(index, "react-ui");
    expect(view.status).toBe("resolved");
    expect(view.count).toBe(2);
    expect(view.projects).toEqual(["proj-a", "proj-b"]);
    expect(isUnread(view)).toBe(false);
  });

  it("reports a REAL zero for a kit the index answered about and does not mention", () => {
    // The store spoke and no project consumes it — safe to act on.
    const view = consumersOf(index, "mobile-studio-code");
    expect(view.status).toBe("resolved");
    expect(view.count).toBe(0);
    expect(view.projects).toEqual([]);
    expect(isUnread(view)).toBe(false);
  });

  it("REFUSES to produce a count when the index could not be read — the retire-the-kit trap", () => {
    // THE POINT OF THE MODULE. An unreadable index must not read as "nobody uses this kit". `count` is
    // ABSENT rather than 0, so `count ?? 0` cannot be written by accident and a renderer has to branch.
    const view = consumersOf(null, "react-ui");
    expect(view.status).toBe("unread");
    expect(view.count).toBeUndefined();
    expect(view.projects).toBeUndefined();
    expect(isUnread(view)).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(view, "count")).toBe(false);
  });

  it("names the kit it was asked about in both answers, so a view carries its own subject", () => {
    expect(consumersOf(index, "react-ui").kitId).toBe("react-ui");
    expect(consumersOf(null, "react-ui").kitId).toBe("react-ui");
  });
});

describe("the kit dispatch queue read", () => {
  it("reads the durable queue from the store, dropping rows with no key", async () => {
    vi.mocked(invoke).mockResolvedValue(
      JSON.stringify([
        dispatch("proj-a", "react-ui:Button:2.0.0:additive"),
        { projectKey: "proj-b" }, // no change → no key
      ]) as never,
    );
    const queued = await readKitDispatches();

    expect(callsFor("dispatch")).toHaveLength(1);
    expect(callsFor("dispatch")[0]).toEqual({ projectKey: null, args: ["ui", "dispatch", "list", "--json"] });
    expect(queued).toHaveLength(1);
    expect(queued?.[0].projectKey).toBe("proj-a");
  });

  it("resolves NULL on an unreachable read rather than reporting an empty queue", async () => {
    // Same asymmetry as the index: "nothing is pending" is a conclusion, and a dead bridge has not
    // earned it. A caller keeps whatever it was already showing.
    vi.mocked(invoke).mockRejectedValue(new Error("bridge absent") as never);
    await expect(readKitDispatches()).resolves.toBeNull();
  });

  it("an EMPTY queue from a live store is an answer, not a failure", async () => {
    vi.mocked(invoke).mockResolvedValue("" as never);
    await expect(readKitDispatches()).resolves.toEqual([]);
  });
});
