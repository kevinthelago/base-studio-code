import { describe, it, expect } from "vitest";
import { killPatterns, shouldKill } from "../../../scripts/rebuild.mjs";

const REPO = "/home/dev/base-studio-code";

describe("rebuild — vite must be stopped too", () => {
  it("kills the repo's vite dev server", () => {
    // A surviving vite keeps :1420, the new launch's beforeDevCommand fails on the port, and tauri
    // then attaches to the OLD server — a "successful" rebuild serving a stale frontend.
    expect(shouldKill(`node ${REPO}/node_modules/.bin/vite`, REPO)).toBe(true);
  });

  it("still refuses a bare name and another checkout", () => {
    expect(shouldKill("vite", REPO)).toBe(false);
    expect(shouldKill("/home/dev/other/node_modules/.bin/vite", REPO)).toBe(false);
  });

  it("scopes every pattern to the given repo", () => {
    for (const p of killPatterns(REPO)) expect(p.startsWith(REPO)).toBe(true);
  });
});
