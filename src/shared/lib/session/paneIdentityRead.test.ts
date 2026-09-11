// A pane's wiring is derived in Rust, and the ways it can FAIL stay distinguishable
// (`frontend-state-3b-pane-wiring-readers-derive-from-rust`).
//
// The thing worth pinning is not that the read works — it is that nothing here can turn a pane the
// resolver refused, a pane id that names nothing, or a read that never ran into a role. Every reader this
// module replaces wrote `paneRoles[pane] ?? "worker"`, and that default is the fault `frontend-state-2c`
// and `2d` each had to undo after it broke real panes.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  readPaneIdentities, resolvedIdentity, isResolved, paneRoleMap, paneProfileMap,
  type PaneIdentityView, type ResolvedPaneIdentity,
} from "@/shared/lib/session/paneIdentityRead";

type BscPayload = { projectKey: unknown; args: string[] };

const identityCalls = (): BscPayload[] =>
  vi.mocked(invoke).mock.calls
    .filter(([cmd, payload]) => cmd === "bsc" && (payload as BscPayload | undefined)?.args?.[1] === "identity")
    .map(([, payload]) => payload as BscPayload);

/** A resolved identity with the fields a reader actually looks at. */
const identity = (over: Partial<ResolvedPaneIdentity> = {}): ResolvedPaneIdentity => ({
  paneId: "proj:api", kind: "worker", role: "worker", profile: "gen_stream_api",
  roleGlobs: [], harness: "claude", cwd: "/wt/proj/app--api", continueSession: true, ...over,
});

function reply(rows: PaneIdentityView[]): void {
  vi.mocked(invoke).mockResolvedValue(JSON.stringify(rows) as never);
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

describe("the pane identity read", () => {
  it("asks Rust ONCE for the whole list, deduped, and keys the answer by pane", async () => {
    reply([
      { paneId: "proj:api", status: "resolved", identity: identity() },
      { paneId: "proj:ui", status: "resolved", identity: identity({ paneId: "proj:ui", streamId: "ui" }) },
    ]);
    const got = await readPaneIdentities(["proj:api", "proj:ui", "proj:api", ""]);

    expect(identityCalls()).toHaveLength(1);
    expect(identityCalls()[0]).toEqual({
      projectKey: null,
      args: ["session", "identity", "proj:api", "proj:ui", "--json"],
    });
    expect(got?.get("proj:api")?.status).toBe("resolved");
    expect(got?.size).toBe(2);
  });

  it("does not turn a REFUSED pane into a role", async () => {
    reply([{ paneId: "proj:ghost", status: "refused", reason: "persona `persona-missing` is not in the persona library" }]);
    const got = await readPaneIdentities(["proj:ghost"]);
    const view = got?.get("proj:ghost");

    expect(view?.status).toBe("refused");
    expect(resolvedIdentity(view)).toBeNull();
    expect(isResolved(view)).toBe(false);
    // The maps the pure audit/security helpers take must simply not mention it.
    expect(paneRoleMap(got!)).toEqual({});
    expect(paneProfileMap(got!)).toEqual({});
    expect(paneRoleMap(got!)["proj:ghost"]).toBeUndefined();
  });

  it("keeps an UNKNOWN pane id distinct from a refusal, and still yields no role", async () => {
    reply([
      { paneId: "nonsense", status: "unknown", reason: "this pane id matches no grammar the app launches" },
      { paneId: "proj:ghost", status: "refused", reason: "persona `persona-missing` is not in the persona library" },
    ]);
    const got = await readPaneIdentities(["nonsense", "proj:ghost"]);

    expect(got?.get("nonsense")?.status).toBe("unknown");
    expect(got?.get("proj:ghost")?.status).toBe("refused");
    expect(got?.get("nonsense")?.status).not.toBe(got?.get("proj:ghost")?.status);
    expect(paneRoleMap(got!)).toEqual({});
  });

  it("treats a pane absent from the answer as no role rather than a default", async () => {
    reply([{ paneId: "proj:api", status: "resolved", identity: identity() }]);
    const got = await readPaneIdentities(["proj:api", "proj:never-mentioned"]);

    expect(resolvedIdentity(got?.get("proj:never-mentioned"))).toBeNull();
    expect(isResolved(got?.get("proj:never-mentioned"))).toBe(false);
    expect(paneRoleMap(got!)).toEqual({ "proj:api": "worker" });
  });

  it("resolves a pane with NO persona — an absent persona is a value, not a failure", async () => {
    reply([{ paneId: "proj:api", status: "resolved", identity: identity({ persona: undefined, streamId: "api" }) }]);
    const got = await readPaneIdentities(["proj:api"]);
    const id = resolvedIdentity(got?.get("proj:api"));

    expect(id).not.toBeNull();
    expect(id?.persona).toBeUndefined();
    expect(id?.role).toBe("worker");
    expect(id?.cwd).toBe("/wt/proj/app--api");
    expect(paneRoleMap(got!)).toEqual({ "proj:api": "worker" });
  });

  it("keeps `no profile` as a state: the pane resolves, and no profile is invented for it", async () => {
    reply([{
      paneId: "design-studio:designer-react",
      status: "resolved",
      identity: identity({ paneId: "design-studio:designer-react", kind: "studio", role: "designer", profile: null }),
    }]);
    const got = await readPaneIdentities(["design-studio:designer-react"]);

    expect(isResolved(got?.get("design-studio:designer-react"))).toBe(true);
    expect(resolvedIdentity(got?.get("design-studio:designer-react"))?.profile).toBeNull();
    // Absent from the profile map — a confined session stays confined by having no profile, and there is
    // no library row to find. Its ROLE is still known, which is what gates it.
    expect(paneProfileMap(got!)).toEqual({});
    expect(paneRoleMap(got!)).toEqual({ "design-studio:designer-react": "designer" });
  });

  it("says the READ failed with null, rather than reporting that every pane refused", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("no bsc binary") as never);
    expect(await readPaneIdentities(["proj:api"])).toBeNull();
  });

  it("answers an empty request with an empty map and asks Rust nothing", async () => {
    const got = await readPaneIdentities([]);
    expect(got).not.toBeNull();
    expect(got?.size).toBe(0);
    expect(identityCalls()).toHaveLength(0);
  });

  it("carries the notes that say what DEGRADED", async () => {
    reply([{
      paneId: "proj:api",
      status: "resolved",
      identity: identity(),
      notes: ["the profile chosen for this pane, `api-dev`, is not in the profile library — dropped"],
    }]);
    const got = await readPaneIdentities(["proj:api"]);
    expect(got?.get("proj:api")?.notes?.[0]).toContain("api-dev");
  });
});
