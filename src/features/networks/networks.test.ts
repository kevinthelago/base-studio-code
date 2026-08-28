// The networks slice — a write-through cache over `bsc network`.
//
// Every store action gets a test in the same branch (CLAUDE.md), and two of these pin decisions that
// are easy to "simplify" back into bugs: the id is frozen while the name is not, and a delete is
// REFUSED rather than cascaded.
import { describe, it, expect, beforeEach, vi } from "vitest";

// The bridge is the only Tauri-touching part, so it is the seam. `projectsByNetwork` is what makes a
// delete refusable; the rest are fire-and-forget write-throughs.
const pushed: unknown[] = [];
const dropped: string[] = [];
let projectRows: { key: string; network: string | null }[] = [];
let loaded: unknown[] | null = [];

vi.mock("@/features/networks/lib/networkBridge", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/networks/lib/networkBridge")>();
  return {
    ...real, // keep the REAL mintNetworkId — its collision rule is under test, not a stub
    loadNetworks: async () => loaded,
    pushNetwork: async (n: unknown) => { pushed.push(n); },
    dropNetwork: async (id: string) => { dropped.push(id); },
    projectsByNetwork: async () => projectRows,
  };
});

const { useAppStore } = await import("@/store");
const { mintNetworkId } = await import("@/features/networks/lib/networkBridge");

beforeEach(() => {
  pushed.length = 0;
  dropped.length = 0;
  projectRows = [];
  loaded = [];
  useAppStore.setState({ networks: [] });
});

describe("mintNetworkId", () => {
  it("mints `network-<slug>` and auto-disambiguates rather than refusing", () => {
    expect(mintNetworkId([], "Finance")).toBe("network-finance");
    expect(mintNetworkId([{ id: "network-finance" }], "Finance")).toBe("network-finance-2");
    expect(mintNetworkId([{ id: "network-finance" }, { id: "network-finance-2" }], "finance"))
      .toBe("network-finance-3");
  });

  it("produces only characters the session grammar and the filesystem accept", () => {
    // The id becomes a pane key (`network-<slug>:architect`) AND a directory name, and
    // `bsc_session::network_architect_slug` refuses anything outside [a-z0-9-]. A name that slugs to
    // nothing must still yield a usable id rather than a bare `network-`.
    for (const name of ["Cash & Flow", "  spaced  out  ", "../escape", "ÜNICODE", "!!!"]) {
      const id = mintNetworkId([], name);
      expect(id.startsWith("network-")).toBe(true);
      expect(id.slice("network-".length)).toMatch(/^[a-z0-9-]+$/);
    }
    expect(mintNetworkId([], "!!!")).toBe("network-network");
  });
});

describe("the networks slice", () => {
  it("adds a network, writes through, and orders it last", () => {
    const a = useAppStore.getState().addNetwork("kitchen");
    const b = useAppStore.getState().addNetwork("finance");
    const rows = useAppStore.getState().networks;
    expect(rows.map((n) => n.id)).toEqual([a, b]);
    expect(rows.map((n) => n.position)).toEqual([0, 1]);
    expect(pushed).toHaveLength(2);
  });

  it("renames the NAME and never the id", () => {
    // The id is frozen because the architect's pane id (`<id>:architect`) and its workspace directory
    // derive from it — renaming those would strand a running session.
    const id = useAppStore.getState().addNetwork("kitchen");
    useAppStore.getState().renameNetwork(id, "Kitchen Sink");
    const row = useAppStore.getState().networks[0];
    expect(row.id).toBe(id);
    expect(row.name).toBe("Kitchen Sink");
  });

  it("drops an empty rename rather than blanking the tab label", () => {
    const id = useAppStore.getState().addNetwork("kitchen");
    useAppStore.getState().renameNetwork(id, "   ");
    expect(useAppStore.getState().networks[0].name).toBe("kitchen");
  });

  it("REFUSES to delete a network that still has projects, and names them", async () => {
    // A network does not own its projects — membership is a column on each project row — so a delete
    // cannot cascade. Removing it anyway would leave those projects in `bsc project list` and in no
    // tab, which is the unrecoverable-looking failure this refusal exists to prevent.
    const id = useAppStore.getState().addNetwork("kitchen");
    projectRows = [{ key: "wan-relay", network: id }, { key: "ledger", network: null }];

    const res = await useAppStore.getState().removeNetwork(id);
    expect(res.ok).toBe(false);
    expect(res.blockedBy).toEqual(["wan-relay"]);
    expect(useAppStore.getState().networks).toHaveLength(1);
    expect(dropped).toEqual([]);
  });

  it("deletes an empty network and writes the removal through", async () => {
    const id = useAppStore.getState().addNetwork("kitchen");
    projectRows = [{ key: "ledger", network: null }];
    const res = await useAppStore.getState().removeNetwork(id);
    expect(res.ok).toBe(true);
    expect(useAppStore.getState().networks).toEqual([]);
    expect(dropped).toEqual([id]);
  });

  it("leaves what it has when the bridge is UNREACHABLE, rather than blanking the strip", async () => {
    // `loadNetworks` returns null for "could not ask" and [] for "genuinely none". Collapsing the two
    // would empty Glance's tab strip on any older bundled binary.
    useAppStore.getState().addNetwork("kitchen");
    loaded = null;
    await useAppStore.getState().hydrateNetworks();
    expect(useAppStore.getState().networks).toHaveLength(1);

    loaded = [];
    await useAppStore.getState().hydrateNetworks();
    expect(useAppStore.getState().networks).toHaveLength(0);
  });
});
