import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ReactNode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { useAppStore } from "@/store";
import { GraphComponent } from "./GraphComponent";
import { resetLastGood } from "./renderGate";
import { resetGraphCompiles } from "./GraphComponent";

// The loader is mocked: compiling real source needs esbuild, and what this file is about is the GATE —
// which version gets mounted when a compile or a render fails — not the compiler.
const load = vi.hoisted(() => vi.fn());
vi.mock("./componentLoader", () => ({ loadComponentFromSource: load }));
vi.mock("./graphResolver", () => ({ resolveGraphSource: () => null }));

const GOOD = "export default () => 'GOOD';";
const NEXT = "export default () => 'NEXT';";

/** Point the store's record at `srcText`. */
function setSource(srcText: string) {
  useAppStore.setState({ components: [{ id: "x", srcText }] as never });
}

/** A record whose CURRENT source is `srcText` and whose change history retained `prevSrcs` (oldest-first,
 *  as the store holds it) — the on-disk shape a fresh boot reads after a designer edit. */
function setSourceWithHistory(srcText: string, prevSrcs: string[]) {
  useAppStore.setState({
    components: [
      {
        id: "x",
        srcText,
        history: prevSrcs.map((prevSrc, i) => ({
          rev: i + 2,
          at: "2026-08-14T01:39:00Z",
          by: "designer",
          changed: ["srcText"],
          prevSrc,
        })),
      },
    ] as never,
  });
}

describe("GraphComponent render gate (#graph-render-gate)", () => {
  beforeEach(() => {
    resetLastGood();
    resetGraphCompiles();
    load.mockReset();
    useAppStore.setState({ components: [] as never });
  });

  it("mounts the component and remembers it as the last version that WORKED", async () => {
    load.mockResolvedValue(() => <div>good</div>);
    setSource(GOOD);
    render(<GraphComponent id="x" fallback={<div>fallback</div>} />);
    expect(await screen.findByText("good")).toBeTruthy();
  });

  it("falls back to the last WORKING version when the new source fails to COMPILE", async () => {
    // 1) a version that works — this is what the gate must remember
    load.mockResolvedValueOnce(() => <div>good</div>);
    setSource(GOOD);
    const view = render(<GraphComponent id="x" fallback={<div>fallback</div>} />);
    expect(await screen.findByText("good")).toBeTruthy();

    // 2) the record is edited to something that will not compile
    load.mockRejectedValueOnce(new Error("Unexpected token"));
    setSource(NEXT);
    view.rerender(<GraphComponent id="x" fallback={<div>fallback</div>} />);

    // the previous working version is mounted — NOT the empty fallback
    await waitFor(() => expect(screen.getByText("good")).toBeTruthy());
    expect(screen.queryByText("fallback")).toBeNull();
  });

  it("shows the caller's fallback when a compile fails and NOTHING has worked yet", async () => {
    // No known-good version ⇒ unchanged behaviour. The gate must never invent a component.
    load.mockRejectedValue(new Error("Unexpected token"));
    setSource(NEXT);
    render(<GraphComponent id="x" fallback={<div>fallback</div>} />);
    expect(await screen.findByText("fallback")).toBeTruthy();
  });

  it("does not mark a version good just because a FALLBACK rendered under it", async () => {
    // The trap: after a degraded mount the good component is on screen while the store still holds the
    // BROKEN source. If the marking effect keyed on the record's source it would file the broken one as
    // good, and the next failure would have nothing to fall back to.
    load.mockResolvedValueOnce(() => <div>good</div>);
    setSource(GOOD);
    const view = render(<GraphComponent id="x" fallback={<div>fallback</div>} />);
    expect(await screen.findByText("good")).toBeTruthy();

    load.mockRejectedValueOnce(new Error("boom"));
    setSource(NEXT);
    view.rerender(<GraphComponent id="x" fallback={<div>fallback</div>} />);
    await waitFor(() => expect(screen.getByText("good")).toBeTruthy());

    // a THIRD source also fails — the good version must still be the one from step 1
    load.mockRejectedValueOnce(new Error("boom again"));
    setSource("export default () => 'THIRD';");
    view.rerender(<GraphComponent id="x" fallback={<div>fallback</div>} />);
    await waitFor(() => expect(screen.getByText("good")).toBeTruthy());
  });
});

