// #architect-wires-project-relationships — Glance re-reads the contracts when it mounts.
//
// `projectLinks` is a write-through cache whose only authoritative read used to be boot, which was
// correct while the app was the sole writer of `project-links.json`. The architect now edits contracts
// through `bsc project link` from its own session, and that write has no route back into zustand — so
// without a re-read, a relationship the user just asked the architect for stays invisible until the app
// restarts. That failure mode is the reason this test exists: it does not look like a stale view, it
// looks like the command did nothing.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { useAppStore } from "@/store";
import * as bridge from "./lib/projectLinksBridge";
import type { ProjectLink } from "./lib/projectLinks";

// Same viewport stub the other GlanceWorkspace tests use — jsdom does no layout measurement.
vi.mock("@/shared/ui/layouts/useGraphViewport", async (orig) => {
  const actual = await orig<typeof import("@/shared/ui/layouts/useGraphViewport")>();
  return {
    ...actual,
    useGraphViewport: () => ({
      view: { tx: 0, ty: 0, scale: 1 },
      setVp: () => {}, onCanvasDown: () => {}, fit: () => {}, centerOn: () => {},
      zoomBy: () => {}, zoomTo: () => {}, zoomToCentered: () => {},
      dragMoved: { current: false }, worldTransform: {},
    }),
  };
});

import { GlanceWorkspace } from "./GlanceWorkspace";

/** A contract the ARCHITECT wrote from its session — present in the store, absent from the cache. */
const authored: ProjectLink[] = [{ id: "app>billing:api", from: "app", to: "billing", kind: "api" }];

describe("Glance re-reads the project relationships on mount (#architect-wires-project-relationships)", () => {
  beforeEach(() => {
    useAppStore.setState({
      localDraftProjects: {
        app: { title: "App", pitch: "", createdAt: 1 },
        billing: { title: "Billing", pitch: "", createdAt: 1 },
      },
      triagedProjects: { app: 1, billing: 1 },
      // The stale cache: the app has never seen the contract the architect just wrote.
      projectLinks: [], githubToken: "", githubState: null, glanceDrill: null, tabs: [], bscBaseDir: "/base",
    });
  });

  it("picks up a contract written outside the app, without a restart", async () => {
    const load = vi.spyOn(bridge, "loadProjectLinks").mockResolvedValue(authored);
    render(<GlanceWorkspace />);
    expect(load).toHaveBeenCalled();
    await waitFor(() => expect(useAppStore.getState().projectLinks).toEqual(authored));
  });

  it("keeps the cached contracts when the bridge is unreachable", async () => {
    // A `null` load means "could not read", NOT "there are none" — blanking the network on a transient
    // CLI failure would erase every relationship the user can see. Pinned here as well as in the slice
    // test because THIS is the path that now runs on every Glance open rather than once per boot.
    useAppStore.setState({ projectLinks: authored });
    vi.spyOn(bridge, "loadProjectLinks").mockResolvedValue(null);
    render(<GlanceWorkspace />);
    await waitFor(() => expect(useAppStore.getState().projectLinks).toEqual(authored));
  });
});
