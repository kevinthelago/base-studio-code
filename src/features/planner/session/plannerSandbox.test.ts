import { describe, it, expect } from "vitest";
import { wantsSandboxLaunch } from "./plannerSandbox";

describe("wantsSandboxLaunch (#1988)", () => {
  it("true only when the toggle is on, the harness is bsc-agent, AND there's a hub to relocate", () => {
    expect(wantsSandboxLaunch(true, "bsc-agent", "/hub")).toBe(true);
  });

  it("false when the sandbox toggle is off (the default — host launch)", () => {
    expect(wantsSandboxLaunch(false, "bsc-agent", "/hub")).toBe(false);
  });

  it("false for a non-bsc-agent harness — claude isn't baked into the distro", () => {
    expect(wantsSandboxLaunch(true, undefined, "/hub")).toBe(false);
    expect(wantsSandboxLaunch(true, "claude", "/hub")).toBe(false);
  });

  it("false with no host hub to relocate (workspace setup hasn't resolved)", () => {
    expect(wantsSandboxLaunch(true, "bsc-agent", "")).toBe(false);
  });
});
