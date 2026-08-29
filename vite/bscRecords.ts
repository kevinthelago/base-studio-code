// The record fallback for Vite and vitest — the same two-step resolve `tsconfig.paths` gets natively.
//
// `tsconfig.json` can express this in one line (`"@/*": ["./src/*", "./.bsc-records/*"]`) because tsc
// takes an ORDERED list. Vite's `resolve.alias` takes a single target, so the fallback needs a resolver
// hook. That asymmetry is the entire reason this file exists — it is not doing anything tsc isn't.
//
// It resolves to a real path in the generated tree rather than serving source from memory. An earlier
// version returned the seed's `srcText` as a virtual module, and deleting one file broke three ways at
// once: a RELATIVE import (`./layout/Spacer`) never reaches a plugin matching `@/…`; `tsc` has no such
// plugin API at all; and vitest loads a different config so the plugin was never installed. A file on
// disk is the one thing all three already agree on — see `scripts/emit-records.mjs`.
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Plugin } from "vite";
import { emitRecords } from "../scripts/emit-records.mjs";

/** ONCE PER PROCESS, across every plugin instance — module-level on purpose.
 *
 *  `emitRecords` starts by `rmSync`-ing the whole tree and rebuilding it, which is right for one emitter
 *  and catastrophic for two. A WORKER is a separate build with its own plugin list, and its `buildStart`
 *  fires from inside the MAIN build's transform phase — so a second instance deleted the tree while
 *  rolldown was concurrently loading modules out of it. The failure surfaced as "Could not load
 *  .bsc-records/…", naming a DIFFERENT module on every run, for files that were plainly on disk by the
 *  time anyone looked. Nothing about the seeds changes mid-build, so emitting once is not just a fix for
 *  the race — it is the only emission that was ever meaningful. */
let emitted = false;

/** The newest seed mtime the emitted tree was built from — the staleness key for the re-emit below.
 *  `0` until the first emit, so the first miss after a cold start always re-checks. */
let emittedInputStamp = 0;

/** Newest mtime across everything `emitRecords` reads: every `src-tauri/data/components/**` record and
 *  `data/knowledge/algorithms.json`. Walks rather than trusting directory mtimes, because editing an
 *  existing record in place does not change the mtime of the directory holding it. */
function newestInputMtime(repoRoot: string): number {
  let newest = 0;
  const bump = (p: string) => {
    try {
      const s = statSync(p);
      if (s.mtimeMs > newest) newest = s.mtimeMs;
    } catch { /* unreadable ⇒ not a signal */ }
  };
  const walk = (dir: string) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p); else bump(p);
    }
  };
  walk(join(repoRoot, "src-tauri", "data", "components"));
  bump(join(repoRoot, "src-tauri", "data", "knowledge", "algorithms.json"));
  return newest;
}

/** Re-emit IF the seeds have moved since the tree was built. Returns whether it emitted.
 *
 *  This is the mid-session half of #the-dev-server-never-regenerates-the-records-cache. That one made
 *  startup regenerate; the dev server then runs for HOURS while a fleet lands more retirements, and the
 *  once-per-process `emitted` flag meant the tree was never rebuilt again — so a card retired at 19:05
 *  was unresolvable until someone restarted vite. Twice now that surfaced as
 *  "Failed to resolve import @/features/settings/cards/…".
 *
 *  GATED ON THE SEEDS, not on the miss alone, for two reasons. The emitter costs ~2.7s warm, and the
 *  test suite deliberately imports ~55 specifiers that resolve to nothing (`@/components/a`,
 *  `@/gone/types`) — charging each of those an emit would be far worse than the bug. Advancing the stamp
 *  even when the retry fails is what keeps one seed state to one emit. */
function reEmitIfSeedsMoved(repoRoot: string): boolean {
  const now = newestInputMtime(repoRoot);
  if (now === 0 || now <= emittedInputStamp) return false;
  emitRecords({ quiet: true });
  emittedInputStamp = now;
  return true;
}

/** How often the dev server re-checks the seeds for an EDIT. See `configureServer` below. */
const SEED_POLL_MS = 2_000;

