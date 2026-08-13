import { describe, it, expect, vi } from "vitest";
import { applyDirectorNew, directorOnlyPlan, type DirectorRequest, type DirectorDeps } from "./fleetDirectorBridge";

function req(over: Partial<DirectorRequest> = {}): DirectorRequest {
  return {
    id: "r1",
    projectKey: "studio-code",
    paneId: "studio-code:director",
    hubPath: "C:/hub/studio-code",
    ...over,
  };
}

function deps(over: Partial<DirectorDeps> = {}): DirectorDeps & { fleetStartProject: ReturnType<typeof vi.fn> } {
  return { fleetStartProject: vi.fn(), ...over } as never;
}

describe("directorOnlyPlan", () => {
  it("enables the director and launches NO worker streams", () => {
    const plan = directorOnlyPlan();
    expect(plan.director.enabled).toBe(true);
    expect(plan.streams).toEqual([]);
  });

  it("claims zero recommended workers rather than a number nothing backs", () => {
    // `recommended` drives what the UI says the fleet SHOULD be running. A create that launched one
    // pane while claiming a worker count would read as a fleet that had mostly failed to start.
    expect(directorOnlyPlan().recommended).toBe(0);
  });

  it("carries a reasoning that explains the single pane", () => {
    // It is what a later reader sees when asking why this build tab has one session in it.
    expect(directorOnlyPlan().reasoning).toMatch(/architect/i);
    expect(directorOnlyPlan().reasoning).toMatch(/no worker streams/i);
  });
});

describe("applyDirectorNew", () => {
  it("launches through fleetStartProject with the project key and the resolved hub path", () => {
    const d = deps();
    const ack = applyDirectorNew(req(), d);

    expect(ack).toEqual({ id: "r1", created: true });
    expect(d.fleetStartProject).toHaveBeenCalledTimes(1);
    const [name, plan, key, paths] = d.fleetStartProject.mock.calls[0];
    expect(name).toBe("studio-code");
    expect(key).toBe("studio-code");
    expect(plan.director.enabled).toBe(true);
    expect(plan.streams).toEqual([]);
    // The ABSOLUTE hub path from Rust (#905) — without it the launch falls back to the async
    // `bscBaseDir` mirror, which is empty at startup and drops the session at the user root.
    expect(paths).toEqual({ hubPath: "C:/hub/studio-code" });
  });

  it("passes hubPath as undefined rather than an empty string when Rust could not resolve one", () => {
    // `fleetStartProject` treats a falsy hubPath as "fall back to the mirror"; an empty STRING would
    // be a path it tries to use.
    const d = deps();
    applyDirectorNew(req({ hubPath: "" }), d);
    expect(d.fleetStartProject.mock.calls[0][3]).toEqual({ hubPath: undefined });
  });

  it("refuses an empty project key without launching anything", () => {
    const d = deps();
    for (const projectKey of ["", "   "]) {
      const ack = applyDirectorNew(req({ projectKey }), d);
      expect(ack.created).toBe(false);
      expect(ack.error).toBeTruthy();
    }
    expect(d.fleetStartProject).not.toHaveBeenCalled();
  });

  it("reports a throwing launch as a stated error rather than propagating it", () => {
    // A throw would strand the Rust waiter until its timeout and surface as "the frontend did not
    // create the director", sending someone to debug the wrong layer.
    const d = deps({ fleetStartProject: vi.fn(() => { throw new Error("no tab"); }) } as never);
    const ack = applyDirectorNew(req(), d);
    expect(ack.created).toBe(false);
    expect(ack.error).toContain("no tab");
  });

  it("always echoes the request id back, so the Rust waiter is never stranded", () => {
    const d = deps({ fleetStartProject: vi.fn(() => { throw new Error("x"); }) } as never);
    expect(applyDirectorNew(req({ id: "corr-9" }), d).id).toBe("corr-9");
    expect(applyDirectorNew(req({ id: "corr-9", projectKey: "" }), deps()).id).toBe("corr-9");
  });

  it("never reports created:true on a path that did not launch", () => {
    // The one invariant the ack carries: the kickoff is already on disk by the time this runs, so a
    // false success leaves a project looking seeded with no session behind it.
    const failing = deps({ fleetStartProject: vi.fn(() => { throw new Error("x"); }) } as never);
    expect(applyDirectorNew(req(), failing).created).toBe(false);
    expect(applyDirectorNew(req({ projectKey: "" }), deps()).created).toBe(false);
  });
});
