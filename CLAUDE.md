# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**base-studio-code** is the desktop host application for a multi-agent AI development workflow platform. The desktop is authoritative — it owns the agent processes, GitHub connections, and the skills library. It pairs with **mobile-studio-code**, a **standalone** mobile app (its own repo, usable on its own) that can **optionally tunnel** into a desktop session — over a zero-knowledge Cloudflare relay, end-to-end encrypted (Noise IK) — so the same agents can be driven from a phone, from anywhere.

The core value proposition: run many AI coding agents in parallel across multiple repositories, with standardized knowledge (prompts, GitHub Actions templates, automation recipes) injected per project based on its tech stack.

## Tech Stack

| Layer | Choice |
|---|---|
| Desktop shell | Tauri v2 (Rust backend + WebView) |
| Frontend | React 19 + TypeScript, bundled with Vite |
| State management | Zustand |
| Styling | CSS custom properties (`src/styles/tokens.css`) |
| Fonts | Inter (sans) · JetBrains Mono (mono) via Google Fonts |
| Agent orchestration | Claude Code (default) or the model-agnostic `bsc-agent` shell; pluggable `LlmProvider` — Anthropic (`claude-sonnet-4-6` default), OpenAI, Gemini, local (`crates/llm`) |
| Mobile tunnel | Relay client (`src-tauri/src/mobile/tunnel/`) dialing a zero-knowledge Cloudflare Worker relay (`relay/`) — Noise IK E2E + QR pairing |
| Storage | SQLite (`crates/plandb`, plan store) · DuckDB (`crates/data`, canonical Data Model) |

## Testing

Every feature or bug fix must include tests as part of the same branch — never after. Tests are not optional.

| What changed | What to test |
|---|---|
| New store action | Unit test covering the action's state transitions and edge cases |
| New component | Render smoke test + interaction tests for each user-facing behavior |
| New Rust command | Unit test in the owning domain module's `#[cfg(test)]` block; cross-cutting tests live in `src-tauri/src/tests.rs` |
| Bug fix | A regression test that would have caught the original bug |

**Frontend:** Vitest + React Testing Library. Run with `npm test`.
**Rust:** Standard `#[test]` in a `#[cfg(test)]` module. Run with `cargo test --manifest-path src-tauri/Cargo.toml`.

Mocks for Tauri APIs (`invoke`, `listen`, `plugin-store`) are pre-configured in `src/test/setup.ts` and apply to every test file automatically.

### Browser interaction tests (`e2e/`, opt-in — #3264)

jsdom has **no text selection, no native drag, no layout and no CSS cascade**, so it structurally cannot
observe a whole class of preview bug — #3251 (drag stopped panning the Design Studio preview) shipped with
green tests three times for exactly this reason. `e2e/` holds a Playwright harness that drives the **real**
preview srcdoc in headless Chromium: a Vite-served page calls the shipped `bundleComponent` →
`collectAppCss` → `buildComponentSrcDoc` chain and mounts the result in a `sandbox="allow-scripts"` iframe,
so there is no forked render path. Reach for it when a change's correctness depends on real input, real
layout, or the real cascade — and NOT for logic a vitest unit test can already see.

```bash
npx playwright install chromium   # ONE TIME — the browser is not implied by `npm install`
npm run test:e2e                  # boots Vite on :1421 and drives Chromium (~15s)
npm run test:e2e -- --headed      # watch it happen
npm run typecheck:e2e             # e2e/ has its OWN tsconfig (see below)
```

