import { describe, it, expect } from "vitest";
import {
  paneIdFor, manualPaneId, fleetPaneId, directorPaneId, triagePaneId, isManualPaneId, positionalPaneId,
  parsePaneIdentity, paneBelongsToTab, findPaneOwnerTab, paneCwdRecovery, sandboxUserIdentity,
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

  describe("paneBelongsToTab — identity-aware ownership (the inverse of paneIdFor)", () => {
    it("matches a manual tab by its stable id, not by index", () => {
      const tab = { id: "tab-A" };
      expect(paneBelongsToTab("man:tab-A:p0", tab, 0)).toBe(true);
      expect(paneBelongsToTab("man:tab-A:p3", tab, 7)).toBe(true); // index is irrelevant for man:
      expect(paneBelongsToTab("man:tab-B:p0", tab, 0)).toBe(false); // different tab id
    });

    it("matches a minted fleet/triage id only via the tab's paneIds[]", () => {
      const tab = { id: "x", kind: "build" as const, paneIds: ["proj:director", "proj:auth"] };
      expect(paneBelongsToTab("proj:auth", tab, 0)).toBe(true);
      expect(paneBelongsToTab("proj:director", tab, 5)).toBe(true);
      expect(paneBelongsToTab("proj:other", tab, 0)).toBe(false);
    });

    it("matches a legacy positional id by tab index", () => {
      expect(paneBelongsToTab("t2p1", {}, 2)).toBe(true);
      expect(paneBelongsToTab("t2p1", {}, 3)).toBe(false);
    });

    it("rejects an unrecognized key", () => {
      expect(paneBelongsToTab("apply_tag", { id: "tab-A" }, 0)).toBe(false);
    });
  });

  describe("findPaneOwnerTab — resolve a pane id to its tab", () => {
    const tabs = [
      { id: "manual-1" },                                              // 0: manual
      { id: "x", kind: "build" as const, paneIds: ["p:director", "p:auth"] }, // 1: fleet (minted)
      { id: "y" },                                                     // 2: manual
    ];
    it("resolves a manual id to its tab regardless of index drift", () => {
      expect(findPaneOwnerTab(tabs, "man:y:p0")).toEqual({ tab: tabs[2], tabIdx: 2 });
    });
    it("resolves a minted fleet id to its tab", () => {
      expect(findPaneOwnerTab(tabs, "p:auth")).toEqual({ tab: tabs[1], tabIdx: 1 });
    });
    it("returns null for an id no tab owns", () => {
      expect(findPaneOwnerTab(tabs, "man:gone:p0")).toBeNull();
      expect(findPaneOwnerTab(tabs, "p:missing")).toBeNull();
    });
  });

  describe("parsePaneIdentity — recover meaning from the name alone (#1266)", () => {
    it("classifies each id kind with its parts", () => {
      expect(parsePaneIdentity("man:tab-abc:p2")).toEqual({ kind: "manual", raw: "man:tab-abc:p2", tabId: "tab-abc", paneIdx: 2 });
      expect(parsePaneIdentity("t1p0")).toEqual({ kind: "positional", raw: "t1p0", tabIdx: 1, paneIdx: 0 });
      expect(parsePaneIdentity("payments:director")).toEqual({ kind: "director", raw: "payments:director", projectKey: "payments" });
      expect(parsePaneIdentity("payments:checkout-stream")).toEqual({ kind: "worker", raw: "payments:checkout-stream", projectKey: "payments", streamId: "checkout-stream" });
      expect(parsePaneIdentity("payments:owner/web:triage")).toEqual({ kind: "triage", raw: "payments:owner/web:triage", projectKey: "payments", repo: "owner/web" });
    });

    it("round-trips every minting helper (mint → parse recovers the inputs)", () => {
      const dir = parsePaneIdentity(directorPaneId("my-proj"));
      expect(dir).toMatchObject({ kind: "director", projectKey: "my-proj" });

      const worker = parsePaneIdentity(fleetPaneId("my-proj", "auth-ui-v2"));
      expect(worker).toMatchObject({ kind: "worker", projectKey: "my-proj", streamId: "auth-ui-v2" });

      const triage = parsePaneIdentity(triagePaneId("my-proj", "owner/my-web"));
      expect(triage).toMatchObject({ kind: "triage", projectKey: "my-proj", repo: "owner/my-web" });

      const manual = parsePaneIdentity(manualPaneId("tab-xyz", 3));
      expect(manual).toMatchObject({ kind: "manual", tabId: "tab-xyz", paneIdx: 3 });

      const pos = parsePaneIdentity(positionalPaneId(4, 2));
      expect(pos).toMatchObject({ kind: "positional", tabIdx: 4, paneIdx: 2 });
    });

    it("keeps hyphens inside keys, stream ids, and repos (split is on the FIRST colon only)", () => {
      expect(parsePaneIdentity("my-proj:auth-ui")).toMatchObject({ projectKey: "my-proj", streamId: "auth-ui" });
      expect(parsePaneIdentity("my-proj:owner/my-web:triage")).toMatchObject({ projectKey: "my-proj", repo: "owner/my-web" });
    });

    it("returns null for an unrecognized or malformed id", () => {
      expect(parsePaneIdentity("")).toBeNull();
      expect(parsePaneIdentity("garbage")).toBeNull();   // no colon, not positional/manual
      expect(parsePaneIdentity("key:")).toBeNull();      // empty stream id
      expect(parsePaneIdentity(":director")).toBeNull(); // empty project key
    });
  });

  describe("paneCwdRecovery (#1819 empty-cwd recovery)", () => {
    it("resolves a triage pane to repo_dir_path", () => {
      expect(paneCwdRecovery("STEM:owner/STEM:triage")).toEqual({
        cmd: "repo_dir_path", args: { projectKey: "STEM", repo: "owner/STEM" },
      });
    });
    it("resolves a director pane to project_dir_path", () => {
      expect(paneCwdRecovery("STEM:director")).toEqual({ cmd: "project_dir_path", args: { projectKey: "STEM" } });
    });
    it("returns null where the dir isn't derivable from the id alone", () => {
      expect(paneCwdRecovery("STEM:backend")).toBeNull();  // worker — its worktree needs the agent id
      expect(paneCwdRecovery("man:tab-1:p0")).toBeNull();   // manual console
      expect(paneCwdRecovery("t0p1")).toBeNull();           // legacy positional
    });
  });

  describe("sandboxUserIdentity (#1994 per-agent user activation)", () => {
    const D = "bsc-agent-sandbox";
    it("a SANDBOXED worker pane provisions its own user, keyed off the stable pane identity", () => {
      // The worker's `<key>:<streamId>` id IS the identity threaded to ensure_sandbox_user, so a
      // relaunch re-derives + reuses the same Linux user + 700 home.
      expect(sandboxUserIdentity("payments:checkout-stream", D)).toBe("payments:checkout-stream");
      // Deterministic: the same pane always yields the same identity.
      expect(sandboxUserIdentity("payments:checkout-stream", D)).toBe(sandboxUserIdentity("payments:checkout-stream", D));
      // Distinct workers ⇒ distinct identities ⇒ distinct users (isolation).
      expect(sandboxUserIdentity("payments:auth-ui", D)).not.toBe(sandboxUserIdentity("payments:checkout-stream", D));
    });
    it("the DIRECTOR gets its own user too, isolated from every worker (#4260)", () => {
      // The issue's requirement is that worker↔director be isolated by the OS, not just by the
      // bsc-scope write hook. The director loses nothing: its cwd is the hub, which lives in the
      // group-shared base every agent user can reach, not inside anyone's private home.
      expect(sandboxUserIdentity("payments:director", D)).toBe("payments:director");
      expect(sandboxUserIdentity("payments:director", D)).not.toBe(sandboxUserIdentity("payments:checkout-stream", D));
      // Per project — two projects' directors are different agents, so different users.
      expect(sandboxUserIdentity("payments:director", D)).not.toBe(sandboxUserIdentity("billing:director", D));
    });
    it("non-fleet sandboxed panes (triage / manual / planner / positional) keep the shared user", () => {
      expect(sandboxUserIdentity("payments:owner/web:triage", D)).toBeNull();
      expect(sandboxUserIdentity("man:tab-1:p0", D)).toBeNull();
      expect(sandboxUserIdentity("planning_payments", D)).toBeNull();
      expect(sandboxUserIdentity("t0p1", D)).toBeNull();
    });
    it("a NON-sandboxed pane never provisions a user — byte-identical to today's launch", () => {
      // No distro ⇒ null regardless of role (the `-u` arg is never passed off the sandbox path).
      expect(sandboxUserIdentity("payments:checkout-stream", undefined)).toBeNull();
      expect(sandboxUserIdentity("payments:checkout-stream", "")).toBeNull();
      expect(sandboxUserIdentity("payments:director", undefined)).toBeNull();
    });
  });
});