export function bscRecords(opts: { repoRoot: string }): Plugin {
  const { repoRoot } = opts;
  const records = resolve(repoRoot, ".bsc-records");

  // The EXACT path first, then the extension probes. Without the empty entry a specifier that already
  // carries its extension — `@/app/lazyWorkspaces.tsx?raw`, once the query is split off — matched nothing,
  // because every candidate appended a second extension (`lazyWorkspaces.tsx.tsx`). `isFile` rather than
  // `existsSync` for that first probe: a bare `@/features/planner` names a DIRECTORY that exists, and
  // returning it would resolve the barrel to a folder.
  const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };
  const hit = (base: string) =>
    ["", ".tsx", ".ts", "/index.tsx", "/index.ts"].map((e) => base + e).find(isFile) ?? null;

  return {
    name: "bsc-records",

    // GENERATE HERE, not in an npm script. Wiring generation into `typecheck`/`test`/`build` meant the
    // tree existed only if a developer typed one of those — `npm run dev`, `npx vite`, `npm run tauri --
    // dev` and an IDE launch all skipped it, and the dev server booted with a retired module unresolvable:
    // "Failed to fetch dynamically imported module: /src/app/runtime/appModules.ts", which killed the whole
    // boot chain. The tree is a precondition of RESOLUTION, so it belongs to the thing that resolves.
    // It also explains why the gate stayed green: every gate command regenerated first, so no gate could
    // observe the broken state — and the one command nobody gates on is the one a person runs all day.
    buildStart() {
      if (emitted) return; // see `emitted` above — a second emitter deletes the tree mid-build
      emitted = true;
      emitRecords({ quiet: true });
      emittedInputStamp = newestInputMtime(repoRoot);
    },
    // WATCH THE SEEDS FOR AN EDIT — the half `resolveId` structurally cannot see.
    //
    // The re-emit below hangs off a resolve that misses BOTH trees, which is the moment a RETIREMENT
    // becomes visible: a specifier nothing can answer. An EDIT to a record already in the tree is the
    // opposite shape. The first probe HITS, `resolveId` returns the stale file, and the staleness check
    // three lines further down is never reached — and an edit does not re-resolve anything in the first
    // place, so no amount of reordering inside that hook would help. The dev server therefore served a
    // frozen copy of every record for its whole life, and nothing else covered the gap: `bsc ui set`
    // writes the LIVE STORE, `emitRecords` reads the PACKAGED SEED, and vite watches neither.
    //
    // MEASURED COST OF NOT HAVING THIS. The `pty_data` listener was made payload-tolerant at 1e914e11
    // (09:56, seed and store in sync); the emitted copy stayed at 09:05 holding the previous,
    // string-only listener. One minute later Rust began sending `{data, upto}`, that stale listener read
    // `.length` off an object, and every perf line went `NaNKB` while `[object Object]` was written into
    // every terminal. `tauri dev` restarts the Rust binary WITHOUT re-running `beforeDevCommand`, so the
    // restart that should have proved it never re-emitted either. The change was reverted at b7e785ad
    // against a diagnosis that blamed the wrong half — the payload was fine all along. That is the real
    // cost here: "verify against the RUNNING app" is this repo's strongest check, and a frozen record
    // tree turns it into a confident false negative.
    //
    // POLLED, NOT WATCHED, and both halves of that are deliberate. `devWatchIgnore` ignores
    // `**/src-tauri/**` wholesale, so vite's own watcher cannot be asked for these paths; and a
    // recursive `fs.watch` would add ~100 inotify watches per dev server on a box that is already out of
    // them (`the-box-is-out-of-inotify-watches` — 36 worktrees against a stock 65,536 limit, where a new
    // Vite server simply fails to start). The poll is the same walk `newestInputMtime` already does:
    // MEASURED at 2.29ms over 309 seed files, every 2s. Nothing is spent when nothing changed, because
    // `emitRecords` now reconciles rather than rewrites — a no-op emit touches zero files, so HMR sees
    // nothing and the one edited record is the only module that updates.
    configureServer(server) {
      const tick = setInterval(() => {
        // `buildStart` owns the FIRST emit and the stamp it sets. Polling before that would emit against
        // a stamp of 0 and race it for the tree.
        if (!emitted) return;
        try {
          reEmitIfSeedsMoved(repoRoot);
        } catch (e) {
          // A seed being written as we walk it is normal, and a dev server must not die of it.
          server.config.logger.warn(`[bsc-records] re-emit skipped: ${(e as Error).message}`);
        }
      }, SEED_POLL_MS);
      // Unref'd so the timer can never be the reason a `vite build` or a test run refuses to exit.
      tick.unref?.();
      server.httpServer?.on("close", () => clearInterval(tick));
    },
    // Ahead of the `@` alias, so the specifier is still in `@/…` form and matches exactly instead of
    // guessing which extension the alias resolved to.
    enforce: "pre",
    resolveId(rawSource) {
      // CARRY THE QUERY THROUGH. `@/app/lazyWorkspaces.tsx?raw` is a real import — `shadowPages.test.ts`
      // reads a module's SOURCE to check every workspace is catalogued — and the suffix defeated the
      // extension probe: `lazyWorkspaces.tsx?raw` + `.tsx` matches nothing, so the hook declined, the
      // alias rewrote it to a path under `src/`, and the file was gone. Vite resolves `<path>?raw` fine
      // once the path is right, so the fix is to split the query off, resolve the bare specifier, and
      // re-attach it. `?url`, `?worker` and the rest come along for free.
      const q = rawSource.indexOf("?");
      const source = q === -1 ? rawSource : rawSource.slice(0, q);
      const query = q === -1 ? "" : rawSource.slice(q);
      // BOTH forms, and the second is the one that actually fires. `resolve.alias` is itself an
      // `enforce: "pre"` plugin and wins the race, so by the time this hook runs the specifier is no
      // longer `@/shared/ui/layout/Spacer` — it is the aliased path `<repo>/src/shared/ui/layout/Spacer`,
      // extensionless and non-existent. Matching only the `@/` form looks correct and never fires.
      let rel: string[] | null = null;
      if (source.startsWith("@/")) {
        rel = source.slice(2).split("/");
      } else {
        // `split("\\").join("/")` rather than a regex: a backslash class inside a shell-written file is
        // one escaping layer too many, and it collapsed to an unterminated regex the first time.
        const norm = source.split("\\").join("/");
        const root = resolve(repoRoot, "src").split("\\").join("/") + "/";
        if (norm.startsWith(root)) rel = norm.slice(root.length).split("/");
      }
      if (!rel) return null;
      // The file wins while it exists. Installing this plugin is therefore a no-op until a deletion.
      if (hit(join(repoRoot, "src", ...rel))) return null;
      const found = hit(join(records, ...rel));
      if (found) return found + query;
      // MISSED BOTH — the tree may simply predate a retirement that landed while this process ran.
      // Re-emit only if the seeds actually moved, then try once more. See `reEmitIfSeedsMoved`.
      if (reEmitIfSeedsMoved(repoRoot)) {
        const healed = hit(join(records, ...rel));
        if (healed) return healed + query;
      }
      return null;
    },
  };
}
