// The dev server's watch-ignore list, asserted against the paths it exists to exclude.
//
// A pattern here cannot be checked by tsc (they are strings) and its failure mode points nowhere near
// its cause: `tauri dev` sits forever with the CLI at 0 CPU while vite pegs a core, and nothing in the
// repo looks wrong. Both directions are tested — too narrow stalls the launch, too broad silently kills
// HMR for a source file, which reads as "the dev server is broken".
import { describe, it, expect } from "vitest";
import picomatch from "picomatch";
import { devWatchIgnored } from "./devWatchIgnore";

// chokidar matches ABSOLUTE paths; the real config passes a forward-slashed root with no trailing slash.
const ROOT = "C:/Users/dev/Projects/base-studio-code";
const at = (rel: string) => `${ROOT}/${rel}`;

describe("devWatchIgnored", () => {
  // `dot: false` is picomatch's default and the STRICTER model: it will not match `.`-prefixed segments.
  // Asserting under it means the patterns hold whether or not the watcher enables dotfile matching.
  const ignored = (p: string) => picomatch(devWatchIgnored(ROOT))(p);

  it("ignores a nested worktree — a second full copy of the repo inside the watched root", () => {
    expect(ignored(at("wt-r305"))).toBe(true);
    expect(ignored(at("wt-r305/src/app/App.tsx"))).toBe(true);
  });

  it("ignores the worktree DIRECTORY itself, which is what prunes its dot-directories", () => {
    // `.bsc-records/` is the heaviest churner in a worktree — `npm run typecheck` materializes 184+ files
    // into it. A contents-only pattern does NOT match a `.`-prefixed child under a
    // dot-less matcher, so listing the directory is what actually excludes it: chokidar never descends.
    expect(ignored(at("wt-boundary"))).toBe(true);
    expect(ignored(at("wt-boundary/.bsc-records/app/Achievement.tsx")), "contents-only would MISS this")
      .toBe(false);
  });

  it("still ignores the build/output trees the list was written for", () => {
    expect(ignored(at("target/debug/bsc.exe"))).toBe(true);
    expect(ignored(at("src-tauri/data/ui/react-ui-kit.meta.json"))).toBe(true);
    expect(ignored(at("dist/assets/index-641DV_K5.js"))).toBe(true);
    expect(ignored(at("coverage/lcov.info"))).toBe(true);
  });

  it("does NOT ignore the source it exists to watch", () => {
    expect(ignored(at("src/app/App.tsx"))).toBe(false);
    expect(ignored(at("src/features/designs/ComponentPreviewFrame.tsx"))).toBe(false);
    expect(ignored(at(".bsc-records/app/Achievement.tsx"))).toBe(false);
  });

  it("is ROOT-ANCHORED, so a source file merely NAMED wt-… keeps its HMR", () => {
    // The trap an unanchored globstar pattern falls into: it also matches any file whose basename starts with
    // `wt-`, silently dropping it from the watcher.
    expect(ignored(at("src/shared/ui/wt-widget.tsx"))).toBe(false);
    expect(ignored(at("src/features/planner/wt-status.ts"))).toBe(false);
    // …and a `wt-` directory somewhere OTHER than the root is not a worktree either.
    expect(ignored(at("src/features/wt-experiment/index.ts"))).toBe(false);
  });
});

// ── the DEBUG sessions' worktrees (#a-record-write-restarts-the-app-the-user-is-using) ─────────────
//
// `wt-*` is the maintainer's convention. The debugger charter tells every debug session to work in
// `.claude/worktrees/<branch>/` instead, and only the first was listed — so the worktrees driven by a
// process that runs CONTINUOUSLY were the ones being watched. 27 of them when this was found, 36,742
// files inside the watched root.
describe("devWatchIgnored — the debug sessions' worktrees", () => {
  const ignored = (p: string) => picomatch(devWatchIgnored(ROOT))(p);

  it("ignores a debug worktree and its sources", () => {
    expect(ignored(at(".claude/worktrees/129-chart-primitives"))).toBe(true);
    expect(ignored(at(".claude/worktrees/129-chart-primitives/src/app/App.tsx"))).toBe(true);
  });

  it("ignores the worktree DIRECTORY itself, which is what prunes its `.bsc-records/`", () => {
    // The same rule the `wt-*` case above states, and the reason it matters more here: 1,346 files per
    // worktree in `.bsc-records/`, rewritten by every typecheck and every test run. The MATCHER does not
    // exclude that path — a `.`-prefixed segment is not matched under `dot: false` — so the exclusion
    // has to come from chokidar never descending into the directory at all.
    expect(ignored(at(".claude/worktrees/129-chart-primitives"))).toBe(true);
    expect(
      ignored(at(".claude/worktrees/129-chart-primitives/.bsc-records/store/slices/projects.tsx")),
      "contents-only would MISS this — the directory entry is what excludes it",
    ).toBe(false);
  });

  it("does NOT ignore the rest of `.claude/`, which is real repo content", () => {
    // Only the worktrees are a second copy of the repo. Settings, agents and skills are source the
    // maintainer edits, and silently unwatching them would read as "HMR is broken".
    expect(ignored(at(".claude/settings.json"))).toBe(false);
    expect(ignored(at(".claude/agents/reviewer.md"))).toBe(false);
  });

  it("is anchored, so a source file whose path merely contains the word still watches", () => {
    expect(ignored(at("src/features/glance/worktrees.ts"))).toBe(false);
    expect(ignored("/elsewhere/.claude/worktrees/x/src/app/App.tsx")).toBe(false);
  });
});

