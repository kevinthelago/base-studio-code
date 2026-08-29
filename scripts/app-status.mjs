// Is the app binary you are running older than the code on `main`?
// (#the-app-should-not-relaunch-itself-tier-1-and-2)
//
// This exists because Tier 1 (`--no-watch`) trades a LOUD interruption for a QUIET staleness, and a
// quiet staleness is its own bug. The watcher used to answer "am I running current code?" by
// relaunching you; with it off, nothing answers unless something asks. This asks.
//
//   node scripts/app-status.mjs [--json]
//
// It compares the built binary against `main`'s tip. It deliberately does NOT compare against
// `develop`: the app runs `main`, and work sitting on develop is not something the app is behind on
// — it is work you have not promoted yet, which is a different question and already has an answer
// (`npm run promote --dry-run`).

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The MAIN worktree — the app's tree — wherever this script is run from. */
function mainWorktree(from) {
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: from,
    encoding: "utf8",
  }).trim();
  return dirname(common);
}

const REPO_ROOT = mainWorktree(dirname(dirname(fileURLToPath(import.meta.url))));
const git = (args) => execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();

/**
 * Pure verdict, so the rule is testable without a filesystem (`scripts/app-status.test.ts`).
 *
 * @param {{binaryExists: boolean, binaryMs: number, headMs: number, behind: number}} s
 * @returns {{state: "absent"|"current"|"stale", reason: string}}
 */
export function judgeAppBinary(s) {
  const { binaryExists, binaryMs = 0, headMs = 0, behind = 0 } = s ?? {};
  if (!binaryExists) return { state: "absent", reason: "never-built" };
  // COMMIT COUNT FIRST, mtime only as the tiebreak. A rebuild touches the mtime without changing what
  // it was built from, so mtime alone calls a fresh rebuild of old code "current" — which is exactly
  // the reassuring-but-wrong answer this file exists to avoid.
  if (behind > 0) return { state: "stale", reason: `${behind}-commits-behind-main` };
  if (headMs > binaryMs) return { state: "stale", reason: "head-newer-than-binary" };
  return { state: "current", reason: "up-to-date" };
}

function main() {
  const json = process.argv.includes("--json");
  const binary = join(REPO_ROOT, "target", "debug", "base-studio-code");
  const binaryExists = existsSync(binary);
  const binaryMs = binaryExists ? statSync(binary).mtimeMs : 0;
  const headMs = Number(git(["log", "-1", "--format=%ct", "main"])) * 1000;

  // How many commits on main landed AFTER the binary was built. `--since` is the honest question:
  // "what has main gained that this binary cannot contain?"
  const behind = binaryExists
    ? Number(
        git(["rev-list", "--count", `--since=${Math.floor(binaryMs / 1000)}`, "main"]) || "0",
      )
    : 0;

  const verdict = judgeAppBinary({ binaryExists, binaryMs, headMs, behind });

  if (json) {
    console.log(JSON.stringify({ ...verdict, behind, binary }, null, 2));
    return;
  }
  if (verdict.state === "absent") {
    console.log("[app-status] no app binary built yet — `npm run app:dev` will build one.");
    return;
  }
  if (verdict.state === "current") {
    console.log("[app-status] the built app matches main. Nothing waiting.");
    return;
  }
  console.log(`[app-status] the built app is BEHIND main by ${behind} commit(s):`);
  console.log(
    git(["log", "--oneline", "--no-decorate", `--since=${Math.floor(binaryMs / 1000)}`, "main"])
      .split("\n")
      .filter(Boolean)
      .slice(0, 10)
      .map((l) => `    ${l}`)
      .join("\n"),
  );
  console.log(`[app-status] Restart the app when you want them. Nothing will restart it for you.`);
}

if (process.argv[1] && process.argv[1].endsWith("app-status.mjs")) main();
