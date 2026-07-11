import { describe, it, expect } from "vitest";
import { looksLikeModuleLoadFailure } from "./componentRuntimeProbe";

// The iframe grab (createElement + srcdoc + postMessage) isn't exercised under jsdom — it's
// runtime-verified in the app. What's unit-tested here is the PURE guard that keeps the scan from
// false-badging a whole kit when its externals can't load (offline / blocked CDN), while still badging a
// genuine component render throw (#2908).
describe("looksLikeModuleLoadFailure — environment vs component throw", () => {
  it("matches module/network load failures (inconclusive ⇒ not a component defect)", () => {
    const loadFailures = [
      "Failed to fetch dynamically imported module: https://esm.sh/react@19",
      "error loading dynamically imported module",
      "Importing a module script failed.", // Safari
      "Load failed",
      "NetworkError when attempting to fetch resource.",
      "Failed to load resource: net::ERR_INTERNET_DISCONNECTED",
    ];
    for (const m of loadFailures) expect(looksLikeModuleLoadFailure(m)).toBe(true);
  });

  it("does NOT match a genuine runtime throw (those still get badged)", () => {
    const realThrows = [
      "TypeError: Cannot read properties of undefined (reading 'x')",
      "links[0].source is undefined",
      "Maximum update depth exceeded",
      "d3.forceSimulation is not a function",
      "Cannot access 'nodes' before initialization",
    ];
    for (const m of realThrows) expect(looksLikeModuleLoadFailure(m)).toBe(false);
  });
});