describe("durable fallback — the record's retained history", () => {
  beforeEach(() => {
    resetLastGood();
    resetGraphCompiles();
    load.mockReset();
    useAppStore.setState({ components: [] as never });
  });

  it("mounts a retained earlier version on a FRESH BOOT, where lastGood is empty", async () => {
    // THE incident. A designer rewrote five rendering-critical records at 01:39; the app was restarted;
    // on the fresh boot the first version the gate ever saw of each was the broken one. `lastGood` is
    // per-session and therefore empty here — which is precisely when it is needed — so the only rung
    // left is the source the write itself retained.
    load.mockRejectedValueOnce(new Error("Unexpected token"));
    load.mockResolvedValueOnce(() => <div>good</div>);
    setSourceWithHistory(NEXT, [GOOD]);
    render(<GraphComponent id="x" fallback={<div>fallback</div>} />);
    expect(await screen.findByText("good")).toBeTruthy();
    expect(screen.queryByText("fallback")).toBeNull();
  });

  it("walks PAST a rung that is also broken", async () => {
    // A designer working around breakage writes several bad versions in a row — the incident's own notes
    // read "bypass both broken …". Stopping at the first rung would strand the app on another failure.
    load.mockRejectedValueOnce(new Error("current is broken"));
    load.mockRejectedValueOnce(new Error("and so is the rung before it"));
    load.mockResolvedValueOnce(() => <div>good</div>);
    setSourceWithHistory("export default () => 'THIRD';", [GOOD, NEXT]);
    render(<GraphComponent id="x" fallback={<div>fallback</div>} />);
    expect(await screen.findByText("good")).toBeTruthy();
  });

  it("prefers the in-session lastGood over the history, and never compiles a rung it does not need", async () => {
    // `lastGood` is already BUILT and is a stronger claim besides — it RENDERED, where a rung has only
    // ever compiled. Reaching for the history first would spend a compile to reach a weaker answer.
    load.mockResolvedValueOnce(() => <div>good</div>);
    setSource(GOOD);
    const view = render(<GraphComponent id="x" fallback={<div>fallback</div>} />);
    expect(await screen.findByText("good")).toBeTruthy();

    load.mockRejectedValueOnce(new Error("boom"));
    setSourceWithHistory(NEXT, ["export default () => 'OLDER';"]);
    view.rerender(<GraphComponent id="x" fallback={<div>fallback</div>} />);
    await waitFor(() => expect(screen.getByText("good")).toBeTruthy());
    expect(load).toHaveBeenCalledTimes(2); // the good compile + the failed one — the rung was never built
  });

  it("still shows the caller's fallback when every retained version is broken too", async () => {
    // The gate must never invent a component. A record with no working version anywhere degrades to the
    // caller's fallback — one dead surface, not a dead app.
    load.mockRejectedValue(new Error("Unexpected token"));
    setSourceWithHistory(NEXT, [GOOD]);
    render(<GraphComponent id="x" fallback={<div>fallback</div>} />);
    expect(await screen.findByText("fallback")).toBeTruthy();
  });

  it("recovers a version that COMPILED but threw on its first render", async () => {
    // The null-dispatcher shape: a hook resolving against the wrong React instance compiles perfectly
    // well and only fails once something mounts it, which is why no syntax-level write gate could catch
    // it. The boundary catches the throw and the ladder has to serve the second failure path too.
    load.mockResolvedValueOnce(() => {
      throw new Error("Cannot read properties of null (reading 'useCallback')");
    });
    load.mockResolvedValueOnce(() => <div>good</div>);
    setSourceWithHistory(NEXT, [GOOD]);
    render(<GraphComponent id="x" fallback={<div>fallback</div>} />);
    expect(await screen.findByText("good")).toBeTruthy();
  });
});