**It is deliberately outside the default gate.** `e2e/` is excluded from `tsconfig.json` and from vitest
discovery, so `npm run typecheck` / `npm test` cannot break for a checkout that has not reinstalled — the
zero-install nested-worktree workflow (#1669) stays intact and no worktree agent pays for a browser it never
asked for. `npm run lint` **does** cover `e2e/`, so the dir is never unchecked by accident.

**Profiling the app in Chromium (`e2e/glanceProfile.spec.ts`).** The same harness is the only place we
can PROFILE the frontend. The app ships on WebKitGTK, which exposes nothing: its remote inspector speaks
a proprietary protocol with no installed client, `performance.memory` is Chromium-only so `readHeap()`
returns null, and `measureUserAgentSpecificMemory` is unimplemented. Chromium supplies the missing
instruments over CDP — `Performance.getMetrics` (JSEventListeners · Nodes · JSHeapUsedSize ·
RecalcStyleCount) and `HeapProfiler` allocation sampling, which ranks allocation BY CALL STACK.

```bash
npm run profile:glance                       # ~2.5 min; prints a population table + top allocators
PROFILE_SECONDS=600 npm run profile:glance   # a longer window
```

> ⚠️ **A clean run is evidence about the APP, never about the renderer that dies.** Chromium is not
> WebKitGTK, so an engine-level WebKit leak will not reproduce; what does carry over is anything
> application-level (accumulating listeners, retained JS, a runaway render loop). The harness also mounts
> against PACKAGED SEED data, not a live fleet, so a population that only grows with real traffic stays
> flat here. Both limits are restated in the spec's header.

> If Vite dies at startup with `ENOSPC: System limit for number of file watchers reached`, the box is out
> of inotify watches — 36 worktrees against a stock 65536 limit. Prefix with `CHOKIDAR_USEPOLLING=1`; the
> real fixes are raising `fs.inotify.max_user_watches` and `bsc worktree cap`. `devWatchIgnore.ts` is
> NOT at fault — it already anchor-ignores `wt-*` and `.claude/worktrees/*`.

> **Gotcha — gesture granularity is load-bearing.** The preview's pan engine ignores movement under a 5px
> threshold. A coarse drag (`{ steps: 24 }` over 300px) crosses it on the first move, so the engine
> `preventDefault`s before the browser can start a selection and the #3251 bug becomes **invisible**. Drive
> drags at ~2px per move, as `dragBy` in `previewInteraction.spec.ts` does.

## Commands

```bash
npm run dev               # Vite dev server — frontend only (hot-reload)
npm run dev:app           # the FULL app — at the ROOT, which checks out main (see below)
npm run tauri -- dev      # the same launch, unrecorded
npm run tauri -- build    # Production build (creates platform installer)
cargo test                # Run Rust backend tests
npm run typecheck    # TypeScript type-check without emit
npm run app:dev           # the app, with NOTHING able to relaunch it (see below)
npm run app:status        # is the built app behind main?
npm run promote           # gate develop, then fast-forward the app's tree
```

### Run the app so nothing can relaunch it: `npm run app:dev`

```bash
npm run app:dev       # tauri dev --no-watch — NOTHING restarts the app but you
npm run app:status    # is the built app behind main? (app:dev prints this at launch)
npm run dev:app       # the old watching launch — kept, for iterating on Rust
```

**`--no-watch` turns off the Rust file watcher, and that is the whole fix.** The interruption was never
really about merges: MEASURED 2026-08-29, a session had the repo ROOT as its working directory and was
editing `crates/bsc-graph/src/cli.rs` in place — 88 uncommitted lines calling a function it had not
written yet. No amount of routing merges elsewhere helps when the writes are already there. With the
watcher off, another session can edit, build and merge in the app's tree all day and the running app
does not notice.

**Vite is untouched**, because it is a separate process started by `beforeDevCommand`, not by the Rust
watcher. So the frontend keeps hot-reloading: a `.tsx` component hot-updates in place (Fast Refresh is
configured), a `.ts` lib module triggers a page reload, and a page reload does NOT cost you a session —
PTY sessions are backend-owned by paneId and re-attach rather than forking.

**The trade is honest staleness, and `app:status` is why it is not a bug.** With the watcher off, the
binary silently stops matching `main`; nothing announces it, because announcing it was the watcher's
job. `app:dev` prints the verdict at launch and `app:status` answers on demand. It counts COMMITS on
main since the binary was built rather than trusting mtime — a rebuild touches the mtime without
changing what it was built from, so mtime alone calls a fresh rebuild of old code "current".

Rust changes therefore wait for a restart you choose. That restart is recoverable: a pane resumes its
OWN conversation by session id (`a-pane-resumes-its-own-conversation-by-id`) and its scrollback replays
from a provably safe ANSI boundary (`pty-data-carries-its-recording-offset`).

Keeping a PTY host alive ACROSS a restart was weighed and declined: it inverts "the desktop is
authoritative — it owns the agent processes", and it reintroduces the same problem one level down,
since upgrading the host would kill the sessions it exists to preserve.

### The ROOT runs the app; integration happens in `wt-integrate`

**`npm run dev:app` runs at the repo root, and the root checks out `main`.** Every branch merges into
`develop` in the **`wt-integrate`** worktree — never at the root.

That inversion exists because `tauri dev` watches its own checkout and relaunches on a source change,
and the root used to be where every `git merge --no-ff` landed. So integrating restarted the app under
whoever was using it, and the person doing the integrating was the person being interrupted. MEASURED
across one session's five merges: 4 of 5 wrote files under `src/`, `src-tauri/src/` or `crates/` — 4,
2, 1, 0 and 7 watched files. Every one would have rebuilt and relaunched.

No watcher change can fix that; those are real source edits it is right to notice. Two narrower causes
WERE fixed and still hold: `.taurignore` stops a record write rebuilding (`data/components/`,
`data/knowledge/`), and the vite watcher ignores `.claude/worktrees` as it does `wt-*`.

```
repo root      → main      the app runs here (npm run dev:app). NEVER merge here.
wt-integrate   → develop   every branch merges here
wt-<short>     → <ref>      one per work item, as before, cut from the develop REF
```

The app was briefly parked in a `wt-app` worktree instead. That was rejected: the root is where a
person expects to find the application, so the surprise belongs on the transient activity
(integrating) rather than the persistent one (running the thing you are building).

```bash
npm run dev:app                    # at the ROOT — the app, with HMR
bsc plan integrate <ref> --dir wt-integrate    # integration, step 7 of the flow (lock-serialized, #185)
npm run promote                    # gate develop, fast-forward main at the root
npm run promote -- --dry-run       # what would move
npm run promote -- --skip-gate     # you just gated develop yourself
```

`npm run promote` is **explicit and never automatic** — choosing the moment the app changes is the
entire point. Be clear about what it does and does not buy: it fast-forwards `main` in the root, which
writes files `tauri dev` and vite are watching, so **a running app will rebuild and relaunch itself**.
That is inherent — new Rust means a new binary. What changes is that it happens when YOU ran the
command rather than when somebody else merged, and the script says which case you are in.

It refuses rather than works around: a dirty root, a detached HEAD, and `main` AHEAD of `develop`,
which means something committed straight to `main` — a fault to look at, not to paper over with a
merge commit. Guards are pinned in `crates/bsc-app/src/promote.rs`. Merging `develop` into `main` needs
only the `develop` REF, so promote never has to know where `wt-integrate` is; it locates it only to
run the gate there, because `gate-tree-guard` refuses a second cargo over the `target/` that
`tauri dev` owns — and after the inversion that `target/` is the root's.

**Clean up the branches a promote just landed — it is the last step of the promote, not an optional
tidy.** A branch here is LOCAL and never pushed, so once it is merged into `develop` (and
fast-forwarded onto `main`) its ref carries nothing you cannot reach from `develop` — it is pure
clutter, and it is how a session's branch list quietly grows to dozens. Two halves, worktrees first
because a branch checked out in a worktree cannot be deleted:

```bash
bsc worktree cap                   # DESTRUCTIVE: remove merged/parked worktrees beyond the cap (frees their branches)
git branch --merged develop --format='%(refname:short)' | grep -vxE 'develop|main' | xargs -r git branch -d
```

`git branch -d` (never `-D`) refuses a branch that is not fully merged, so this can only ever remove
LANDED work — a branch still holding un-integrated commits is left alone, loudly. Run the
sweep where HEAD is `develop`/`main` (the post-promote root, or `wt-integrate`) — `git branch -d`
resolves “merged” against the CURRENT branch, so from an unrelated worktree it wrongly refuses every one. Like `promote`
itself the sweep is **explicit, not automatic** — it runs when you promote, never on every merge — and
it only ever touches YOUR local refs. `bsc worktree cap` owns the worktree half; the branch-ref sweep
is a raw pipeline only until a first-class `bsc` verb is filed for it
(`record-operations-belong-on-the-bsc-surface-not-in-scripts`).

Hot-swapping the app instead is **not** available and that is settled: the `bsc` sidecar swaps because
it is a separate short-lived binary (`a-resolved-request-goes-live-without-a-restart`), while the app's
Rust half is a live process behind a webview — `sub-second-command-surface-requires-an-interpreted-surface`
records that a rebuild cannot get there.

### When a build or launch fails, it records itself

A build or launch failure used to exist only as scrollback in whoever's shell ran it, and vanished with
that shell. `npm run build:plan`, `npm run build` and `npm run dev:app` are wrapped in
**`bsc errors run`**, which streams the command through untouched, exits with its exact code, and files
one fingerprinted fault into `projects/studio-code/error.db` when it fails. A green run clears what its
own command recorded, so the store is a list of what is broken NOW rather than a pile of fixed things.

```bash
bsc errors projects                       # which project broke — the entry point when you know nothing
bsc errors list --project studio-code --unresolved
bsc errors get <fingerprint> --project studio-code    # the diagnostic + its context
bsc errors resolve <fingerprint> --project studio-code
```

`--project` matters more than it looks: every other path resolves the store from `$BSC_ERROR_DB`, which
is set **per session at launch** — so the one reader who most needs these, a session outside the app
after the app failed to start, is exactly the one without it.

A wrapper can only see a launch that DIES. The one that hurts is the launch where every process stays
alive — vite up, window open, **frontend never mounted** — and exit codes say nothing. So Rust arms a
deadline at startup and the frontend acks (`boot_mounted`) when it mounts; silence past it becomes a
`launch` fault, and a late ack clears it, so guessing the deadline too low costs a few seconds of amber
rather than a standing lie. When the crash overlay can still reach the backend it hands over the real
error; when it cannot — the case it exists for — the watchdog files the message-less one, which says
so rather than inventing a cause.

**A session inside the app cannot answer a LAUNCH failure, and that is structural, not a gap.** The
panes that would host it are the app's own UI and the runtime collector lives in the app's process, so
there is nothing running to do the work. Build failures are different — they happen while the app is up
— and a fault is durable, so a launch failure at 03:00 is still there, and still amber in Glance, at
09:00. Epic: `bsc plan get epic-a-build-or-launch-failure-leaves-no-record`.

The **gate is deliberately not wired to this**: it already fails loudly in your own shell, and ten
worktree agents gating in parallel would pin every node red and destroy the signal.

### What every build COST — `bsc cost`

The same wrapper also records what a run cost, and that half **is** wired into the gate, because
recording a cost cannot pin anything red. Every gate leg — `cargo clippy`, `cargo nextest`, `tsc`,
`eslint`, `vitest`, the graph checks — runs under `bsc errors run --measure-only`, which records wall
clock and the peak RSS of the whole process tree while filing **no fault**. It also inherits stdio
rather than piping, so cargo's live progress and colours survive being measured.

```bash
bsc cost build                             # what builds cost: n · median · worst · latest
bsc cost build --source gate:clippy        # ONE surface's history
bsc cost compare --at $(date +%s%3N)       # did my change help? (take the boundary BEFORE you start)
bsc cost app                               # the running app's JS heap / DOM nodes / listeners
bsc cost growth --session <id>             # a live session's RSS slope — the leak question
```

Measurements are per-leg and keyed on a stable id, so a **scoped** run and a **full** run of the same
leg share one history rather than splitting into two that can never be compared. Peak RSS is the
maximum over time of the SUMMED tree RSS — the same definition used by the hand-measured jobs/RAM
figures in `bsc memory read build-cost-measurements`, so the two are comparable rather than a second
incompatible metric.

**Every hand-measured figure in this file is now reproducible rather than remembered.** They were
taken once, by someone, and have no history behind them; `bsc cost build --source gate:<leg>` is the
trend. An absent measurement reads as ABSENT, never as zero — a build recorded at 0 ms would poison
every median it entered.

A worker records its before/after on its change record with `bsc plan change perf <ref> <metric>
<before> <after>`, which renders into the change and reaches the director. **Nothing here can fail a
gate** — that is deliberate, and it is why the reviewer is the only reader who acts on a regression.

### Backing this machine up — `bsc studio save --all`

Nothing here is pushed to a remote by policy, so the stores and the git environment exist on ONE
disk. The full runbook, including restore, is [`docs/backup-and-restore.md`](docs/backup-and-restore.md).

```bash
bsc studio save "full-system" --all --out /path/to/dest   # every store + every plan.db
bsc studio save help                                      # the per-system flags, FROM the roster
```

`--dir` is which install to **read**; `--out` is where the backup **goes**. That split is the whole
point of the flag: `--dir <empty>` used to create empty stores at the destination and back up THOSE,
reporting success.

**Capture is by DISCOVERY, not a roster.** Every `*.db` under the base dir is taken, so a store a
future crate adds is backed up without anyone remembering a row. That direction was chosen after the
allow-list silently omitted `atlas.db`, and the roster guard only caught it because one developer's
machine happened to have created the file. An unknown store is CAPTURED — a backup holding something
unnecessary costs disk, one missing something costs the data.

`secrets.db` is captured by **nothing**, and that omission is recorded rather than silent: the values
live in the OS keychain, but which services you are paired with is itself disclosure, and restoring
those rows on another machine would describe pairings that machine does not have.

Two refusals, both because a backup must not lie: an all-empty source is refused naming what it found
bare, and an `--out` at a `.json` path is refused when a database-backed system forces a directory.

**Verify on the far end, never locally** — a local check proves the bytes you made, not the ones that
arrived. And note `git clone --mirror` is NOT a git backup here: it keeps `refs/stash` (the top entry)
but not its reflog, so it preserved **1 of 32** stashes when measured.


## Project Structure

```
base-studio-code/
├── src-tauri/               # Rust backend (Tauri v2)
│   ├── Cargo.toml           # workspace root
│   ├── tauri.conf.json
│   └── src/                 # ONE FOLDER PER SUBSYSTEM — but the FOLDERS ARE RECORDS, NOT DIRECTORIES
│                            #   (`src-tauri-compiles-from-the-graph`). 138 modules moved into
│                            #   the committed store `graph/algorithms.db`; `src-tauri/src/` holds FOUR files — lib.rs,
│                            #   main.rs, tests.rs and one undeclared orphan. A record's module path
│                            #   IS its old file path, so every path below still names where a module
│                            #   BELONGS and `crate::console::pty` still resolves — you just open it
│                            #   with `bsc graph impl get src-tauri--console--pty--mod.rs` rather than
│                            #   with an editor. build.rs calls `graph_materialize::emit_when_adopted()`
│                            #   as a fifth job (a package gets exactly ONE build script, and this one
│                            #   was taken), which writes `$OUT_DIR/crate.rs` for lib.rs to `include!`.
│       ├── main.rs · lib.rs · prelude.rs · tests.rs   #   the FOUR files actually on disk
│       └── platform/ · app/ · console/ · session/ · project/ · planner/ · fleet/ · github/
│                            #   · sources/ · extensions/ · observability/ · mobile/
│                            #   What each subsystem owns: `bsc memory read crate-roster`
├── crates/                  # workspace crates (Tauri-free, CLI-spawnable) — ONE crate per `bsc` noun.
│                            #   Like src-tauri/src, 76 of these are RECORDS: the dir may not exist on
│                            #   disk. What each crate owns: `bsc memory read crate-roster`.
│   ├── data/ · plandb/ · skilldb/ · logs/ · compliance/ · bsc-security/ · research/ · bsc-news/
│   ├── bsc-say/ · bsc-ear/         #   the voice loop — `bsc memory read voice`
│   ├── llm/ · bsc-agent/           #   model-agnostic LlmProvider + agent runtime
│   ├── bsc-blueprint/ · bsc-persona/ · bsc-teams/ · bsc-project/   #   the user stores
│   ├── mcp-rpc/             #   shared stdio JSON-RPC MCP server scaffold
│   ├── bsc-tunnel/          #   mobile-tunnel wire contract + Noise IK (shared with mobile-studio-code)
│   └── bsc-util/ · bsc-sqlite-util/ · bsc-cli-util/   #   shared internal libs
├── src/                     # React frontend (TS) — FEATURE-FIRST vertical slices (#1309). MOST OF
│   │                        #   THIS IS RECORDS, NOT FILES (#3604) — see docs/records.md. The four
│   │                        #   top-level dirs ARE the architecture; imports use `@/…` → src (no
│   │                        #   deep `../../` relatives). No more layer dirs (components/lib/hooks/…).
│   ├── app/                 # the SHELL — knows every feature; features don't know it
│   │   ├── main.tsx  App.tsx   #   Vite entry + the Titlebar/Rail/screen-switcher shell
│   │   ├── registry.ts      #   canonical Workspace → {label, icon} (#1879); the rail + titlebar both read it
│   │   ├── chrome/          #   the SHELL-PRIVATE chrome: Rail, Titlebar, Tabstrip, StatusBar, locationCrumb
│   │   │                    #   (Screen + TabBar moved to shared/ui/layouts/ in #3245 — every Workspace
│   │   │                    #    composes them, so they are shared UI, not shell-private)
│   │   ├── console/         #   the execution surface: ConsoleWorkspace + panes/ + lib/ (pane system)
│   │   ├── safety/          #   the crash layer: ErrorBoundary + fatalOverlay (self-installing DOM crash overlay, #1905)
│   │   └── *Banner.tsx      #   crash/quarantine/readiness banners
│   ├── features/            # ONE FOLDER PER FEATURE = UI + lib/ (pure domain) + store.ts (its slice)
│   │   │                    #   + index.ts (public API barrel). Import UI via @/features/<x>; import
│   │   │                    #   the pure domain via @/features/<x>/lib/* (keeps React out of non-UI).
│   │   ├── designs/ · teams/ · algorithms/ · data/ · sounds/   # the FIVE GRAPH workspaces — one rail
│   │   │                    #   destination each, tabbed by their OWN axis (tech / team / kit / language).
│   │   │                    #   NOTE the Components workspace is `designs/` (DesignsWorkbench); there is
│   │   │                    #   no `features/components/` — `@/app/lazyWorkspaces` is the map to read.
│   │   ├── glance/          #   the cockpit: the project graph + its fleet panes (Fleet lives HERE, #2223)
│   │   ├── studio/ · studio-sessions/ · personas/ · debug/
│   │   ├── skills/ · mcp/ · automations/ · tunnel/ · logs/ · settings/ · github/ (slice only, no screen)
│   │   └── planner/         #   DOMAIN ONLY — no UI (blueprints/, stages/, issues/, fleet/, lib/, …);
│   │                        #   the plan model the architect + director drive through `bsc plan`
│   ├── shared/              # feature-agnostic; no feature imports it
│   │   ├── lib/             #   core (log/perf/llm), session, fleet, security, cleanup
│   │   ├── hooks/  ·  data/ #   shared hooks · typed sample data (mock.ts)
│   │   └── ui/              #   shared primitives, grouped (#1902): controls/ overlay/ feedback/ data/ layout/ charts/ + icons.tsx
│   ├── styles/tokens.css    # design tokens + base component styles
│   └── store/               # Zustand store COMPOSITION
│       ├── index.ts         #   create() composes feature slices + persist
│       ├── types.ts         #   AppStore = feature slice interfaces (`extends …Slice`) + core fields
│       └── slices/          #   console (core app state), plan, projects, session + core/shell residuals
└── package.json
```

### Frontend conventions (feature-first, #1309)

> **MOST OF THE FRONTEND IS NOT FILES.** Measured 2026-09-03: **981 modules ship as RECORDS** — 308
> component records under `src-tauri/data/components/app/**` plus 673 implementations in
> `data/knowledge/algorithms.json` — against **91 non-test modules under `src/`**. The files that held
> the records are deleted (epic #3604, "the graph IS the app"), and that 10:1 ratio is the claim that
> matters and still holds.
>
> **DO NOT read the file count as a settled floor — it is rising.** This paragraph used to say the
> harvest was finished and 77 was the floor. The sequence is 69 → 77 → **91**, and **40 non-test files
> were added under `src/` in the three weeks to 2026-09-03**. Many are legitimate by the reasons listed
> below (barrels, `store.ts` module state, registrars, statically-imported hooks) — but "the harvest is
> finished" is no longer an evidenced claim, and the breakdown below **sums to ~68, not 91**, so roughly
> twenty-three modules are unaccounted for. Treat the reasons as the SHAPE of why files survive, never
> as a census. Whether the author-into-the-store rule below is still being applied is an open question,
> not a settled one: `the-module-floor-claim-is-stale-and-directionally-wrong`.
>
> The floor reasons, as last derived (summing to ~68 against the 69 of that day, NOT to today's 91):
> 26 hold MODULE STATE on a specifier that is also REGISTERED
> (two live copies — `bsc graph impl set` refuses the write), 14 use `import.meta.glob`, 10 are imported
> STATICALLY by `main.tsx`/`App.tsx`, 7 are type-only, 6 are algorithms seed modules whose node `code` is
> generated *from* the file, and one each for the entry, test setup, a `vite.config.ts` import, a record
> that won't compile as TSX, and one seed/file disagreement awaiting adjudication.
>
> **The module-state rule is narrower than it sounds**: state disqualifies only when something ELSE
> registers the same specifier. When the record is the only copy, state is fine — which is why the
> `graphPlatform.ts` registrars, long listed here as permanent floor, are all records now (and so is
> `componentLoader.ts`, the loader itself). Measure with `bsc graph harvest <f> --module` and read
> `moduleState`; it is never visible from a module's name.
> The paths below still describe where a module *belongs*; they no longer promise it is on disk. If you
> cannot find a module, it is a record: `bsc ui get <id>` / `bsc graph impl get <id>`, matched by its
> `provides` specifier.
> **Read [`docs/records.md`](docs/records.md) before retiring a file, authoring new UI, or wondering why
> a module you can see imported does not exist** — it carries the preconditions for deleting anything,
> and every one of them was learned by shipping the bug first. New UI is authored into the store, never
> as a new `.tsx`.
>
> Counts drift every tranche and a stale one is worse than none. Re-measure:
> `find src -name "*.ts" -o -name "*.tsx" | grep -vE "\.(test|spec)\." | wc -l`

### Records and the emitters — what compiles, and what to edit

**Most of the source is RECORDS, and every build input they feed is GENERATED.** The detail — what each
emitter reads and writes, what runs it, and the traps each one has cost — lives in the `bsc memory`
knowledge layer, where it is revised a section at a time rather than in this file:

```bash
bsc memory read emitters             # the index: what generates what, and the known traps
bsc memory read what-generates-what  # the four emitters, source → output → what runs it
bsc memory read graph                # the record store itself
```

`memory.db` is local to this machine, so the rules that break a build when missed stay here:

| generated output | edit this instead | regenerate with |
|---|---|---|
| Rust crate bodies (`$OUT_DIR/crate.rs`, 76 crates + `src-tauri`) | the record, in the committed store `graph/algorithms.db` | any cargo build |
| `.bsc-records/` — the retired frontend modules | the record (algorithms) or the component seed (`src-tauri/data/components/`) | `npm run emit:records` (the gate, `typecheck`, `build` and vite run it) |
| every `Cargo.toml` | its record in `graph/manifests/` | `npm run emit:manifests` |
| the react-ui kit (`react-ui.json` + its meta sidecar) | the component store | `UPDATE_KITS=1 npx vitest run reactUiKit`, then `bsc ui store sync --apply` |

- **The committed store is `graph/algorithms.db`**, named by `graph/store.toml`. Resolve it through that
  marker (`resolveStorePath` in `scripts/lib/recordStore.mjs`), never a hard-coded filename: opening a
  SQLite path that does not exist creates an empty file.
- **Write what the build compiles:** `bsc graph impl set --repo --root "$PWD" --tech <t> --id <id> --role
  algorithm --name <its current name> --code-file <file>`. Without `--repo` the write lands in the
  per-user runtime ledger the build ignores, and nothing says so. `--name` is required, and a wrong one
  silently renames the record.
- **Take the base from the committed store** (`graph/algorithms.db`), not from `bsc graph impl get`, which
  reads the runtime ledger and can be behind. After writing, diff the record's non-code fields.
- **A frontend record owes more writes**: the runtime ledger too, `bsc graph impl sync-seed <id> --seed-dir
  "$PWD/src-tauri/data/knowledge" --only code,tests --apply`, and the kit whenever the record — or a plain
  file — is in its runtime closure. `storesAgree` and `reactUiKit.1.test.ts` fail naming what is owed.
- **Generated manifests go stale** after a pull, a merge or `npm run promote`; only the gate, `npm install`
  and CI re-emit them. `cannot find crate`, or a `Cargo.lock` diff dropping a dependency nobody removed,
  means `npm run emit:manifests` (then `git checkout -- Cargo.lock`).
- **To add a crate, create its record**: `cargo run -p graph-materialize --bin sync-manifests -- new <crate>`,
  then `npm run emit:manifests`. Edit a manifest's record, never the generated file.
- **Record stores are binary in git** (`graph/*.db`). A conflict takes the other side whole
  (`git checkout --theirs`) and re-applies your writes with `impl set --repo`; a record's isolation is its
  LANE (`bsc graph lane …`, under the development workflow below).
- **A red `graph-promote-check` is usually not yours**: it compares the shared runtime store with the
  committed one and prints each drifted node's author and age.


The frontend is **feature-first vertical slices** — `app/` (shell) · `features/` (one folder per
feature) · `shared/` (feature-agnostic) · `store/`. There are no layer dirs (`components/`, `lib/`,
`hooks/`, `screens/`, `data/` are gone). Rules:

- **Page-structure vocabulary (#1878/#1879):** one word per level — the **Rail** switches
  **Workspaces**; a Workspace is composed of a **Screen** (the shared tabbed shell, `shared/ui/layouts/Screen.tsx`)
  that shows one **Page** at a time over a **PageTabs** strip (`usePageTabs` + `TabBar`). Rail
  destinations are `*Workspace` (`registry.ts` `Workspace` type + `activeWorkspace`); Settings sections
  are Pages (`features/settings/pages/*Page`). Console keeps its own nested **Tab → Pane → View**. Full
  convention: [`docs/frontend-structure.md`](docs/frontend-structure.md).
- **THE RAIL IS THE FIVE GRAPHS** (`epic-the-graphs-are-the-app`): **Console** (opt-in) · **Glance** ·
  **Components** · **Teams** · **Algorithms** · **Data** · **Sounds** · **Logs** · **Settings**. Each
  graph is a Workspace whose **PageTabs are its own axis** — Components and Algorithms by TECHNOLOGY
  (react/react-native; rust/typescript), Teams by TEAM, Sounds by KIT, Data by LANGUAGE.
  - **The tab is a LENS, not a partition.** Technology is a CURATION scope — it says who may WRITE a
    record (`studioScopeDirective` splits the designer and librarian per technology) and nothing about
    what may REFERENCE one. The cross-graph URN grammar makes that concrete: `@bsc/algorithms/fibonacci`
    is kit-less, so a React component resolves a TypeScript implementation across both pillar AND
    technology. A tab bar rendering technologies as disjoint worlds would assert in the chrome exactly
    the silo epic #3114 removed from the model. `algorithmsLens.test.ts` / `componentsLens.test.ts` are
    the guards: no tab selection may hide an edge the store holds.
  - **The PLANNER and GITHUB screens are gone**, and their functions are not. Planning is the
    director's job — the architect runs discovery with the user, then creates a director that completes
    the plan and designs its team — so the planner's 142 React-free modules, `src-tauri/src/planner`,
    the fleet and plan.db all remain, driven by `bsc plan` / `bsc publish` / `bsc fleet start`.
    Likewise `src-tauri/src/github` still runs publish and readiness, and Settings → GitHub is still
    where an account is connected. Whether a project uses GitHub at all is a DISCOVERY decision
    (`bsc plan classify`, `usesGithub`), not a guess from whether a token happens to be present.
- **A feature owns everything it needs:** `features/<x>/` holds the UI, a `lib/` of pure (React-free)
  domain logic, a `store.ts` (its Zustand slice + slice interface), colocated tests, and an `index.ts`
  barrel that is the feature's public API. **Cross-feature, import ONLY the barrel `@/features/<x>`** —
  never a deep internal path (`@/features/<x>/lib/*`, its components) — so a feature can refactor its
  internals freely. Need a symbol another feature reaches for? Re-export it from that feature's `index.ts`.
  Deep `@/features/<x>/lib/...` paths are for **intra-feature** imports only. `import type` across
  features stays allowed. Enforced by a per-feature `no-restricted-imports` lint rule (#1545) mirroring
  the `shared/` boundary (#1626); full convention: [`docs/frontend-structure.md`](docs/frontend-structure.md).
- **Path alias:** use `@/…` (→ `src/…`), never deep `../../..` relatives, so moves don't churn importers.
  (tsconfig `paths` + vite/vitest `resolve.alias`.)
- **app/ vs features/ vs shared/:** the shell (`app/`) knows every feature and composes them; features
  don't import `app/`. `shared/` is feature-agnostic (no feature imports). The **console** pane system +
  its state are the shell (`app/console/` + the core `console` store slice — the ~110-field core app
  state, navigation + hydration + tabs + panes), not a feature.
- **Store:** `store/index.ts` composes the slices; `AppStore` is `extends`-ed from each feature's slice
  interface. Per-feature slices live in `features/<x>/store.ts`; the core app state + labelled residuals
  (`console`, `core`, `shell`, `plan`, `projects`, `session`) remain under `store/slices/` — a candidate
  for further splitting later.
- **The planner's UI is deleted** (`delete-the-planner-ui-keep-the-planner`) — `Planning.tsx`,
  `ProjectPane.tsx` and the rest of the pitch-to-plan screen. `features/planner/` is now DOMAIN ONLY,
  and its barrel is too: eleven modules outside the feature import through it and #1545 lets them reach
  nothing else, so a UI export creeping back would pull React into the store's type graph and into
  Glance. If it imports react, it does not belong there.
- **Cross-repo contract fixtures** (`tunnelProtocol.fixtures.json`, `plannerCore.fixtures.json`) live in
  their feature's `lib/` but are byte-exact wire contracts ALSO consumed by the Rust tests and
  mobile-studio-code. The Rust tests resolve them **by filename** (`find_fixture` in
  `src-tauri/src/mobile/tunnel/mod.rs`), so moving a feature slice does **not** break Rust CI — but
  **renaming a fixture file** means updating the Rust `find_fixture("…")` call (and mobile-studio-code)
  in lockstep. (This is the one place Rust reaches into the frontend tree; everything else it reads is
  backend-owned — `src-tauri/data/`, `src-tauri/tests/`.) Colocating the fixture with its feature
  is **deliberate** (the feature owns its contract; #1335 weighed a shared `contracts/` dir and chose
  not to, since that fights feature-ownership) — so `find_fixture` requires **exactly one** name match
  under `src/` (it panics on zero or a name collision) rather than silently taking the first.

## Architecture

```
base-studio-code (desktop host)
├── Agent Orchestrator      — spawns/manages parallel agent sessions       (src-tauri/src/{console,session,fleet})
├── GitHub Integration      — OAuth + publish/readiness; NO screen (src-tauri/src/github, Settings)
├── Mobile relay client     — dials the Cloudflare relay for mobile pairing (src-tauri/src/mobile/tunnel)
└── UI Shell                — Tauri WebView running the React frontend
```

```
mobile-studio-code (standalone app — separate repo; usable on its own)
└── Relay client (optional) → tunnels into a desktop session via the relay
    └── Mirrors console grid view + basic input
```

## Key Concepts

**Skill** — A named, reusable markdown block (the **Skills library**, `src/features/skills/` + `crates/skilldb` + the `bsc skill` CLI) that supplies injectable context — standardized GitHub Actions configs, code review checklists, architecture patterns. Attached per blueprint/section and written into the session's `.claude/skills/`. This is the injectable-context system (it superseded the old Knowledge Base).

**Console** — A single agent session tied to a repo, model, and optional skills. Multiple consoles run in parallel within a tab.

**Pane** — The UI cell that renders one console. Each pane has a swappable view (console chat, file tree, branch list, diff, commit log) selected via icon tabs. Configuration is exposed via the hamburger menu (model, repo, cwd).

**Tab** — A named workspace containing one CSS grid layout with N panes. Persists across sessions.

**Tunnel** — The **optional** bridge between desktop and the standalone mobile app. Both peers dial out to a **zero-knowledge Cloudflare relay** (`relay/`); the desktop runs the relay client (`src-tauri/src/mobile/tunnel/`) and the session is end-to-end encrypted with **Noise IK** (the relay only ever sees ciphertext). Pairing is by QR.

**Automation** — A cron-triggered rule that automatically dispatches a command into a specified console pane.

## Project Planning

**There is no planner SCREEN, and no planner tier.** Planning is a three-tier funnel now — architect →
director → workers — and the responsibilities the planning session used to hold are split across it:

- **The architect** is the one session the user talks to. It runs **Discovery** with them, records the
  outcome as `bsc plan requirement` (`{ statement, discovery, authority }`) plus the classification
  (`bsc plan classify` — including **`usesGithub`**, the decision about whether this project ships to
  GitHub at all), and then **creates the director** (`bsc fleet director new`).
- **The director** completes the plan, designs its team, and executes: it publishes the GitHub structure
  when the project uses GitHub (`bsc publish run`), and launches the fleet (`bsc fleet start`).

What that leaves in the codebase: `features/planner/` is DOMAIN ONLY (no UI), `src-tauri/src/planner/`
still writes the workspaces (`setup_workspaces`), and `plan.db` is still the store everything reads
through `bsc plan`. The sections below describe the plan MODEL — stages, blueprints, issues, fleet —
which is intact and agent-driven; where they mention a screen, a pane or a card, that surface is gone
and the same data is reached with `bsc plan`.

### Blueprints — the library that seeds a plan
A **blueprint** is the reusable template that seeds a project's plan: ordered stages, each with a prompt
module, pipelines, a declarative gate, and attached skills. It is a curated **route for a domain**
(Default · CRM · ERP · Helpdesk/ITSM · HR/HCM · Project Management), and `projectBlueprintId` is
**frozen at creation** — there is no in-place switching. Reached with `bsc blueprint`.

> `bsc memory read project-planning-model` — blueprints, the frozen key, the hub layout, the workflow,
> per-agent permissions, and the planner-spec leak.

### The project key and the hub
A project's key is **`projectSlug(name)`** — lowercase `[a-z0-9-]`, capped 60 — and it is **frozen at
creation**. That one value names `projects/<key>/`, the plan store at `plans/<key>.db`,
`worktrees/<key>/…`, the pane ids and every app-state map key. Renaming is **display-only**; the folder
keeps its birth-slug.

**The asymmetry to remember: plans are CENTRAL, telemetry is PER-HUB.** The plan store is *not* in the
hub — it is `~/.base-studio-code/plans/<key>.db`, reached as `$BSC_PLAN_DB` / `bsc plan`, and it is the
**sole fleet store** (#1805). But `error.db` and `usage.db` *are* hub-local. Fleet worktrees live
**outside** the hub (#844) so the planner `CLAUDE.md` is not their ancestor.

### The planner is plan-only, and its spec leaks downward
Role gate #219: `git: read`, `github: read`, `code: none` — it reads for context and writes plan files,
but cannot edit project code, commit, push, or open PRs.

**A known trap worth knowing before you touch the hub:** the planner spec is written to
`projects/<key>/CLAUDE.md`, which is the **ancestor of every execution session**, since the director and
workers run under `projects/<key>/`. Claude Code loads `CLAUDE.md` from the cwd and every parent, so the
planner spec **leaks** into those sessions and pulls them toward planning. A `READ FIRST` scope guard is
the interim band-aid (#320/#331). Converge on the intended split when touching `setup_workspaces`, the
planning launch, or `fleetStartProject`.

> The six-step planning workflow, per-agent permissions (three scales — and `denyGlobs` is INVERTED),
> flows, and the intended architecture: **`bsc memory read project-planning-model`**.

## Console — the execution surface

Where the planned work runs. A **tab** holds a CSS-grid of **panes**; each pane is a PTY session running `claude` in a repo or worktree, with swappable **views** (console chat, files, branches, changes, log). Backend: `pty_create` in `console/pty/` (dir-module: `mod.rs` + `job.rs`); launch wiring: `src/app/console/panes/views/TerminalView.tsx` + `fleetStartProject` in `src/store/index.ts`.

### Session roles + the role gate (#219, `src/shared/lib/session/sessionRoles.ts`)
Every session has a role bounding its capabilities (least privilege), applied at launch via
`ensure_session_settings` to `.claude/settings.json`. Claude Code precedence is **deny > ask > allow**.

| Role | git | github | code |
|---|---|---|---|
| planner | read | read | none |
| worker | write | read | write (owned globs only) |
| director | write | write | none |
| triage | none | write | none |
| tester / reviewer | read | read | none |
| issuer | read | write | none |
| juror | read | read | none |
| documentor | read | read | none (prose docs only) |
| designer | none | none | none (UI kits via `bsc ui` only) |

> What each role is *for*, the permission postures (allow-list default vs bypass), and the opt-in WSL2
> OS sandbox with per-agent Linux users: **`bsc memory read console-and-fleet`**.

(`tester`/`reviewer` are the pipeline-stage roles, #220; `issuer` is intake-only — shapes a request into a GitHub issue and hands off, #376; `juror` independently judges a landing against its acceptance criteria, #394; `documentor` is the post-refactor lifecycle actor that reconciles the project's PROSE docs — CLAUDE.md structure tree, architecture docs, README — after a change lands, #1555. Like the director's commons carve-out (#851) it keeps `code: none` yet writes EXACTLY its `DOC_GLOBS` (markdown + `docs/**`) and is hard-blocked on every code path; push/PR are flow-governed. `designer` (#2471) is the Design Studio's UI-kit session — `none` on every axis, launched with `restrictedAllow` so the baseline command tiers are suppressed and its whole auto-runnable surface is `bsc ui` + the deprecated `bsc component` alias.) `roleDeniedCommands` denies the mutating git/gh commands a role cannot run; `roleWriteRules` denies/scopes the file-write tools. The session allows Bash broadly and guarantees `gh`/`git` on PATH; Claude Code precedence is **deny > ask > allow**. (**Permission postures** (#1916/#2050): the PreToolUse hooks — `bsc-deny` (dangerous floor + role/user denies), `bsc-confine` (FS confinement), `bsc-scope` (write-scope) — are the always-on floor, firing **and blocking under BOTH postures** (even bypass, where `permissions.deny` is ignored). The **default is the ALLOW-LIST** (#2050): Claude's `default` mode auto-runs the broad `base.json` allow-list (git/gh + the read-only inspection set + the mainstream build/test toolchains) and prompts for anything else — low-friction but safe. **Bypass** (sessions auto-run everything, hooks-only gating) is the opt-in power **posture toggle** (Settings → Security). On top, an opt-in **model-agnostic OS sandbox** (#1988): a session runs inside a **sealed WSL2 distro** (`bsc-agent-sandbox` — no `/mnt/c` mount, no Windows interop, baked into `/etc/wsl.conf`), so the cage is the *environment* and confines whatever LLM drives the session, not just Claude (`pty_create`'s opt-in `wsl_distro`; provision + readiness in Settings → Security; a Settings → Agents toggle launches consoles inside it). The rootfs bakes in **every** harness — Node + Claude Code (the default) and `gh` alongside `bsc-agent` (#4260) — so the cage isn't limited to the non-default harness. **Per-agent isolation via Linux users** is built (#1994/#4260): each sandboxed fleet session (worker + director) runs as its own `bsc-<slug>-<hash>` user with a `700` home holding its **own worktree**, created by that user off a group-shared clone; the hub, `plan.db`, `coord.log` and the global `bsc` stores live in one setgid `bsc-agents` dir (`/srv/bsc-shared`) that every agent home reaches via a `~/.base-studio-code` symlink — private code, shared agreement. The sandbox is **still opt-in**; making it the sole posture is #4260, gated on bundling the rootfs tarball with the installer.)

### A node's PERSONA — the field is `persona`, and it holds a library id

**Writing `profile` instead is SILENT** — the stream simply has no persona, and no tier to read. That
cost a full round-trip once, when a coordinator column could not work because its stream had no persona
at all. Only the fleet-STREAM path supplies a real library id; the director, the planner and system
sessions are given bare names that miss and fall through to `fallbackRole` / `SYSTEM_SESSION_ROLES`,
which are a compensation layer for an id-space mismatch, not a feature.

> That mismatch, the eight hardcoded fallbacks that duplicate `personas.db`, and the COORDINATOR tier
> (a peer of the director, derived from archetypes, belonging to no repo band):
> **`bsc memory read console-and-fleet`**.

### The fleet (`fleetStartProject`)
One click fills a build tab:
- **Director** at the project hub (`projects/<key>/`), kickoff `prompts/director-kickoff.md` — sees every repo + worktree; coordinates, never writes feature code.
- **Workers read from the STORES, not from copies (#4191).** `bsc` is in the always-allowed mandatory
  tier (`permissions/base.json`) and `worker` is a project role that never gets `restricted_allow`, so a
  worker can read every store directly: `bsc graph impl get` (algorithms), `bsc ui get` (components),
  `bsc plan` (this project's plan), `bsc files read`. The worker protocol states the precedence rule —
  **the store wins over anything quoted into the context**, which is assembled once at launch while the
  stores stay live. A feature's `requires` list is injected as ids + the fetch command, never as inlined
  source: a quoted body is a second copy, and the copy is what a worker edits while the record keeps the
  old one.
- **Workers** each in their own **git worktree** (`~/.base-studio-code/worktrees/<key>/<repo>--<slug>/`, outside the hub per #844) on a **branch named after the stream id**, seeded with `CLAUDE.local.md` (the plan, copied in by `ensure_worktree`) and the stream's kickoff (`prompts/<id>-kickoff.md`, else `buildStreamPrompt`). Per-agent profile + flow applied.

### Per-agent flow at launch (#297)
Drives which git/gh writes auto-approve vs **prompt** vs deny, the autonomy + push paragraph in the
kickoff, and a coordination wake when a checkpoint/confirm agent pauses. The flow's push policy is the
**authority** over `git push` / `gh pr create` and lifts the role gate's broad gh-write deny for exactly
those two (#304) — so an `auto-pr` worker opens its own PR while `gh pr merge` stays role-denied.

### Coordination + the runtime `bsc` surface
Agents emit structured events to an app-wide `coord.log` (`bsc-wait`, `bsc-ask`/`bsc-answer`,
`bsc-issue`/`bsc-assign`, `bsc-brief`, and the `bsc-landed/merged/closed/failed` completions), and the
**Coordination inbox** surfaces paused / blocked / ready sessions. **Runtime dependency-wait was removed
(#1039)** — `dependsOn` is a *planning-time* hint only; workers never park on an upstream.

The pure-shell helpers are installed into every session via `BASH_ENV` to `bsc-env.sh`. **WARNING: each
rc constant must end with a trailing newline**, or the concatenated shell functions glue together and
the whole rc breaks with a syntax error (#296) — `full_bsc_rc_is_syntactically_valid_bash` guards it.

**Every persistent app store is reachable from a live session through the one bundled `bsc` binary**
(#1877), execed by absolute path from `$BSC_BIN`: `plan` · `skill` · `data` · `logs` · `compliance` ·
`blueprint` · `persona` · `teams` · `project` · `say` · `ear` · `files`, plus `bsc mcp research` /
`bsc mcp compliance`.

> The full event list, the helper roster and every subcommand's scope:
> **`bsc memory read console-and-fleet`**.

### The voice loop — it speaks, it listens, and none of it leaves the machine

`bsc say` (speech out) and `bsc ear` (speech in) are the two halves. Three maintainer decisions are
**settled — do not relitigate them**: fully local always, always-on rather than push-to-talk or a wake
word, and a short rolling audio window.

> The measured numbers (Vulkan takes Whisper from 2.4× to 37.7× realtime), the four audio traps, and
> what arousal does and does not claim: **`bsc memory read voice`**.

### GitHub-readiness (#297 S1)
- **GitHub-readiness probe**: on launch each claude-launching pane probes `gh`/`git` on PATH + `gh auth`; if not ready it shows a dismissible amber banner in the pane so the gap surfaces before the agent hits it mid-task.

### Triage
A per-repo session that resumes the repo's prior conversation (`claude --continue`) with `prompts/<repo>-triage.md`, to work the repo's open issues by priority.

## Roadmap & Release Process

**Current version: `1.0.52`** — accessibility & text-to-speech · market research, marketing & usage
analytics. A version here is a **living milestone**: released early, then kept building on until its
theme is complete, so it reads **Current** rather than Shipped. Exactly one version is Current at a
time. GitHub milestones track **versions, nothing else**; new work defaults to the Current milestone,
parked work goes to **Backlog**.

The pre-v2 numbering is **deliberately loose** and is an intentional trade for velocity — **do not
"fix" it or relitigate the scheme.** `2.0.0` is the hand-off point to rigorous semver.

`npm run release` does the whole cut (bump both version files · stamp the CHANGELOG · commit · tag ·
push). It is a **maintainer action, not a step in the worker loop** — nothing else here pushes.

> The version cycle, the milestone rules, the three versioning phases, the release command's flags and
> the version-by-version history: **`bsc memory read studio-code-roadmap`**. Full breakdown in
> [ROADMAP.md](ROADMAP.md).

## Development Workflow — local-first, on the `bsc` surface

> **This section SPECIALIZES the global `~/.claude/CLAUDE.md` workflow for this repository.** The global
> is already local-first — it tracks work in the project's own store, integrates by local merge, and
> requires explicit approval before any push or hosted-tracker write. This file supplies the two things
> it deliberately leaves to the project, and hardens one rule:
>
> - **The store is named**: `plan.db` via `bsc plan` (items) and `bsc plan change` (changes).
> - **The gate is named**: the exact commands under *Verify*, below.
> - **Approval becomes silence.** The global permits a `gh` write once approved; here there are **none** —
>   no issues, no PRs, no pushed branches. Every migrated item keeps its origin number as a back-link, and
>   that back-link is the only thing that should ever reconcile. Reads stay free, as they do globally.
> - **A missing capability is filed, not improvised.** Reaching for a throwaway script is the signal to
>   file a `bsc request` instead — see *A temporary script is a missing `bsc` command*, below.
>
> Everything else in the global file applies unchanged.

### Where the work lives

The project's own plan store — `~/.base-studio-code/plans/studio-code.db`, reached with the
bundled `bsc` binary:

```bash
export BSC_PLAN_DB="$HOME/.base-studio-code/plans/studio-code.db"

bsc plan list                      # the board
bsc plan list --status open        # what's available
bsc plan get <ref>                 # one item: body + acceptance criteria
bsc plan status <ref> <status>     # open → in_progress → complete → verified
```

> **It used to be `base-studio-code.db`, and that store is RETIRED.** `base-studio-code` was both a
> *repo of* the `studio-code` project and a separate project with its own plan store, so which one an
> item belonged in was a coin flip — and the two drifted. Everything (issues, change records and the
> lessons, which existed only there) was migrated into `studio-code.db` on 2026-08-17; see
> `migrate-the-legacy-base-studio-code-plan-store`. **There is one board now.** If you find yourself
> reaching for the old path, that is the habit this note exists to break.

This is the same surface a fleet worker already uses, so there is one way to read the plan whether a
human or an agent is driving. `bsc plan` is in the always-allowed mandatory tier, so no session needs
a permission grant to reach it.

#### The standing focus

**`epic-command-surfaces-are-nodes` is the focus for the remainder of this application's development**
(maintainer, 2026-08-17). When nothing else is explicitly claimed, take the next open slice from that
epic. `bsc plan get epic-command-surfaces-are-nodes` is the source of truth for what it covers and for
the decisions already taken — read it there rather than looking for a design doc, because the feature
is deliberately not written up yet.

It carries **no milestone on purpose**: it outlives `1.0.52` rather than fitting inside it. Do not file
it under the current version, and do not read that version's completion as this epic's.

The direction attached to it is **get it working, then improve with measurement**. A slice is not
blocked on an unresolved optimization question — record the question on the item and keep moving.

The issue says what to DO; the **change** (`bsc plan change`, below) says what was DONE. Both live in
this same store, keyed by the same ref — so one name reaches the issue, the branch, the worktree and
the change. **Every slice gets both.** An item worked without a change record leaves no gate evidence,
no reviewer verdict, and no notes, which is the state this repo was in before the change table existed.

Every migrated item keeps its old GitHub number in `ghNumber` as a **silent back-link** — the trail
survives and a future `bsc plan sync` can reconcile, but nothing writes to GitHub in the meantime.

### The branch is TWO things now — a git branch and a LANE

Records are **93% of this source** (1,731 records against 124 files), and they no longer live in git.
They live in the record ledger (`~/.base-studio-code/knowledge/graph.db`,
`epic-retire-json-ledgers-for-db-and-git-drivers`), so a work item needs isolation in **both** places:

```
<ref>  →  a git BRANCH   for the 124 files, the manifests, the scripts, the docs
<ref>  →  a LANE         for the records — everything the crates and the app compile from
```

**Same name for both**, which keeps the rule that one ref reaches the plan row, the branch, the
worktree and now the lane. A session binds its lane with `$BSC_GRAPH_LANE`, set at launch exactly as
`$BSC_PLAN_DB` and `$BSC_AUDIT_PANE` already are — a worker does not have to remember which lane it is
in, for the same reason it does not have to remember which plan store it writes.

**GIT BRANCHES NEVER ISOLATED RECORDS**, and that is worth being clear about rather than presenting
lanes as a loss. Every worktree has always shared one runtime store; the 304 drifted records were nine
sessions writing one file, and `graph-promote-check` existed only to police the gap between that and
the per-worktree committed copy. Lanes are the first isolation records have ever had.

**A lane is COPY-ON-WRITE and costs almost nothing.** It holds rows only for records it writes;
everything else reads through to `main`. MEASURED over this repo's last 40 merges, a slice touches a
**median of 4 records** — so a lane is four rows against 2,529, and "does branching duplicate the
store" answers itself.

```bash
bsc graph lane list                      # every lane, and which one you are bound to
bsc graph lane diff                      # what your lane changed, and whether main moved under it
bsc graph lane conflicts                 # the records main moved under — base/ours/theirs, by id
bsc graph lane rebase <id>               # "I have looked at both sides; mine still stands"
bsc graph lane land                      # dry by default
bsc graph lane land --apply              # applies the WHOLE lane to main in one transaction
```

**A conflict is one RECORD, not a file.** `lane wrote x.rs from main rev 5, main is at rev 7` — base,
ours and theirs are all three still in the ledger, so resolving is a decision you can see rather than a
merge you have to referee. Two lanes touching different records both land clean, which is the property
the whole migration exists for.

**Landing is all-or-nothing.** One contested record blocks the whole lane and applies nothing — half a
slice on main is a state nobody asked for and nobody is watching. Landing does not delete the lane
either: what was landed and from where stays answerable afterwards.

**What this REMOVES.** `bsc graph promote` (runtime→repo), `bsc graph reseed` (seed→runtime),
`graph-promote-check` (a whole gate leg that existed only to police drift), `bsc graph store
split|merge`, "a record edit is four writes", and the 304-record drift — structurally, not by
discipline.

### Branch strategy — one branch per work item, 1:1

```
<ref>  →  develop
```

The branch name **IS** the issue's `ref`. One ref, one branch, one worktree, one worker — so a
worker's plan row, its branch, and its working tree are all reachable from a single name. Migrated
refs carry their origin number (`4260-sandbox-by-default-…`), which is exactly the branch convention
this repo already used; new items pick a descriptive slug.

- Cut from the `develop` REF (it is checked out in `wt-integrate`, not at the root). Never commit on
  `develop` or `main` directly, and never merge at the ROOT — that is the app's tree.
- Keep branches short-lived and scoped to the minimum change that satisfies the item.
- **Do not push.** The branch is local. Integration is a local merge into `develop` once verified.

### Item → branch → verify flow

1. **Claim** the item: `bsc plan get <ref>` and confirm its acceptance criteria before writing code.
2. **Branch** on its ref: `git worktree add wt-<short> -b <ref> develop`, and
   `bsc plan status <ref> in_progress`.
3. **Open the change**: `bsc plan change new <ref> --note "<title>" --description "<what and why>"` —
   at the START, not the end, because the notes only have value while the reasoning is live.
4. **Implement** the minimum change, **with its tests in the same branch** (never after). As you go,
   `bsc plan change note <ref> "<what you learned>" --from <you>` for anything a future reader would
   otherwise have to rediscover — a trap, a false lead, a decision and its reason.
5. **Gate** — every command below must pass (unchanged; see *Verify* under Parallel worktree agents) —
   and record what each one **actually did**: `bsc plan change gate <ref> typecheck pass`. A gate you
   skipped is recorded as skipped, not omitted.
6. **Complete**: `bsc plan status <ref> complete` — the worker's half is done.
7. **Verify**: whoever reviews confirms the acceptance criteria and moves it to `verified`, then
   merges the branch into `develop` locally, and stamps the change:
   `bsc plan change status <ref> merged --command <merge-sha> --from <reviewer>`.
   `complete` ≠ done; `verified` is done.

`complete` and `verified` are deliberately distinct, and it is the same split the fleet already runs:
the actor who did the work is not the actor who confirms it. Collapsing them would mean a change is
"done" on the word of the thing that wrote it.

### The change record — the local PR

The issue says what to do; the **change** says what was done. It lives in the same `plan.db`, keyed by
the same ref, so one name reaches the issue, the branch, the worktree and the change:

```bash
bsc plan change new <ref> --note "<title>" --description "<what and why>"
bsc plan change note <ref> "<a work note>" --from <author>   # append-only, WHILE the reasoning is live
bsc plan change gate <ref> typecheck pass                    # what the gate actually observed
bsc plan change status <ref> merged --command <merge-sha> --from <reviewer>
bsc plan change render <ref>                                 # markdown: PR body when synced · CHANGELOG entry at release
```

> **CHECK THE EXIT STATUS of every `change` write.** These are the only commands whose failure costs
> you something you cannot see: a failed `change note` writes nothing and the commit still lands, so
> the slice looks finished and the record is simply absent. `bsc` exits non-zero correctly — the
> 2026-08-16 loss happened because the calls were written as `… >/dev/null` in a list, so nothing ever
> read `$?`. Chain them with `&&`, or check explicitly. Do NOT redirect stderr away.

It deliberately does **not** duplicate git: `head_sha`/`merge_sha` are the join to real history and the
commit messages stay the narrative. What it holds is what git cannot — gate evidence recorded when the
gate ran, the reviewer's verdict as an actor distinct from the author, notes written before the
reasoning evaporates, and (once connected) the GitHub identity via `bsc plan change link`, the same
nullable-identity pattern `bsc plan link` uses for issues. **A NULL `ghNumber` is what says a change
still needs a PR.** Nothing here writes to GitHub.

Two rules the implementation enforces rather than trusts:
- **Notes are append-only.** There is no verb that can drop an earlier one.
- **`Closes:` is never fabricated.** A change defaults to the issue of the same name *only if that
  issue exists*; a conversational slice with no plan item records no link rather than a dangling one.

Because `render` is the single source for both the PR body and the changelog entry, neither is
maintained separately from the work — which is why `CHANGELOG.md` kept drifting behind `develop`.

### Capturing what a session learns — `bsc memory`

The change record says what a slice DID; `bsc memory` catches what a session LEARNED but has no plan
item for — a finding, a decision and its reason, a lesson, a trap, a parked thread. Those used to
evaporate when the terminal closed. Capture is the habit this surface exists to make cheap, so **write
the thought down when you have it**, not later when the reasoning is gone.

It is a TYPED GRAPH, not a flat pile. Two facets carry the weight:

- **`horizon`** — `now` (applies to what is ALREADY IMPLEMENTED: a fact, a lesson, an applicable fix)
  vs `future` (a forward-looking idea or hope, NOT yet real). Default is `now`; `--future` opts in.
  This keeps "what we KNOW about a record" from muddling with "what we DREAM for it".
- **typed links** `{ref, rel}` — an edge to another memory, a graph record id, a symbol anchor
  (`bsc-disk--sweep.rs#DEFAULT_DAYS`), or a plan ref. `rel` is a free string so the vocabulary grows
  from use: `about` · `because` · `supersedes` · `contradicts` · `lesson-of` · `blocks` · `todo-for`
  (`related` when unstated).

```bash
bsc memory add "<thought>" --tag <a,b> [--link rel:ref,rel:ref] [--future]   # capture
bsc memory list --tag <t>                          # newest-first; also --status/--rel/--horizon/--json
bsc memory link <id> <rel> <ref> [<ref>...]        # add a typed edge to related refs
bsc memory neighbors <id>                          # traverse: edges out, and the ones pointing back
bsc memory horizon <id> now|future                 # reclassify
bsc memory done <id>                               # once acted on or folded elsewhere
```

It is a USER store (`memory.db`), local, in the always-allowed `bsc` tier — any session reaches it
without a grant. The records are now method-first, so a memory's edges point AT that id space; the
`neighbors` view is why memory is a graph you traverse rather than a pile you scroll. (Distinct from
`bsc cost`, the resource-cost surface that used to be `bsc mem`.)

### GitHub stays silent

Reads are fine (`gh issue list`, `gh api` GET) — they are how the eventual sync learns about drift.
**Writes are not**: no `gh issue create/close/edit`, no `gh pr create/merge`, no `git push`. If a
change genuinely needs to reach GitHub, that is a decision for the maintainer, not a step in this
loop.

### A temporary script is a missing `bsc` command — file it, don't write it

**When you catch yourself about to write a throwaway script — python, node, shell, `jq`, anything —
stop and file a request against the `bsc` surface instead.** The need for the script IS the finding:
it says a capability this system should expose is not exposed, and the script is a private workaround
that hides that fact.

```bash
bsc request new "<what you needed and could not do>" \
  --cmd "<the exact command that failed, or the script you were about to write>" \
  --surface "<the bsc noun it belongs to>" --title "<a few words>"
```

`--cmd` is the part that matters — pass the pipeline or the script you were reaching for, verbatim.
A request is **observed, not narrated**, and the session that closes it needs to see what you actually
tried. `--title` labels the request's node in the Glance graph, so a good one keeps the queue readable.

`--from` is the one flag whose right answer differs here from the app's own charters. Origin resolves
`--from` first, then `$BSC_AUDIT_PANE`, and records **absent** rather than guessing (`resolve_origin`,
`crates/bsc-request/src/cli.rs`). A session running in an app pane carries that variable, so its charter
tells it never to pass `--from` — the stamp is what hangs the request off its node in the graph. A dev
session in this checkout is **not** an app pane and carries no such variable, so pass `--from <who is
driving>` or the request lands unattributed.

**Filing never blocks you.** `bsc request new` prints an id and returns. Do not wait for it, do not
poll it, and do not stop working because a capability is missing — route around the gap with what the
surface *can* do, and say in your report both what you did and what you filed.

**Why this is a rule and not a preference.** Three things, and the last is the one that bites:

- **The permission tier.** `src-tauri/data/permissions/base.json` puts `bsc` (with `git` and `gh`) in
  the 3-command **mandatory** tier — auto-runnable by *every* role, no grant needed — while `node` and
  `python` sit in the 50-command **build** tier. A capability that lives in a script is reachable by
  the sessions least likely to hold that tier, and is flatly unreachable by an allow-list studio
  session whose entire surface is one `bsc` noun.
- **Discoverability.** `bsc help` advertises its nouns. `scripts/` advertises nothing — it is found by
  `ls`, which is not a surface. That directory already holds **79** files for exactly this reason, and
  `record-operations-belong-on-the-bsc-surface-not-in-scripts` exists to move the ~15 of them that
  encode operations back onto `bsc`. Do not grow that backlog.
- **The script does not survive, and the problem does.** A temp script is deleted with the worktree,
  so the next session hits the same wall and writes it again. Nothing accumulates, and no measurement
  of how often the wall is hit ever exists. A filed request is a durable, countable record of a real
  gap.

**Where the line is, drawn explicitly so the rule stays usable.** The trigger is authoring a *program
that performs an operation* — a `.py`/`.mjs`/`.sh` file, or a heredoc piped into an interpreter, that
transforms, migrates, promotes, repairs or generates something. It is **not**:

- **Reading.** A one-off `grep`/`jq`/`wc` pipeline to answer a question you have right now is
  ordinary inspection. Look freely; the rule is about operations, not about eyes.
- **The build tree.** `scripts/gate*`, `gc`, `release`, `emit-records`, `stage-sidecar` and their kin
  are npm's job and run in CI. They are not agent surface and they stay where they are; which scripts
  move to `bsc` and which stay npm's is enumerated on
  `record-operations-belong-on-the-bsc-surface-not-in-scripts`.
- **A test.** A test is not a temp script; it is the deliverable, and it ships on the branch.

**A studio session already lives by this rule** — the architect, designer, librarian and sound-designer
charters all carry it, and their shells enforce it by refusing anything off the allow-list. A dev
session in this repo holds the full build tier and so hits no wall at all, which is precisely why the
rule has to be a deliberate choice here rather than a description of a refusal.

> **A fleet session files on a different queue.** A **worker** is denied the global tooling queue on
> purpose and files `bsc plan request new "<what you need>" --command "<the cmd>"`, which its
> **director** closes — and the director is the only session that escalates a genuine base-studio-code
> tooling gap onward with `bsc request new`. Do not flatten that lane; a worker's ask belongs to its
> director.

### Parallel worktree agents

Independent items are worked **concurrently**, each by an agent in its own **git worktree** so
parallel file edits never collide. One item = one ref = one branch = one worktree = one agent; that
1:1 chain is what makes a worker's state answerable from a single name. Every worktree agent runs the
same lifecycle — the commands below are the full set it needs end to end.

**1 · Get a worktree** — the branch is the item's `ref` (1:1), cut from local `develop`. **Reuse a free
`wt-*` before creating a new one**; a free one already holds a warm `target/`, and that is worth about
two minutes (see *Recycle, don't recreate* below):
```bash
bsc plan get <ref>                                   # confirm the acceptance criteria FIRST
bsc plan status <ref> in_progress

# preferred — recycle a worktree whose item already landed
cd wt-<short> && git checkout -B <ref> develop

# only when none is free
git worktree add wt-<short> -b <ref> develop
```
Cut from **local `develop`**, not `origin/develop`: nothing is pushed any more, so integrations land
locally and the remote drifts behind on purpose. `.claude/worktrees/` is write-denied mid-session,
so worktrees go at the repo root as `wt-<short>` (still nested ⇒ still zero-install, see below).

**`node_modules` — nested worktrees need NO install.** A worktree created *nested under the repo
root* (the convention: `wt-<short>/`) resolves every dependency from the repo-root
`node_modules` via Node/npm's normal upward directory walk — `tsc`, `vitest`, `eslint`, and the app's
imports all find it, and `npm run <script>` prepends every ancestor `node_modules/.bin` to PATH. So a
nested worktree is **zero-install**: 0 MB, 0 install time, and **safe to delete** (no local
`node_modules`, no junction → `git worktree remove` cannot wipe the shared install). This is enabled by
`server.fs.strict: false` in `vitest.config.ts`, which lets the install-free worktree read esbuild-wasm
from the shared ancestor `node_modules` (#1669).

> Two exceptions still need a **real** `npm install` in the worktree:
> - A **sibling / out-of-repo** worktree (e.g. `../bsc-1474-planning`) — it is not on the repo-root
>   resolution path.
> - You need `npx vite build` (the optional gate step) — Vite's dep pre-bundling wants deps physically
>   present; `typecheck` / `lint` / `test` do not.
>
> **NEVER** share `node_modules` via a junction/symlink: the junction breaks esbuild (wasm fs-deny) and
> `git worktree remove` follows it and wipes the main install. Use the nested zero-install pattern (or a
> real install), never a link.

**2 · Open the change record** — the local PR, at the START of the work:
```bash
bsc plan change new <ref> --note "<title>" --description "<what and why>"
```

**3 · Implement** the minimum change to satisfy the item, **with its tests in the same branch** (never after).
As you go, append what a future reader would otherwise have to rediscover — a trap, a false lead, a
decision and the reason for it:
```bash
bsc plan change note <ref> "<what you learned>" --from <you>
```
A note is worth writing WHILE the reasoning is live; reconstructed afterwards it loses the only part
that mattered.

**4 · Verify — the gate. TWO TIERS: scoped while you iterate, FULL before it merges.**

**Run it as `bsc work gate`, not `npm run gate`.** It streams the real gate through untouched and then
records EACH LEG on this branch's change record from the gate's own machine-readable verdict — so the
record is EVIDENCE the gate ran rather than a claim that it did. Recording by hand made it a claim:
measured over five slices in one session, ~25 results were read off a terminal and retyped, and
nothing checked them. It takes the ref from the BRANCH, which is why the 1:1 branch rule matters.

```bash
bsc work gate             # scoped, and records every leg
bsc work gate --full      # what step 7 runs
npm run gate              # the same gate, recording nothing
npm run gate -- --full    # what step 7 runs; also `npm run gate:full`
```

`npm run gate` computes the scope and **prints it before running anything**: Rust goes to the changed
crates plus their transitive dependents (from `cargo metadata`, never a guess), the frontend uses
`vitest run --changed` (module-graph *affected* tests, not filename matching) and `eslint` on the
changed files. `tsc --noEmit` always runs unscoped — it is a whole-program check, so "just the changed
files" is not something it can do, and at 18.7s it is cheap enough to always pay.

**The scoped tier is for ITERATING, and the full one is not optional.** This repo's recurring failure is
not a gate that fails wrongly — it is a gate that **passes while covering less than the reader assumes**:
`tsc`+`lint`+`vitest` all green with a live Worker deleted (only `vite build` saw it); retiring one file
orphaned ten stylesheets with every gate green; twelve pages rendering records that had silently diverged
from their files; a vitest config change that dropped 8 test files and reported all-passing. Narrowing
the per-commit gate is defensible **only** because step 7 still runs the unscoped one before anything
lands — and because the narrowing is printed rather than silent.

**A SCOPED GATE THAT RESOLVES TO ZERO LEGS STILL PRINTS `gate passed`.** Measured 2026-09-03 on a
markdown-only change: `rust crates: (none), frontend files: 0`, 0 legs recorded, exit green — while
three of the changed docs ARE read by tests (`docLinks.test.ts`, `architectDocs.test.ts`,
`plannerOrphans.test.ts`). So a doc edit that breaks a doc-reading test lands green. Until
`an-e2e-only-change-gets-a-gate-that-runs-nothing` is fixed, read the printed scope: if it says it
ran nothing, it verified nothing, and you should name the affected tests yourself.

**Do not expect a uniform speedup — the scope is the honest answer, not a discount.** Measured
transitive dependents: `crates/bsc-ui` reaches 2 crates, `crates/data` 11, `src-tauri` 1, and
`crates/bsc-util` **36 of 40** — so touching a shared util legitimately runs nearly everything. That is
the scope being *right*.

Changes to `Cargo.toml` (the workspace one), `.cargo/config.toml`, `vitest.config.ts`,
`vitest.excludes.ts`, `eslint.config.js`, `tsconfig.json`, `package.json` or `rust-toolchain.toml` force
the FULL gate — each can change the result for files it does not contain. A crate's *own* `Cargo.toml`
is scoped normally.

The underlying commands, if you need one directly:
```bash
# Frontend (run when src/ changed)
npm run typecheck                                   # tsc --noEmit, must be clean
npm run lint                                        # eslint, 0 errors (react-compiler rules tsc/test miss)
npm test                                            # vitest run — all green
npx vite build                                      # optional: production bundle still builds

# Rust (run when src-tauri/ or crates/ changed)
cargo check --workspace
cargo clippy --workspace --all-targets -- -D warnings   # --all-targets — --lib misses test-target lints
cargo nextest run --workspace                           # or `-p <crate>` to scope a slow build
```

**`cargo nextest`, not `cargo test` — and it must be installed** (`cargo install cargo-nextest
--locked`). `cargo test` runs the workspace's ~41 test binaries serially, so cores idle.

Two differences that will surprise you:

- **It runs each test in its own PROCESS.** That makes env-var tests *more* isolated — but the isolation
  **cuts both ways, and this direction is dangerous**: a test that PASSES under nextest can still FAIL
  under `cargo test`, because per-process isolation *hides* a race on process-global state rather than
  fixing it, and **the gate runs nextest, so the gate cannot see this class at all**. The mechanism is a
  lock (`ENV_LOCK` in `src-tauri/src/testutil.rs`); the guard is a SOURCE-ASSERTING test
  (`every_store_env_mutation_is_inside_the_store_lock`), because nothing at run time can observe the
  *absence* of a lock. An unlocked store-env write corrupts the real per-user authoring copy.
- **It does not run doctests.** This workspace has none, and `no_rust_doctests_are_silently_skipped`
  FAILS if one is ever added. If it fires, drop the doctest or add `cargo test --doc --workspace` —
  **do not delete the guard.**

**Install `sccache` before your first build.** `.cargo/config.toml` sets it as `rustc-wrapper`, so cargo
fails loudly with *"could not execute process sccache"* if it is missing (`cargo install sccache
--locked`; it must land on PATH). A shared `CARGO_TARGET_DIR` was rejected instead — it broke tauri
builds and puts every concurrent cargo behind one lock.

**Iterate against the CRATE, not the binary:** `cargo check -p <crate>` while writing, `cargo test -p
<crate> --lib` to verify, and build `bsc` only when you need to *run* it. Every subcommand crate exposes
`cli::run(args, prog)`, so a crate's own tests reach the whole surface without linking the binary.
**DuckDB is the dividing line** for what a crate costs — `bsc-graph`, `bsc-ui`, `bsc-files`,
`bsc-component` and `bsc-cad` deliberately avoid it (`bsc-data` with `default-features = false`).
**Keep it that way:** re-adding the default feature puts the whole DuckDB amalgamation back into their
iteration loop (measured: `cargo check -p bsc-ui` 2m28s → 20.8s).

> The measured tables behind all of the above — nextest quiet-vs-busy, the per-crate timings, the
> sccache hit rate: **`bsc memory read build-cost-measurements`**.

Record what each gate ACTUALLY did, as it runs — evidence, not a claim:
```bash
bsc plan change gate <ref> typecheck pass
bsc plan change gate <ref> test not-run              # a skipped gate is recorded as skipped, never omitted
```

#### An invariant you can name is a GATE YOU OWE

**If you fixed something by hand and can state the rule it broke, write the gate before you close the
item.** A fix repairs one instance; the gate is what stops the next one. Taking that opportunity is the
default here, not an optional extra — say so on the change record when you decline it, and why.

This is not a style preference. **This repo's signature failure is a gate that PASSES while covering
less than the reader assumes**, and every instance was an invariant somebody knew and nobody encoded: a
live Worker deleted with `tsc`+`lint`+`vitest` all green (only `vite build` saw it), one retired file
orphaning ten stylesheets, twelve pages rendering records that had silently diverged from their files, a
`vitest.config.ts` change that dropped 8 test files and reported all-passing, and the `shared/` boundary
lint that quietly stopped covering most of the frontend as records replaced files (#181).

**The bar is that the guard must FAIL against the old code.** Revert the fix, watch it go red, restore.
A guard that has only ever been observed passing is not evidence — it is a claim. Caged, sidecar and
trait-default tests are the usual way this goes wrong: they pass in milliseconds while the bug is live.
Checksum the restore rather than trusting the copy.

**Where a gate can actually live**, cheapest first:

| the invariant is about | put it |
|---|---|
| one function's behaviour | a `#[test]` / `it()` beside it |
| a rule over the whole tree | a `scripts/<name>.mjs` + its `.test.ts`, wired as a gate leg |
| a record, not a file | vitest reading the store — `platformBoundary.test.ts` is the precedent |
| a shape the type system can hold | a type, which needs no gate at all |

**A red that is noisy, racy or hard to action is a reason to IMPROVE THE REPORT, never to stop asking the
question.** Demoting a gate deletes the only signal that the thing it watches has broken. Make it name
what it found and who owns it — `graph-promote-check` compares a git-tracked file against a runtime
store every concurrent session writes to, so its red is often live authoring rather than stale drift; it
now prints each drifted node's author and age, and warns off a promote when the edit is minutes old.
That turned an unowned standing red into a line you can act on in seconds. **Whether a gate should stop
failing the build is a MAINTAINER decision, not a branch's** — record the case on the item and leave the
leg alone.

#### Six sharp edges that are not obvious and cost real time

- **Never `cargo fmt`.** There is no `rustfmt.toml`, no fmt gate leg, and lines run to 142 chars. It
  reformats hundreds of files you did not touch and buries your change.
- **Never a bare `git stash`.** The stash is REPO-GLOBAL, shared across every worktree — a `pop` here
  can take another session's entry. Commit to your branch instead.
- **`/tmp` is a 16G tmpfs that runs full, and it is shared.** Use `TMPDIR=/var/tmp/bsc-run` for
  anything big, and never keep the only copy of something there.
- **Never hand-merge `develop` into `main`.** A `--no-ff` merge commit on `main` breaks EVERY future
  `npm run promote`, permanently — promote fast-forwards, and refuses once `main` has a commit
  `develop` does not. Use `npm run promote`; if it refuses, that refusal is the signal, not the obstacle.
- **Single-quote the text of a `bsc plan change note`.** Backticks in a double-quoted shell string are
  command substitution, so the shell eats them before `bsc` sees them — and notes are APPEND-ONLY, so
  the loss cannot be repaired. Check the exit status too: a failed `note` writes nothing while the
  commit still lands, so the slice looks finished and the record is simply absent.
- **`node --check <file>` to see whether a script parses — never `import()` it.** An `import()`
  EXECUTES the module. Doing that to a script with top-level side effects once moved `main` by 66
  commits.

**5 · Commit** on the branch — **never push**. End the message with the agreed `Co-Authored-By:` trailer.

**6 · Mark it complete** — the worker's half is done, awaiting confirmation:
```bash
bsc plan status <ref> complete
```
Stop here. `complete` means "I did my part", not "this is done". The actor that wrote the change does
not get to declare it correct — and do NOT stamp the change `merged` or fill in `--from <reviewer>`
yourself, for the same reason.

**7 · Verify + integrate** (the reviewing actor, not the one who implemented): confirm each acceptance
criterion from `bsc plan get <ref>`, then
```bash
npm run gate -- --full                               # the UNSCOPED gate — the scoped one is not enough to land on
bsc plan status <ref> verified
bsc plan integrate <ref> --dir wt-integrate          # into develop THERE — never at the root, which
                                                     # runs the app; NEVER pipe this into a chain
bsc plan change status <ref> merged --command <merge-sha> --from <reviewer>

cd wt-<short> && git checkout -B <next-ref> develop  # RECYCLE it — see below; keeps the warm target/
git branch -d <ref>                                  # fails while the branch is checked out in a worktree
```
**Use `bsc plan integrate`, not a bare `git merge`, for this step** (request #185): `wt-integrate` is
ONE shared working tree, and two sessions running `git merge --no-ff` there at the same moment race
each other's git state — one session's in-progress conflict resolution becomes visible, mid-resolution,
to `git status` in the other. `bsc plan integrate <ref> --dir wt-integrate` wraps the same merge with a
named lock (`~/.base-studio-code/locks/`) so a second caller waits its turn instead of touching a
half-resolved merge. A clean merge releases the lock itself; a REAL conflict leaks it on purpose (a
human resolves it across several separate commands, long after this call returns) — resolve by hand
exactly as you would with a bare `git merge`, then free the tree for the next session with
`bsc plan integrate --release --dir wt-integrate`.

Verify the merge landed **before** deleting anything — a failed merge followed by a branch delete
destroys the work, which is why these are separate commands and never `&&`-chained. With no next item
queued, leave the worktree parked on `develop` (`git checkout -B parked-<short> develop`) rather than
removing it — a parked worktree is a warm `target/` waiting for the next claim.

**Recycle, don't recreate.** A worktree's `target/` is the expensive part and `git worktree remove`
throws it away — point the existing worktree at the next ref instead (measured: **1m59s** cold vs
**0.41s** recycled). **The one exception:** a branch that edits `Cargo.toml` profiles or
`.cargo/config.toml` invalidates the *dependencies* too, so recycling across one is **worse than
cold** — which is the reason to batch config/profile edits rather than land them one at a time. When
that happens, or when no worktree is free, `git worktree remove --force wt-<short>` (real
`node_modules` → safe; a junction is **not**) and create a new one.

**SIZING THE FLEET — memory is the binding constraint, not CPU or disk.**

- **`.cargo/config.toml` sets `jobs = 4`.** Cargo's default is one job per LOGICAL processor — 16 here
  on 8 physical cores — which is *no faster* than 4 and uses 2.2× the memory. Alone on a bigger box,
  `--jobs 8` overrides it.
- **A FULL gate is an 8 GB operation**, so **two** fit in what this machine has free, not ten.
  `npm run gate -- --full` therefore takes a cross-worktree slot from `~/.base-studio-code/locks/`;
  raise it with `BSC_GATE_SLOTS`. A waiting gate says so, and a dead holder's lock is stolen. This repo
  already has an OOM history (#795).
- **THE SLOT FOLLOWS THE COST, NOT THE TIER.** Gate memory is dominated by **VITEST**, not cargo. A
  scoped gate is **not automatically a cheap one**: touching a record store sets `vitestUnscoped`, so
  the whole suite runs while the plan still calls itself scoped — and since most of this frontend IS
  records, that is the common path. `needsGateSlot` queues any plan that runs vitest unscoped.

Ten sessions EDITING Rust is fine. Ten sessions GATING at once is an out-of-memory failure, not a slow
one. **Never run two gates in one worktree** — they fight over `target/`.

**Disk: three levers, all EXPLICIT except the sweep.** `bsc disk gc` (the `target/` sweep) is wired
into the gate and `build:plan` and is fail-safe — a janitor must never redden a gate. `bsc disk dedupe`
hard-links identical dependency artifacts across trees; it is **currently UNDONE deliberately**,
because the trade reverses with fleet size. `bsc worktree cap` is the **biggest** lever (~20 GB per
parked tree) and is **DESTRUCTIVE**, so it is never wired into anything — it refuses a junction
`node_modules` and refuses a **dirty tree** (`--force` is never passed, and that refusal is the
feature: the first run correctly spared a parked tree holding 7 staged modifications).

> What each reclaimed, the sha256-before-linking guard, why `.fingerprint/` is never swept, and the
> full jobs/RAM and recycle tables: **`bsc memory read build-cost-measurements`**.

Gotchas:
- **Base drift:** a branch cut from an older `develop` can fail an *unrelated* test that broke since.
  Refresh with `git merge develop` and re-gate rather than chasing a phantom failure.
- Deleting the branch fails while it is checked out in a worktree — recycle it onto the next ref (or
  remove it) **first**, then delete the branch (order matters).
- A branch whose ref carries a migrated GitHub number (`4260-…`) is still purely local. The number is
  provenance, not a link to act on — do not `gh` anything on it.

## Design Reference · Companion App

**The design lives in the app** — the **Design Studio** (`src/features/designs/`) authors pages,
components and animations in-app, previewed live by the render-preview chain. The old `design/`
prototype folder was **removed** (#3834); the `design/` dir inside a project *hub* is unrelated (it
stages a user's dropped files).

**mobile-studio-code lives in a separate repository**, and the tunnel wire schema must stay in sync
across both — a breaking protocol change needs coordinated changes in both repos.

> `bsc memory read design-and-companion` — the Design Studio, the tunnel contract, and the original
> UI-issue dependency order (#2–#10, historical).
