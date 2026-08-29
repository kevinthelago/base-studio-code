import { describe, it, expect } from "vitest";
import { killPatterns, shouldKill } from "./rebuild.mjs";

const REPO = "/home/dev/base-studio-code";

describe("rebuild — what it is allowed to kill", () => {
  it("kills the app binary and the tauri CLI for THIS repo", () => {
    expect(shouldKill(`${REPO}/target/debug/base-studio-code`, REPO)).toBe(true);
    expect(shouldKill(`node ${REPO}/node_modules/.bin/tauri dev`, REPO)).toBe(true);
  });

  it("never matches a bare name — the whole reason the patterns are absolute", () => {
    // `pkill -f base-studio-code` is the obvious implementation and it is a trap: it matches the
    // developer's editor with the repo open, a grep for the string, and the rebuild script itself.
    for (const innocent of [
      "base-studio-code",
      "vim /home/dev/base-studio-code/src/app/App.tsx",
      "grep -r base-studio-code .",
      "node scripts/rebuild.mjs",
      "/usr/bin/code --folder base-studio-code",
    ]) {
      expect(shouldKill(innocent, REPO), innocent).toBe(false);
    }
  });

  it("does not reach into ANOTHER checkout of the same repo", () => {
    // Worktrees and second clones are normal here. Killing another tree's app because it shares a
    // basename would stop work the user did not ask to stop.
    expect(shouldKill("/home/dev/other-clone/target/debug/base-studio-code", REPO)).toBe(false);
    expect(shouldKill(`${REPO}/wt-cred/target/debug/base-studio-code`, REPO)).toBe(false);
  });

  it("scopes every pattern to the repo it was given", () => {
    for (const p of killPatterns(REPO)) expect(p.startsWith(REPO)).toBe(true);
    expect(killPatterns(REPO)).not.toEqual(killPatterns("/somewhere/else"));
  });
});