describe("a lost hydration race heals itself", () => {
  beforeEach(() => {
    resetLastGood();
    resetGraphCompiles();
    load.mockReset();
    useAppStore.setState({ components: [] as never, algorithmImpls: [] as never });
  });

  it("retries the compile when the ALGORITHM IMPLS land after it failed", async () => {
    // THE Projects-page bug. `resolveGraphSource` reads `algorithmImpls` from the store as a snapshot at
    // COMPILE time, and `useAppBoot` fires `hydrateComponents()` and `hydrateAlgorithms()` as parallel
    // `void` calls. A page whose record imports an algorithm-record specifier — `projectspage` imports
    // `@/shared/hooks/useFleetLive` — can therefore compile the instant its own source lands, while the
    // impls are still `[]`, and fail with "is not a registered app module".
    //
    // Losing that race used to be PERMANENT: the load effect keyed on the page's own source, which never
    // changes afterwards, so the impls arriving re-fired nothing.
    load.mockRejectedValueOnce(new Error('runtime loader: import "@/shared/hooks/useFleetLive" is not a registered app module'));
    setSource(GOOD);
    render(<GraphComponent id="x" fallback={<div>fallback</div>} />);
    expect(await screen.findByText("fallback")).toBeTruthy();

    // …the impls hydrate. Nothing about the page's own record changed.
    load.mockResolvedValueOnce(() => <div>good</div>);
    useAppStore.setState({ algorithmImpls: [{ id: "use-fleet-live.ts", provides: "@/shared/hooks/useFleetLive", code: "x" }] as never });

    await waitFor(() => expect(screen.getByText("good")).toBeTruthy());
  });

  it("does NOT recompile a page already mounted from the current source", async () => {
    // The cost side of the same dependency. Without the mounted-guard, the impls landing would tear down
    // and recompile EVERY graph page on screen — trading one broken surface for a boot-wide stall at
    // ~700ms per page. A page that is already up must not notice.
    load.mockResolvedValueOnce(() => <div>good</div>);
    setSource(GOOD);
    render(<GraphComponent id="x" fallback={<div>fallback</div>} />);
    expect(await screen.findByText("good")).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(1);

    useAppStore.setState({ algorithmImpls: [{ id: "a", provides: "@/x", code: "y" }] as never });
    await waitFor(() => expect(screen.getByText("good")).toBeTruthy());
    expect(load, "the impls landing did not trigger a second compile").toHaveBeenCalledTimes(1);
  });

  it("still recompiles when the page's OWN source changes, impls or not", async () => {
    // The guard keys on (cacheKey, source), so a designer edit must still get through it — otherwise the
    // live-edit loop would be the thing this fix broke.
    load.mockResolvedValueOnce(() => <div>good</div>);
    setSource(GOOD);
    const view = render(<GraphComponent id="x" fallback={<div>fallback</div>} />);
    expect(await screen.findByText("good")).toBeTruthy();

    load.mockResolvedValueOnce(() => <div>next</div>);
    setSource(NEXT);
    view.rerender(<GraphComponent id="x" fallback={<div>fallback</div>} />);
    expect(await screen.findByText("next")).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("compile coalescing (#three-compiles-race-for-every-graph-page-mount)", () => {
  beforeEach(() => {
    resetLastGood();
    resetGraphCompiles();
    load.mockReset();
    useAppStore.setState({ components: [] as never });
  });

  /** A loader held open until released — so the race is driven, not timed. */
  function deferredLoad() {
    let release!: (c: () => ReactNode) => void;
    load.mockImplementation(() => new Promise((res) => { release = res as never; }));
    return { release: () => release(() => <div>good</div>) };
  }

  it("compiles ONCE when several mounts race for the same source", async () => {
    // THE regression, measured on the real log: the Console page remounted three times during load and
    // each remount started its own compile of the identical 18,462 chars — 72 compiles for 24 mounts.
    // The assertion counts COMPILES, not renders: a version that rendered correctly while still
    // compiling three times would pass a render test and fix nothing.
    const { release } = deferredLoad();
    setSource(GOOD);
    render(
      <>
        <GraphComponent id="x" fallback={<div>fallback</div>} />
        <GraphComponent id="x" fallback={<div>fallback</div>} />
        <GraphComponent id="x" fallback={<div>fallback</div>} />
      </>,
    );
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    release();
    await waitFor(() => expect(screen.getAllByText("good")).toHaveLength(3));
  });

  it("still compiles a source that CHANGED — a designer edit is never served a stale component", async () => {
    load.mockResolvedValueOnce(() => <div>good</div>);
    setSource(GOOD);
    const view = render(<GraphComponent id="x" fallback={<div>fallback</div>} />);
    expect(await screen.findByText("good")).toBeTruthy();

    load.mockResolvedValueOnce(() => <div>next</div>);
    setSource(NEXT);
    view.rerender(<GraphComponent id="x" fallback={<div>fallback</div>} />);
    expect(await screen.findByText("next")).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does NOT keep a settled compile — a later mount rebuilds against current siblings", async () => {
    // Deliberate, and the reason is worth pinning: a compile vendors its SIBLINGS at build time (#3606)
    // while the load effect re-fires only on this record's OWN source. Retaining a settled entry would
    // make returning to a page instant at the cost of serving a component built from stale siblings —
    // the designer's live-edit loop. Anyone tempted to turn this into a compile cache has to change this
    // test, and read this comment first.
    load.mockResolvedValue(() => <div>good</div>);
    setSource(GOOD);
    const first = render(<GraphComponent id="x" fallback={<div>fallback</div>} />);
    expect(await screen.findByText("good")).toBeTruthy();
    first.unmount();

    render(<GraphComponent id="x" fallback={<div>fallback</div>} />);
    expect(await screen.findByText("good")).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("a FAILED compile is not replayed — the next mount retries", async () => {
    load.mockRejectedValueOnce(new Error("Unexpected token"));
    setSource(GOOD);
    const first = render(<GraphComponent id="x" fallback={<div>fallback</div>} />);
    expect(await screen.findByText("fallback")).toBeTruthy();
    first.unmount();

    load.mockResolvedValueOnce(() => <div>good</div>);
    render(<GraphComponent id="x" fallback={<div>fallback</div>} />);
    expect(await screen.findByText("good"), "a transient failure must not pin the fallback").toBeTruthy();
  });
});
