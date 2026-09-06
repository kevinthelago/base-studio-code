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

### What every build COST — `bsc mem`

The same wrapper also records what a run cost, and that half **is** wired into the gate, because
recording a cost cannot pin anything red. Every gate leg — `cargo clippy`, `cargo nextest`, `tsc`,
`eslint`, `vitest`, the graph checks — runs under `bsc errors run --measure-only`, which records wall
clock and the peak RSS of the whole process tree while filing **no fault**. It also inherits stdio
rather than piping, so cargo's live progress and colours survive being measured.

```bash
bsc mem build                              # what builds cost: n · median · worst · latest
bsc mem build --source gate:clippy         # ONE surface's history
bsc mem compare --at $(date +%s%3N)        # did my change help? (take the boundary BEFORE you start)
bsc mem app                                # the running app's JS heap / DOM nodes / listeners
bsc mem growth --session <id>              # a live session's RSS slope — the leak question
```

Measurements are per-leg and keyed on a stable id, so a **scoped** run and a **full** run of the same
leg share one history rather than splitting into two that can never be compared. Peak RSS is the
maximum over time of the SUMMED tree RSS — the same definition as the `jobs = 4 → 8.04 GB` figures
above, so the numbers are comparable to the ones already written down here rather than a second
incompatible metric.

**Every hand-measured figure in this file is now reproducible rather than remembered.** They were
taken once, by someone, and have no history behind them; `bsc mem build --source gate:<leg>` is the
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
│                            #   `graph/algorithms.json`; `src-tauri/src/` holds FOUR files — lib.rs,
│                            #   main.rs, tests.rs and one undeclared orphan. A record's module path
│                            #   IS its old file path, so every path below still names where a module
│                            #   BELONGS and `crate::console::pty` still resolves — you just open it
│                            #   with `bsc graph impl get src-tauri--console--pty--mod.rs` rather than
│                            #   with an editor. build.rs calls `graph_materialize::emit_when_adopted()`
│                            #   as a fifth job (a package gets exactly ONE build script, and this one
│                            #   was taken), which writes `$OUT_DIR/crate.rs` for lib.rs to `include!`.
│       ├── main.rs          #   binary entry → app::run()
│       ├── lib.rs           #   crate root: module decls + the leaf-helper prelude (#1918; no module aliases)
│       ├── prelude.rs        #   the crate's named leaf-helper prelude (paths/git/shell/fs/…), `use crate::prelude::*`
│       ├── tests.rs         #   cross-cutting test module (+ testutil.rs)
│       ├── platform/        #   OS primitives: paths, git, shell, process, fsx, docstore
│       ├── app/             #   Tauri shell: run(), state, recovery, dialog
│       ├── console/         #   interactive PTY surface: pty, ledger, discovery, shell_rc
│       ├── session/         #   session launch/config/permissioning: harness, launch, claude_config, settings, llm
│       ├── project/         #   on-disk hub + plan store: hub, plan_files, plan_db, blueprints, files, dead_code, ui_skeleton
│       ├── planner/         #   planning session: prompts, directives, workspace
│       ├── fleet/           #   worker fleet: worktree, director, staging
│       ├── github/          #   GitHub integration: api, oauth, repos, readiness, git_hooks
│       ├── sources/         #   migration data sources: data, oauth, credentials
│       ├── extensions/      #   MCP servers, hooks, skills, cfg
│       ├── observability/   #   logs, perf, tokens, audit
│       └── mobile/          #   paired companion: push + tunnel/{state,transport,commands} (wire protocol + Noise → crates/bsc-tunnel)
├── crates/                  # workspace crates (Tauri-free, CLI-spawnable)
│   ├── data/                #   canonical Data Model (DuckDB) + connectors (pkg bsc-data, bsc data CLI)
│   ├── plandb/              #   per-project plan store (SQLite) + bsc plan CLI
│   ├── skilldb/             #   global skills + task-groups store (SQLite) + bsc skill CLI
│   ├── logs/                #   unified log/perf/cost engine + bsc logs CLI (#1607)
│   ├── compliance/          #   compliance-standards store + bsc compliance CLI & bsc mcp compliance server
│   ├── bsc-security/        #   the SECURITY surface (bsc security), widened from `cve`: vulnerable dependencies
│   │                        #   (OSV.dev) + leaked credentials (working tree AND git history), emitted as ONE
│   │                        #   normalized Finding so detectors rank against each other. A secret is redacted at
│   │                        #   construction and NEVER stored raw — findings reach append-only plan notes. `bsc cve`
│   │                        #   is a deprecated alias whose exit-code contract still gates CI and the install hook.
│   ├── research/            #   literature research + bsc mcp research server
│   ├── bsc-news/            #   LOW-TRUST news layer (bsc news): poll a fixed outlet roster over RSS/news-sitemaps,
│   │                        #   retain EVERY fetched version (so a stealth edit stays observable), compute the framing
│   │                        #   signals. Deliberately NOT `research`: an article is a CLAIM to be corroborated, a paper is
│   │                        #   a citable source, and no verb converts one into the other. Every number is computed and
│   │                        #   carries the span that produced it — no model runs in this crate. `find` filters by
│   │                        #   PERSON / PLACE / CIRCUMSTANCE (gazetteer places match demonyms + cities; a circumstance
│   │                        #   FAMILY expands to its members), and `entities` ranks what is in the store so a filter is
│   │                        #   reachable without already knowing the name.
│   ├── bsc-say/             #   SPEECH OUT (bsc say): a provider trait over Kokoro-82M (neural, ONNX via `ort`,
│   │                        #   Apache-2.0, 55 voices), piper, and the OS speech service as an always-present floor.
│   │                        #   Resolution is CAPABILITY-PROBED, never configured — the best engine that actually
│   │                        #   resolves wins, and an explicit `--provider` is honoured or refused but never silently
│   │                        #   swapped. Kokoro takes PHONEMES, not text, so the crate owns the whole chain:
│   │                        #   text → IPA (espeak-ng, 133 languages) → token ids → ONNX → 24kHz. `--ipa` hands it
│   │                        #   phonemes directly, which is the `<phoneme>` capability Amazon's SSML sells.
│   ├── bsc-ear/             #   SPEECH IN (bsc ear): always-on capture — NOT push-to-talk and NOT wake-word, because
│   │                        #   the value is catching the half-formed thought you did not know to record. cpal →
│   │                        #   voiced-segment detection → bounded wav segments. Everything that DECIDES anything is
│   │                        #   pure and needs no microphone to test: `segment` (hysteresis, hangover, pre-roll, a
│   │                        #   noise floor frozen while recording), `retention` (the window is a FUNCTION, not a
│   │                        #   README paragraph) and `prosody` (pitch/effort/rate → arousal as a z-score against the
│   │                        #   SPEAKER's own habit; it deliberately does not classify emotion).
│   ├── llm/                 #   model-agnostic LlmProvider abstraction (pkg bsc-llm)
│   ├── bsc-agent/           #   model-agnostic agent runtime
│   ├── bsc-blueprint/       #   user blueprint store + bsc blueprint CLI
│   ├── bsc-persona/         #   user persona store (agent identities) + bsc persona CLI (#2094)
│   ├── bsc-teams/           #   user teams store: persona-relationship graph (positions + relationships) + bsc teams CLI (#2193/#2700; `bsc org` deprecated alias; on-disk store dir stays orgs/)
│   ├── bsc-project/         #   project-hub list/published store + bsc project CLI
│   ├── mcp-rpc/             #   shared stdio JSON-RPC MCP server scaffold
│   ├── bsc-tunnel/          #   mobile-tunnel wire contract + Noise IK crypto (Tauri-free; shared with mobile-studio-code)
│   └── bsc-util/ · bsc-sqlite-util/ · bsc-cli-util/   #   shared internal libs (paths, SQLite, CLI arg parsing)
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

### CHANGING a module that is a record — the write path, end to end

`docs/records.md` tells you how to FIND a record and when you may retire one. This is the other half:
how to change one and get the change to the compiler. It applies to Rust too — **25 crates compile FROM
the graph** (they carry `build = "../graph-materialize/build.rs"`; count them with
`grep -l graph-materialize/build.rs crates/*/Cargo.toml`), so `crates/bsc-studio/src/` holding only
`lib.rs` is normal, not broken.

**A record lives in up to four places, and a partial write is the failure mode.** Leave one behind and
`graph-promote-check` goes red for every session on the box, or worse, the change is silently inert.

    ~/.base-studio-code/knowledge/algorithms.json   RUNTIME store — per-user, SHARED BY EVERY SESSION
    <repo>/graph/algorithms.json                    REPO store — what the BUILD compiles
    src-tauri/data/knowledge/algorithms.json        PACKAGED seed — what SHIPS and what a fresh install reconciles
    .bsc-records/                                   EMITTED — rebuilt from the seed; never hand-edited

The sequence, which is the same for a Rust CLI or a frontend module:

```bash
# 1. get the current source OUT — never retype it, and never pass source on the command line
#    (a backtick or ${…} is substituted away silently, and large modules exceed the argv limit)
bsc graph impl get <id> --field code --raw > /tmp/x.rs

# 2. edit /tmp/x.rs, then write it back. --if-version is OPTIMISTIC CONCURRENCY against the
#    SHARED runtime store: it refuses unless the record's rev is exactly n, so you cannot clobber
#    another session's edit that landed while you were working. Read the rev with `impl history`.
bsc graph impl set --tech rust --id <id> --role algorithm --name <n> \
  --code-file /tmp/x.rs --if-version <n> --by <you> --note "<why>"

# 3. into the REPO store so the build sees it. --root is REQUIRED from a worktree.
bsc graph promote --id <id> --root "$PWD"

# 4. into the PACKAGED seed. BSC_DATA_DIR is REQUIRED from a worktree — without it the seed write
#    lands in the repo ROOT, which is checked out on `main` and running the app.
BSC_DATA_DIR="$PWD/src-tauri/data" bsc graph promote --id <id> --seed --root "$PWD"
```

Then build. `crates/graph-materialize/build.rs` reads `<repo_root>/graph/algorithms.json` and
materializes each record into `$OUT_DIR/crate.rs`, so **step 3 is what makes your edit compile** —
after step 2 alone, `cargo check` still sees the old code and nothing says so.

**Verify you touched exactly what you meant.** A line count cannot tell you: these files are one long
JSON line, so any edit shows as `1 +/- 1`. Diff the PARSED store instead —
`git show HEAD:graph/algorithms.json` against the working copy, keyed by record id.

**A red `graph-promote-check` is usually not yours.** The runtime store is shared, so the leg reports
drift from whatever anyone on the box is authoring. It prints each drifted node's author and age;
if the edit is minutes old, that is live authoring and you should leave it alone rather than promote it.


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

### The right pane — focused plan view (#652)
The planning page is a split: the live Claude session (terminal, center) + the **focused project pane** (`ProjectPane.tsx`, `focus` mode). The pane shows **one phase at a time** — a navigable **stepper** (per-phase status from `sectionStatus`: complete/active/locked/upcoming, incomplete phases pulse), a phase header with a **gate pill** (`evalGate`), lock/done banners, the phase body (Context / Structure+lens / Permissions+director, else a generic card), and a **footer advance bar** (back · jump/back-to-current · approve & continue when the gate passes · publish). It auto-follows the live session (`currentSection` = active phase) while letting the user navigate; selection resets on a project switch. Pure model: `focusedPlan.ts`; shell: `FocusedShell.tsx`. (Replaced the all-sections scroll + the full-width N-bar.)

### Blueprints — the lifecycle library (#609 / #645 / #636 / #647 / #3785)
A **blueprint** is the reusable template that seeds a project's plan: an ordered set of stages, each with a prompt module, **pipelines**, a declarative **gate** (`gateRule` → `evalGate`), an optional **output disposition**, and attached **skills**. Model: `src/features/planner/stages/blueprints.ts`. **The library UI is gone** with the rest of the planner screen (`delete-the-planner-ui-keep-the-planner`) — `list/ProjectsList.tsx` and `list/BlueprintCard.tsx` no longer exist, and neither do the import/update modals. Blueprints are reached with `bsc blueprint`; the one surviving in-app surface is the `blueprintpicker` component record.
- **Goal/domain routes, not lifecycle selectors (#645/#3785):** a blueprint is a curated planning **route for a domain**, carrying a `mode` (`create` vs `operate`, which selects the planner intro), its own `icon`/`h` for the card tile, and a curated feature list. Packaged set: **Default** (the blank/general route) + the domain routes **CRM · ERP · Helpdesk/ITSM · HR/HCM · Project Management**. The Library searches by free text (`filterBlueprints`).
  The lifecycle `category` field is **gone** (#3785) — it had degenerated to the same `greenfield` on every packaged blueprint, so it coloured every card identically and never varied a weight table. **Lifecycle is discovered per PROJECT** at discovery (`ClassifyConfig.lifecycle`, #3784) and is what Glance's project-node colouring and the Market rubric's weight table now read. `mode` (not the old category) decides whether a built-in auto-pins the packaged UI kit.
- **Skills (#636):** a section (or the whole blueprint) can attach reusable **skills** — the Skills library (`blueprintSkills.ts`). They're resolved and written to the hub's `skills.md` for the planner, and inlined into each worker's `CLAUDE.local.md` at fleet launch (`ensure_worktree`).
- **Locked at creation + promotion (#3785):** `projectBlueprintId` records which blueprint seeded a project and is **frozen at creation** — there is no in-place blueprint switching (the old reset/keep/export switch AND the from-scratch blueprint *author* are removed). At bind time the blueprint's captured feature list is seeded into the new project's Features stage (`PublishedHeader`). Conversely, a completed **and triaged** project is **promoted** into a new reusable blueprint via the **Generate Blueprint** button (`generateBlueprint` — captures the project's enabled stages + feature list); that promotion is the replacement for the old author flow.

### The project key
`effectiveProjectId = planningSessionKey || activeProjectId || planningTitle || planningPitch` (Planning.tsx). In practice `planningSessionKey` wins. `sanitize_project_key` (`platform/fsx.rs`) slugifies it: keep `[A-Za-z0-9-]`, everything else to `_`, cap 80 chars (the backend treats the key as fully **opaque**).

**One name-derived key (#2409, supersedes the minted id #1741).** A project's key is **`projectSlug(name)`** (`shared/lib/core/projectPaths.ts` — lowercase `[a-z0-9-]`, capped 60, slug-safe so `sanitize_project_key` is a no-op), **frozen at creation**. That one value names everything — `projects/<key>/`, its plan store at `plans/<key>.db`, `worktrees/<key>/…`, the session skill group, the pane ids (`<key>:director` / `<key>:<stream>` / `<key>:<repo>:triage`), every app-state map key, and (1:1) the GitHub project via `slug(github.name)`. **Recovery is derivation, not lookup**: reopening from the board derives the hub as `projectSlug(title)` — the `projectKeyAlias`/`resolveProjectKey`/`canonicalProjectKey` bridge and `mintProjectId` are **deleted**. Renaming stays **display-only** (the folder keeps its birth-slug). Edge cases are **modals, not machinery**: a create whose slug already exists opens the **collision modal** (open existing / pick a different name, `PublishedHeader`); a board project whose slug has no local hub opens the **reopen-mismatch modal** (`ReopenProjectModal`) — *Link to an existing local project* performs the one-time on-disk move (`relink_project_hub`: hub + worktrees + `git worktree repair`) plus the store rekey (`rekeyProjectData`), or *Start fresh* scaffolds under the slug.

**Grandfathering.** Existing legacy-keyed hubs (minted `p-…` ids or title-sanitized keys) are **untouched on disk** — no startup migration. Drafts reopen by their frozen key as before; a legacy project reopened **from the board** hits the reopen-mismatch modal once (its legacy hub is the pre-selected link candidate) and linking migrates it onto its name-slug permanently.

### Workspace layout
`setup_workspaces` creates the project hub at `~/.base-studio-code/projects/<key>/`:
- `CLAUDE.md` — *currently* the planner spec (see "Session roles + the CLAUDE.md model")
- `.claude/settings.json` — planner permissions (read/write md + WebFetch + git/gh)
- plan **section files**, flat: `goal.md`, `scope.md`, `stack.md`, `architecture.md`, …
- `phases.json` (milestones). **The plan store is NOT in the hub** — it lives centrally at
  `~/.base-studio-code/plans/<key>.db`, reached as `$BSC_PLAN_DB` / `bsc plan`. (Measured across all
  30 hubs: none has a local `plan.db`.) It is the per-project SQLite working store holding the
  granular issues, fleet streams + per-stream permissions, and the context required-set. #1805 made
  it the **sole fleet store** (the legacy `fleet.json`/`issues.json` files are no longer authored —
  `issues.json` is a projection rendered from it; any stray `fleet.json` is migrated in once by
  `migrate_stray_fleet_json`)
- `error.db` — the project's runtime fault store (`bsc errors`), and `usage.db` once analytics run.
  These two ARE hub-local, which is the asymmetry to remember: **plans are central, telemetry is
  per-hub.**
- `prompts/` — kickoff scripts the planner authors (`<stream>-kickoff.md`, `director-kickoff.md`)
- `automations.md`, `github_context.md`
- linked repos cloned in as subdirs (`<key>/<repo>/`); fleet worktrees live **outside** the hub at `~/.base-studio-code/worktrees/<key>/<repo>--<slug>/` (#844, so the planner `CLAUDE.md` is not their ancestor — `worktrees_dir` in `platform/paths.rs`)

### The planner is plan-only
Role gate #219: `git: read`, `github: read`, `code: none`. It reads for context and writes plan files, but cannot edit project code, commit, push, or open PRs. Publishing the GitHub structure is done by the **app** (`handlePublish`), not the planner's shell.

### The planning workflow (driven by the planner CLAUDE.md template in `planner/prompts.rs` + `planner/directives.rs`)
1. Link repositories.
2. **Discovery checklist** (goal, users, scope, ux, stack, architecture, schema, api, security, testing, …) — scan, propose, confirm, one topic at a time. Each becomes a section file + a `<plan_update>` tag (the right panel reveals it live).
3. **Develop the GitHub structure — the feature workshop** (#318, the deep interactive core): map the features, drive each down (behavior + acceptance / build approach / tools / data + deps), propose-then-interrogate, one feature at a time, then sequence into phases.
4. **Granular, agent-ready issues** (#311, in `plan.db`): each `PlanIssue` carries acceptance criteria, owned files, dependencies, labels, milestone, owning stream — enough that an agent finishes without asking.
5. **Plan the agent fleet** (`plan.db` `fleet_stream` rows): non-overlapping streams (owns globs, issues, dependsOn), recommended session count, optional director.
6. **Publish** (`handlePublish`): repos, project board, one milestone per phase, one GitHub issue per `PlanIssue` (body = acceptance + owns + deps, pinned to its milestone), `stream:<id>` labels.

### Per-agent configuration set during planning
- **Profiles** (#289, `src/shared/lib/security/`): a least-privilege `AgentProfile` (commands / tools / write-paths / net) per stream, applied at launch. The UI that EDITED them is gone (capability is authored with `bsc persona` and read on the Teams panel); the model stays because the mobile tunnel ships it.
- **Flows** (#297, `@/features/planner/fleet/agentFlow` — a record): `autonomy` (continuous/checkpoint/confirm) + `push` (auto-pr/push-confirm/commit-only/none) + `trigger` + `gate` — drives each agent's git/gh permissions, kickoff prose, and pause-visibility.

### Session roles + the CLAUDE.md model (and a known issue)
Three kinds of session live around a project, each needing **different** context:
- **Planner** — the planning spec; plan-only.
- **Orchestrator / director** — coordinates the fleet (review/merge PRs, resolve logged decisions, keep the board current); never plans or writes feature code.
- **Agents / workers / triage** — execute their assigned issue in a worktree, guided by their repo `CLAUDE.md` + `CLAUDE.local.md` (the plan) + their kickoff.

**Current state:** the planner spec is written to `projects/<key>/CLAUDE.md`, which is the **ancestor of every execution session** (director + workers run under `projects/<key>/`). Claude Code loads `CLAUDE.md` from the cwd and every parent, so the planner spec leaks into those sessions and they get pulled toward planning. A `READ FIRST` scope guard at the top of the planner CLAUDE.md is the interim band-aid (#320/#331).

**Intended architecture (in progress):** the planning session is **isolated in its own tree** (not an ancestor of the repos), `projects/<key>/CLAUDE.md` becomes the **orchestrator** spec, and the planner **generates** the orchestrator + agent context files as deliverables. Converge on this when touching `setup_workspaces` / the planning launch / `fleetStartProject`.

## Console — the execution surface

Where the planned work runs. A **tab** holds a CSS-grid of **panes**; each pane is a PTY session running `claude` in a repo or worktree, with swappable **views** (console chat, files, branches, changes, log). Backend: `pty_create` in `console/pty/` (dir-module: `mod.rs` + `job.rs`); launch wiring: `src/app/console/panes/views/TerminalView.tsx` + `fleetStartProject` in `src/store/index.ts`.

### Session roles + the role gate (#219, `src/shared/lib/session/sessionRoles.ts`)
Every session has a role bounding its capabilities (least privilege), applied at launch via `ensure_session_settings` to `.claude/settings.json`:

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

(`tester`/`reviewer` are the pipeline-stage roles, #220; `issuer` is intake-only — shapes a request into a GitHub issue and hands off, #376; `juror` independently judges a landing against its acceptance criteria, #394; `documentor` is the post-refactor lifecycle actor that reconciles the project's PROSE docs — CLAUDE.md structure tree, architecture docs, README — after a change lands, #1555. Like the director's commons carve-out (#851) it keeps `code: none` yet writes EXACTLY its `DOC_GLOBS` (markdown + `docs/**`) and is hard-blocked on every code path; push/PR are flow-governed. `designer` (#2471) is the Design Studio's UI-kit session — `none` on every axis, launched with `restrictedAllow` so the baseline command tiers are suppressed and its whole auto-runnable surface is `bsc ui` + the deprecated `bsc component` alias.) `roleDeniedCommands` denies the mutating git/gh commands a role cannot run; `roleWriteRules` denies/scopes the file-write tools. The session allows Bash broadly and guarantees `gh`/`git` on PATH; Claude Code precedence is **deny > ask > allow**. (**Permission postures** (#1916/#2050): the PreToolUse hooks — `bsc-deny` (dangerous floor + role/user denies), `bsc-confine` (FS confinement), `bsc-scope` (write-scope) — are the always-on floor, firing **and blocking under BOTH postures** (even bypass, where `permissions.deny` is ignored). The **default is the ALLOW-LIST** (#2050): Claude's `default` mode auto-runs the broad `base.json` allow-list (git/gh + the read-only inspection set + the mainstream build/test toolchains) and prompts for anything else — low-friction but safe. **Bypass** (sessions auto-run everything, hooks-only gating) is the opt-in power **posture toggle** (Settings → Security). On top, an opt-in **model-agnostic OS sandbox** (#1988): a session runs inside a **sealed WSL2 distro** (`bsc-agent-sandbox` — no `/mnt/c` mount, no Windows interop, baked into `/etc/wsl.conf`), so the cage is the *environment* and confines whatever LLM drives the session, not just Claude (`pty_create`'s opt-in `wsl_distro`; provision + readiness in Settings → Security; a Settings → Agents toggle launches consoles inside it). The rootfs bakes in **every** harness — Node + Claude Code (the default) and `gh` alongside `bsc-agent` (#4260) — so the cage isn't limited to the non-default harness. **Per-agent isolation via Linux users** is built (#1994/#4260): each sandboxed fleet session (worker + director) runs as its own `bsc-<slug>-<hash>` user with a `700` home holding its **own worktree**, created by that user off a group-shared clone; the hub, `plan.db`, `coord.log` and the global `bsc` stores live in one setgid `bsc-agents` dir (`/srv/bsc-shared`) that every agent home reaches via a `~/.base-studio-code` symlink — private code, shared agreement. The sandbox is **still opt-in**; making it the sole posture is #4260, gated on bundling the rootfs tarball with the installer.)

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
Drives: which git/gh writes auto-approve vs **prompt** (the `ask` tier for a hard push-confirm gate) vs deny; the autonomy + push paragraph in the kickoff; and a coordination wake when a checkpoint/confirm agent pauses. The flow's push policy is the **authority** over `git push` / `gh pr create` and lifts the role gate's broad gh-write deny for exactly those two (#304) — so an `auto-pr` worker can open its own PR while `gh pr merge` / repo-delete stay role-denied.

### Coordination (#199, `@/shared/lib/fleet/coordination` — a record)
Agents emit structured events to an app-wide `coord.log`: `bsc-wait` (paused for the user, #297), the worker↔director Q&A pair `bsc-ask`/`bsc-answer`, the `bsc-issue`/`bsc-assign` capture-and-route emitters, the planner→director/issuer `bsc-brief` channel (#2377 — the planner's runtime voice, pushing a mid-build plan update into the running fleet; folds into `CoordState.briefs` and the director pump surfaces it, once per pane, to reconcile + route onward via `bsc-assign`), and the completion emitters `bsc-landed/merged/closed/failed`. The **Coordination inbox** (`CoordinatorInbox`) surfaces paused / blocked-on-a-question / ready sessions for the user. **Runtime dependency-wait was removed (#1039):** there is no `bsc-blocked --on` and no coordinator auto-wake — `dependsOn` is a *planning-time* sequencing hint only; at run time workers build against the planned contracts in parallel and never park on an upstream, and the director owns contracts + integration.

### bsc-* shell helpers + the runtime state-CLI surface (#1325)
Two distinct mechanisms reach a live session's own shell. **Pure-shell helpers** are installed into every session via `BASH_ENV` to `~/.base-studio-code/bsc-env.sh` (written by `pty_create`, `console/shell_rc/`): `bsc-checkpoint` (resume note), `bsc-note` (DECISIONS.md provenance), `bsc-audit` (#257 tool-attempt log), `bsc-confine` (#158 FS confinement), `bsc-wait` + the coord emitters (`bsc-ask`/`bsc-answer`, `bsc-landed/merged/closed/failed`, `bsc-issue`/`bsc-assign`, `bsc-brief` — planner→director/issuer, #2377). **WARNING: each rc constant must end with a trailing newline** or the concatenated shell functions glue together and the whole rc breaks with a syntax error (#296) — the `full_bsc_rc_is_syntactically_valid_bash` test guards this. (`bsc-blocked` was removed, #1039.)

**The unified `bsc` state CLI (#1877):** the runtime principle is that **every persistent app store is reachable from a live session via the one bundled `bsc` binary** — execed by an absolute path from `$BSC_BIN` (no PATH changes), with each former per-store sidecar now a **subcommand** of `bsc`: `bsc plan` (plan.db, `$BSC_PLAN_DB`), `bsc skill` (global skills.db, incl. `get`/`remove`), `bsc data` (canonical DuckDB model/scan/tables + `connector` — which **replaces** the deprecated `bsc plan integration`, #1721), `bsc logs` (unified logs + perf/cost), `bsc compliance` (compliance standards — the CLI alongside the `bsc mcp compliance` server), `bsc blueprint` (user blueprints), `bsc persona` (user persona library — agent identities: start prompt + skills + model over a role, #2094), `bsc teams` (user teams library — the persona-relationship graph: positions wired by relationship archetypes → communication forms, #2193/#2700; `bsc org` is a deprecated alias, the on-disk store dir stays `orgs/`; `bsc teams model <team> <node> <tier>` overrides ONE placement's model, where `bsc persona model` moves an identity's default everywhere it is placed), `bsc project` (project-hub list/published), `bsc say` (speech OUT — the neural voice, an output device it remembers, and `--ipa` for phoneme-level control), `bsc ear` (speech IN — always-on capture, `levels` to find a device that actually hears, `prosody` for arousal), and `bsc files` (file tree + `read`, the root-confined file-text
verb a session reaches for when neither harvest lifts a module — #4161). The bundled MCP servers are reached the same way — `bsc mcp research` / `bsc mcp compliance`. So a live session can read or drive any of these stores directly from bash. (The only other bundled binary is `bsc-agent`, `$BSC_AGENT_BIN`, the model-agnostic agent runtime.)

### The voice loop — it speaks, it listens, and none of it leaves the machine

`bsc say` and `bsc ear` are the two halves. Maintainer's decisions, which are settled and should not
be relitigated: **fully local always** (no transcript or sample reaches a third party on any default
path), **always-on rather than push-to-talk or a wake word** — the value is catching the half-formed
thought you did not know to record, and a wake word means you had already decided to record it — and
a **short rolling audio window**, so a stretch can be re-transcribed by a better model later without
keeping an indefinite recording of the room.

**MEASURED on this machine (RX 9070 XT, RDNA4), because the numbers decide the design:**

| | |
|---|---|
| Whisper `large-v3-turbo`, CPU | 2.4× realtime — *slower than realtime on shorter clips* |
| Whisper `large-v3-turbo`, **Vulkan** | **37.7× realtime** (encode step 43× faster) |
| Kokoro-82M TTS, CPU | 4.5× realtime |

**The GPU path is VULKAN, not ROCm.** ROCm is not installed and does not need to be; RADV picked up
`GFX1201` with fp16, and Mesa was already present. whisper.cpp needs `cmake`, `libvulkan-dev`,
`glslc` and `spirv-headers` to build that backend. A model that cannot keep up with realtime is
disqualifying for always-on capture — you fall permanently behind — so this is what makes the best
model usable rather than a tradeoff against `base.en`.

**Four traps, each of which cost real time to find:**

- **A device being PRESENT says nothing about it being connected to a human**, and this bites on both
  sides. `bsc ear levels` exists because enumeration cannot distinguish a live capture device from a
  dead one — measured here, the system *default*, the USB interface and the headset all delivered
  digital silence while only the onboard input was live, and an ear pointed at a silent device
  reports LISTENING forever, looking exactly like a quiet room. On the output side there is no
  equivalent probe, because you cannot measure whether a human heard something: `bsc say` exits 0
  whether or not anyone was in earshot, so it lets you choose an output once and remembers it.
- **ALSA presents four physical inputs as 27 devices** — `hw:`, `plughw:`, `front:`, `surround*:`,
  `iec958:`, `dsnoop:` and `sysdefault:CARD=` are routing variants of the same card, not choices. It
  also writes its own diagnostics straight to stderr while enumerating. Both are filtered. And
  probing a ROUTED node takes the hardware with it, hiding the hardware node from the rest of a
  sweep, so hardware is probed first.
- **Whisper hallucinates on non-speech**, characteristically as "Thank you." — and `prosody` finds
  those same segments have no voiced content. Two independent measurements agreeing nothing was said
  is a free hallucination filter, and worth keeping rather than smoothing over.
- **Cleaning for ASR and cleaning for prosody are not the same chain.** The 70–900 Hz band-limiting
  that makes pitch detection work would destroy the zero-crossing-rate feature that stands in for
  spectral tilt, so pitch reads a filtered copy while loudness and effort read the raw signal.

**What arousal is and is not.** `bsc ear prosody` measures pitch, pitch range, loudness, effort and
rate, and combines them into a z-score **against the speaker's own habit** — a quiet person at their
most animated may never reach a loud person's resting level, and a per-speaker baseline is also the
only thing immune to preamp gain. It deliberately does **not** classify emotion: categorical models
benchmark near 70% on *acted* corpora, collapse on spontaneous speech, and emit a label nothing can
argue with. Valence is absent for the same reason — it is the dimension acoustic models are worst at,
and the transcript carries it better. Measured against a real 23-segment corpus, the composite tracks
f0 range at r=+0.77 and **loudness at r=−0.06**, so the loudness weight is spent on mic distance
rather than affect and should be revisited against a second speaker.

### GitHub-readiness (#297 S1)
- **GitHub-readiness probe**: on launch each claude-launching pane probes `gh`/`git` on PATH + `gh auth`; if not ready it shows a dismissible amber banner in the pane so the gap surfaces before the agent hits it mid-task.

### Triage
A per-repo session that resumes the repo's prior conversation (`claude --continue`) with `prompts/<repo>-triage.md`, to work the repo's open issues by priority.

## Roadmap & Release Process

Development is organized into **versions**, worked one at a time. A version is not a frozen
snapshot you finish before cutting a build — it is a **living milestone** you ship early and keep
improving until its theme is complete. We release a version, then continue working on that same
version (refining, fixing, and filling out its theme) until every issue under it is done; only then
does the next version become the focus. So a version on the roadmap is **Current** (actively being
built on, even though a build may already be released under that number) rather than **Shipped**.

**The cycle for a version:**
1. **Open** the version with a theme and its set of issues (the work that defines "complete").
2. **Build** through those issues on `{issue-number}-{short-description}` branches → `develop`.
3. **Release** early and often from `develop → main` — a released build does **not** close the
   version; it's a checkpoint, and work on the same version continues.
4. **Complete** the version only when all of its issues are done. The next version then becomes
   Current and step 1 repeats.

At any time exactly one version is **Current**. Earlier versions are **Complete**; later versions
are **Planned**.

### Milestones — the version system

GitHub milestones track **versions, nothing else**: an issue's milestone is the release it ships in
(`1.0.5`, `1.0.51`, `2.0.0`, …). Cross-version themes live as epic issues or labels, never as
milestones — a theme milestone would steal the one milestone slot the version needs.

- Only a few milestones are open at a time: the **Current** version, the next planned version(s),
  and **Backlog** (the icebox — parked work with no version target yet).
- New work defaults to the Current version's milestone; parked/deferred work goes to Backlog.
- **On each release:** close the released version's milestone and roll its unfinished issues
  forward to the next one. The closed milestone's issue list is the changelog's skeleton.

### Versioning policy (pre-v2 is loose on purpose)

The app is still coalescing — not every feature is well defined, work spans many files and overlaps
with other work — so the version numbers are **deliberately loose** until it's unified. Three phases:

1. **`1.0.4n` — fix & polish (COMPLETE).** Bump the trailing digit for each release (`1.0.41`,
   `1.0.42`, …). Development stays the firehose: the fleet pushes to `develop`, features overlap,
   nothing is gated on a tidy theme. A release is just a snapshot of `develop`.
2. **`1.0.5x` — themed steps on the `1.0.x` line (CURRENT: `1.0.52`).** Each release carries its own
   theme, worked one at a time, release-and-continue: `1.0.5` the UI release, `1.0.51` the UI-release
   delivery build, **`1.0.52` accessibility & text-to-speech + market research/marketing/analytics (current)**.
3. **`2.0.0` — unification.** Once every feature the maintainer wants is added and the app is a
   defined product, we cut `2.0.0` and switch to **rigorous semver** (major/minor/patch by their real
   meaning), followed strictly from there. This is the hand-off point where release discipline tightens.

The pre-v2 numbering is an intentional trade for velocity — **do not "fix" it or relitigate the
scheme.** The phase boundaries are tracked as GitHub **milestones** (`1.0.5 …`, `2.0.0 …`).

### Cutting a release — one command

`npm run release` does the whole cut in one go: bump the version in **both** `package.json` and
`src-tauri/tauri.conf.json`, stamp the `CHANGELOG.md` `[Unreleased]` section as the new version,
commit, tag `vX.Y.Z`, and `git push --follow-tags` — which fires the tag-triggered `release.yml` to
build the platform installers and cut the GitHub Release.

- `npm run release` — patch bump (the `1.0.4n` cadence: `1.0.41 → 1.0.42`).
- `npm run release -- 1.0.5` — an explicit version (a themed step, or `2.0.0`).
- `npm run release -- minor` / `major` — a semver bump (used from v2 on).

Run it from an up-to-date `develop` with a clean working tree. Only `package.json` +
`tauri.conf.json` carry the app version; `src-tauri/Cargo.toml` stays at its crate version.

### Roadmap

| Version | Status | Theme |
|---|---|---|
| v1.0.3 | Complete | User experience, resiliency, and the core **Default** (greenfield) blueprint and its **triage** — the progress-gated relaunch that resumes from plan.db and skips completed workers. Running in parallel, the **model-agnostic agent shell** (`bsc-agent`, epic #1078) lets the platform run on any LLM (Anthropic/OpenAI/Gemini/local); Claude Code stays the default until parity. |
| v1.0.4 | Complete | **Enterprise integration & migration** — connect **read-only** to an existing system (CRM/ERP/BPM, Salesforce first) and **scan the whole platform**: data types *and* configurations *and* behaviors. The planner produces a **Platform Behavior Summary** — objects/fields, automations (validation rules, workflows, Flows/Process Builder), business processes (approval processes), and derived logic (formula fields, Apex) — so **automations, business processes, and data are all migratable**: reproduced as the generated app's schema and logic via canonical **data models** + **agent-authored connector manifests** (the planner probes the source and authors the connector; native per-vendor connectors were removed, #1976) + MCP connectors, with a compliance layer baked into the planner. The v1.0.5 line generalizes this into a global **Integrations Platform** (#1965). |
| v1.0.4n | Complete · fix & polish | The rolling `1.0.4n` fix-and-polish line (`1.0.41`, `1.0.42`, …, per the Versioning policy above) — the large volume of no-user-facing-feature refactor, integration-architecture, and hardening work, plus ongoing polish. **Codebase refactor & consolidation**: feature-first frontend vertical slices (#1309) — `app/` shell · `features/` (UI + pure `lib/` + slice + `index.ts` barrel) · `shared/` · `store/`, `@/…` alias; shared UI primitives (`Banner`/`Card`/`Button`/`StatTile`/`EmptyState`/`BackButton`/`IconButton`/`ModalScrim`/`Dialog`/…) + a consistency sweep; `Planning.tsx`+`FocusedBodies.tsx` decomposition, `handlePublish`→`publishSteps.ts`, reusable `usePoll`/`useGithubQuery`/`useCoordLog` + `safeInvoke`/`fireInvoke`; Rust consolidation (`bsc-cli-util`, Tauri-free `bsc-blueprint`/`bsc-project`/`bsc-tunnel`, `session/` domain, `src-tauri/prompts`→`data`, **plan.db as the sole fleet store**, `tests.rs` decomposed, reference-context removed). **Integrations as agent-authored connectors** (#1962): the planner probes a source and authors the connector manifest (probe→validate→try, captured as skills); native connectors/presets/catalog removed (#1976); dynamic Source pane + runtime OAuth. **Data-driven planner**: Rust-inline prose/stage-registry/role-capabilities/deploy-taxonomy extracted to `@data/*`; tag-parsing → `bsc`. **Planner/fleet hardening**: unified stage vocabulary (#1958) + milestone phases removed (#1942); Repos+Deploy→**Deployment** and Fleet+Streams→**Streams** (carded, collapsible); fleet-identity, warden re-quarantine, worker-trust/prompt, and triage-tab-naming fixes. |
| v1.0.5 | Complete | **The UI release** — an in-app, Claude-Design-like way to define each page, component, and animation, rendered live by the render-preview (closing the external Claude Design round-trip), plus **iterative UI loops** (generate → live-preview → refine in-app, the same tight loop the fleet runs for code) — **and the maintenance bots** (#1957). Its builds shipped through the **v1.0.51** tag; UI/design-studio work still in flight was **rolled forward to the 1.0.52 milestone**. |
| v1.0.51 | Complete · delivery build | **The UI-release delivery** — the build that carried the bulk of the v1.0.5 theme to `develop`: the **Design Studio** (in-app page/component/animation authoring · live build-and-iframe preview · component motion-as-data · the graph-health `doctor`), the **Algorithms knowledge graph** (`bsc graph`), **Studio snapshots** (save/share/re-seed the whole app library), the **maintenance-bot suite** (`bsc debug` · `bsc metrics` · warm-pool debugger · component + algorithm **harvest**), the **CAD geometry kernel** (`bsc cad`), the **Sounds** pillar, and **Glance-as-cockpit**. Its namesake market-research/marketing/analytics theme (the Marketer + usage analytics) **moved to the 1.0.52 milestone**. |
| **v1.0.52** | **Current** | **Accessibility & text-to-speech · market research, marketing & usage analytics** — the current themed step: accessibility + TTS, plus the **Marketer** (market on your behalf via channel MCP servers, keychain-backed secrets) and generated-apps **usage analytics** (rolled forward from v1.0.51), and the **UI / design-studio** work still in flight from v1.0.5. |
| v2.0.0 | Planned | **Unification + rigorous semver.** Once every feature the maintainer wants is added and the app is a defined product, cut `2.0.0` and switch to **strict semver** (see the Versioning policy above) — the hand-off point where release discipline tightens. |

The agent-shell track shipped alongside v1.0.3 but is themed separately on the public [Roadmap](README.md#roadmap)
("Run on any model"). v1.0.4 (and its 1.0.4n line), **v1.0.5** (the UI release), and **v1.0.51** (the
UI-release delivery build) are now **Complete**; **v1.0.52** (accessibility & text-to-speech + market
research/marketing/analytics) is **Current**. When v1.0.52 is complete, promote the next version to **Current**.

The *codebase refactor & consolidation* work (the frontend feature-first reorg, shared UI primitives,
large-file decomposition, Rust crate consolidation) plus the integration-architecture and planner/fleet
hardening was cut as the **v1.0.41** checkpoint — a labelled stop-gap on the v1.0.4 line, before v1.0.5.
(Semver note: `1.0.41` sorts *after* `1.0.5`, so it's a "1.0.4, revision 1" marker, not a number between
the two.) Its changes are stamped under the `[1.0.41]` CHANGELOG section; new post-checkpoint work
accrues under `[Unreleased]`. The full version-by-version breakdown lives in
[ROADMAP.md](ROADMAP.md).

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

**`cargo nextest`, not `cargo test` — and it must be installed.** `cargo test` runs the workspace's
~41 test binaries **one after another**; within a binary its tests thread, but the binaries are serial,
so cores idle — visible as `cargo test` sitting at 65% CPU while nextest saturates. Install it like
`sccache`: `cargo install cargo-nextest --locked`.

**Its win is CONDITIONAL on spare cores, and that is worth knowing before you expect a number.** Both
arms measured from identical warm state, test targets prebuilt, same four pre-existing failures:

| machine | `cargo test --workspace` | `cargo nextest run --workspace` |
|---|---|---|
| quiet | 1m31.8s | **1m06.9s** (−27%) |
| 4 other agent builds running | 1m32.9s | **1m30.1s** (−3%) |

nextest fills idle cores; when several worktree agents are already saturating the box there are none to
fill, and the gain nearly vanishes. It is never *slower*, so it is still the right default — just do not
plan around 27% on a busy machine, which is this repo's normal state.

Two differences worth knowing before they surprise you:

- **It runs each test in its own PROCESS**, where `cargo test` threads them inside one binary per crate.
  Anything sharing process-global state behaves differently — which is what `ENV_LOCK` in
  `src-tauri/src/testutil.rs` exists for. Per-test processes make env-var tests *more* isolated, not
  less, and the whole suite was verified under it (2,362 of 2,366 passing, same four reds) — but a test
  that quietly depended on a sibling having run first will now fail, and that is the test being wrong.

  **THE ISOLATION CUTS BOTH WAYS, and this direction is the dangerous one.** A test that PASSES under
  nextest can still FAIL under `cargo test`, because per-process isolation *hides* a race on
  process-global state rather than fixing it. **The gate runs nextest, so the gate cannot see this
  class at all.** MEASURED on `bsc-graph`, back to back on a quiet machine:

  | | |
  |---|---|
  | `cargo nextest run -p bsc-graph` | 259 passed, 0 failed |
  | `cargo test -p bsc-graph --lib` | 243 passed, **16 FAILED** (a second run: 242 / **17**) |

  The count MOVING between runs is the signature — a race, not a broken assertion. Every failure was a
  test pointing the CLI at a temp store with `set_var("BSC_GRAPH_STORE", …)`, so one test's `remove_var`
  landed between a sibling's `set_var` and the call it was setting up. `src-tauri/src/fleet/warden.rs`
  hit the same shape on 2026-09-02 (1 run in 10) with three tests sharing an in-memory registry.

  **It is not merely a developer-facing annoyance.** An unlocked write resolves the DEFAULT store and
  corrupts `~/.base-studio-code/knowledge/algorithms.json` — the real per-user authoring copy. That is
  what made `graph-promote-check` go red on a *different node every run* and forced every
  `npm run promote` that day through `--skip-gate`, which skips verifying develop entirely.

  **So a lock is the mechanism and a SOURCE-ASSERTING TEST is the guard**, because nothing at run time
  can observe the *absence* of a lock. `every_store_env_mutation_is_inside_the_store_lock`
  (`crates/bsc-graph/src/cli.rs`) scans the crate's own source and names any function that mutates a
  store env var without holding the lock. Two details there are worth copying rather than rediscovering:
  it delimits function bodies by INDENTATION, not brace counting, because the file is full of raw JSON
  fixtures whose braces would need string-literal stripping to survive — and a scanner that silently
  mis-parses reports zero offenders, which reads as a pass. And it asserts the POPULATION
  (`mutating >= 10`) so a scanner that stopped matching fails loudly instead of going quiet.
- **It does not run doctests.** This workspace has none, and `no_rust_doctests_are_silently_skipped` in
  `src-tauri/src/tests.rs` FAILS if one is ever added, because a doctest that silently never runs is
  exactly the kind of green-gate-that-sees-less this repo keeps getting caught by. If that test fires,
  either drop the doctest or add `cargo test --doc --workspace` to this gate — do not delete the guard.

**The Rust build is SHARED across worktrees — install `sccache` before your first build.**
`.cargo/config.toml` sets it as `rustc-wrapper`, so cargo fails loudly with *"could not execute process
sccache"* if it is missing. Get it with `winget install Mozilla.sccache` or `cargo install sccache
--locked` (it must land on PATH; `~/.cargo/bin` is the conventional spot and is already on PATH wherever
cargo is).

Why it exists: every worktree has its own `target/`, so each one used to recompile ~8000 dependency units
from scratch. Measured in a genuinely cold worktree with the cache warmed by a *different* worktree:
**181 cache hits against 27 misses — 87%**. A shared `CARGO_TARGET_DIR` was rejected instead: it broke
tauri builds before, and it puts every concurrent cargo behind one target-dir lock, which is exactly wrong
with many agents building at once.

**Iterate against the CRATE, not the binary.** Measured after touching one line in `crates/bsc-graph`:

| command | warm | first run of that profile in a fresh worktree |
|---|---|---|
| `cargo check -p <crate>` | ~3s | 25s |
| `cargo test -p <crate> --lib` | **7s** | 168s |
| `cargo build -p bsc --bin bsc` | **9s** | 343s |

So: `check -p` while writing, `test -p` to verify, and build `bsc` only when you need to *run* it. Every
subcommand crate exposes `cli::run(args, prog)`, so the crate's own tests reach the whole surface without
linking the unified binary. (Splitting `bsc` into smaller binaries does **not** help — the cost is
compiling dependencies, not linking, and each split binary would still pull DuckDB and arrow.)

**Which crates cost what — DuckDB is the dividing line.** Bundled DuckDB is ~1.8 GB of build output and
one to two minutes of C++ per worktree, and cargo unifies features per *invocation*, so a scoped
`-p` command pays it only if that crate's own dependency tree asks for it. `bsc-graph`, `bsc-ui`,
`bsc-files`, `bsc-component` and `bsc-cad` do **not** — `bsc-graph` takes `bsc-data` with
`default-features = false`, since the only thing it needs there (`bsc_data::entity`) is a JSON store that
reaches no database. Keep it that way: re-adding the default feature to any of them quietly puts the whole
DuckDB amalgamation back into their iteration loop. Measured on a cold worktree, `cargo check -p bsc-ui`:
**2m28s before that change, 20.8s after.** The crates that genuinely pay are `bsc-data`, `bsc` and
`base-studio-code`, plus any `--workspace` command — which is why the gate is slower than the loop.

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

#### Four sharp edges that are not obvious and cost real time

- **Never `cargo fmt`.** There is no `rustfmt.toml`, no fmt gate leg, and lines run to 142 chars. It
  reformats hundreds of files you did not touch and buries your change.
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

**Recycle, don't recreate.** A worktree's `target/` is the expensive part, and
`git worktree remove` throws it away so the next item rebuilds it from nothing. Point the existing
worktree at the next ref instead. Measured on a quiet machine, `cargo build -p bsc --bin bsc`:

| | rebuild |
|---|---|
| fresh worktree, cold `target/` | **1m59s** |
| recycled, new ref at the same commit | **0.41s** |
| recycled, plus a real one-leaf-crate diff | **5.11s** |
| recycled **across a root `Cargo.toml` profile change** | **2m21s** — *worse than cold* |

Git does not touch mtimes when the resulting tree is identical, so cargo genuinely sees nothing to do;
the normal cost is the size of the diff, not the size of the tree. The last row is the exception worth
remembering: a branch that edits `Cargo.toml` profiles or `.cargo/config.toml` invalidates the
**dependencies** too and leaves the tree holding two opt-level variants, so recycling across one is
slower than starting cold — and it is the reason to batch config/profile edits rather than land them
one at a time. When that happens, or when no worktree is free, `git worktree remove --force wt-<short>`
(real `node_modules` → safe; a junction is **not**) and create a new one.

This is not a substitute for the build cache — it is what remains after the cache is exhausted. sccache
already serves ~232 of the ~263 cacheable compilations in a cold build; the rest are `crate-type`
(proc-macros, bins, `cdylib`/`staticlib`), workspace crates whose **source path is part of the cache
key** so they can never hit across worktrees, and linking. `CARGO_INCREMENTAL=0` and seeding a copied
`target/` were both measured and are both losses.

**SIZING THE FLEET — memory is the binding constraint, not CPU or disk.** MEASURED on 8c/16t / 32 GB
with ~16 GB actually free, `cargo nextest run --workspace --no-run` after touching `bsc-util` (36 of 40
crates rebuild):

| cargo jobs | peak RAM | wall |
|---|---|---|
| 2 | 5.47 GB | 73s |
| **4 (now the repo default)** | **8.04 / 8.13 GB** | **55 / 54s** |
| 6 | 11.64 GB | 46s |
| 8 | 13.58 GB | 46s |
| 16 (cargo's default when unset) | 18.01 GB | 54s |

Two things follow, and the second is the one that limits the fleet:

- **`.cargo/config.toml` sets `jobs = 4`.** Cargo's default is one job per LOGICAL processor — 16 here,
  on 8 physical cores — which is *no faster* than 4 and uses 2.2× the memory. Working alone on a
  bigger box, `--jobs 8` on the command line overrides it and is ~15% quicker.
- **A FULL gate is an 8 GB operation** because nextest links ~41 test binaries (9 concurrent `link.exe`
  at the old default; one app link alone peaks at 2.99 GB). So **two** full gates fit in what this
  machine has free, not ten. `npm run gate -- --full` therefore takes a cross-worktree slot from
  `~/.base-studio-code/locks/`. Raise the limit with `BSC_GATE_SLOTS` on a bigger machine. A waiting
  gate says so — a silent wait is indistinguishable from a hang — and a lock whose holder died or
  wedged is stolen, so one crashed agent cannot block the fleet. This repo already has an OOM history
  (#795).
- **THE SLOT FOLLOWS THE COST, NOT THE TIER**, and that distinction was learned the hard way. The rule
  used to be "`--full` queues, scoped does not, since it compiles one crate plus its dependents" — a
  statement about CARGO, applied to a gate whose memory is dominated by VITEST. MEASURED on this box
  over 60s of ordinary fleet work: an 18.19 GB peak of which **vitest was 11.45 GB** (8.59 GB across 28
  workers, 2.86 GB across **six** concurrent runners) — more than the whole Rust toolchain, the app and
  every agent session combined, and not one of those six held a slot.
  A scoped gate is **not automatically a cheap one**: touching a record store sets `vitestUnscoped`
  (`--changed` cannot see from a JSON blob to the modules `emit:records` materializes out of it), so the
  whole 768-file suite runs while the plan still calls itself scoped. Since most of this frontend IS
  records, that is the common path rather than a corner. `needsGateSlot` now queues any plan that runs
  vitest unscoped, and `gate-scope.test.ts` pins it.

Ten sessions EDITING Rust is fine. Ten sessions GATING at once is not, and without the lock it is an
out-of-memory failure rather than a slow one.

**De-duplicate identical dependency artifacts across trees.** 721 of 765 rlibs in one worktree's
`deps/` share a filename with another's, and they are byte-identical — dependencies carry
`debug = false` (#795) so no absolute paths are baked in, and a shared filename already implies
shared inputs because `-C metadata` folds package + features + profile + target.

```bash
bsc disk dedupe --dry-run     # what would be linked
bsc disk dedupe               # hard-link verified-identical artifacts
bsc disk dedupe --undo        # BREAK the links again, one copy per tree
```

> **THE TRADE REVERSES WITH FLEET SIZE — currently UNDONE, deliberately.** At 3 active trees the shared
> inodes were a dormant risk. At 10+ sessions a dependency bump has several trees rebuilding the same
> registry crates at once, several processes writing one inode. It bought 13 GB against ~1,050 GB free,
> so it is not worth that. `--undo` reduced cross-tree shared inodes from thousands to **5 (0.02 GB)**.
> Re-run the dedup only when the box is quiet and space actually matters.

EXPLICIT, like the pool cap — never wired into the gate. Measured on the real pool: **13.05 GB
reclaimed** and it HOLDS (only 0.16 GB became re-eligible after the trees rebuilt).

- **sha256 is verified before every link** — a filename is a hint, never a proof. That guard is not
  theoretical: the first real run found **1902 files with identical name AND size but different
  bytes** (`.d` dep-info files embed absolute source paths), every one of which a name+size
  heuristic would have linked wrongly.
- **Workspace crates are never linked** — cargo folds the absolute manifest path into their
  `-C metadata`, so they differ per tree anyway, and they rebuild constantly.
- **THE COST IS A ONE-TIME PARTIAL REBUILD.** A hard link shares metadata, so a linked artifact
  adopts the canonical copy's mtime and non-canonical trees read it as stale. Setting the shared
  inode to the group's NEWEST mtime cuts that sharply (measured 189 → 53 crates) but cannot remove
  it: one inode cannot satisfy N trees' independent fingerprints. Expect ~40-50 crates to rebuild
  once per tree, after which the trees are stable (0 recompiles on the next build).
- `--min-age-mins` (default 60) keeps a live build in another tree from being raced.

**Cap the parked pool — it is the biggest disk lever, and nothing else can reach it.** A parked
worktree exists only to hold a warm `target/`, worth ~2 minutes (1m59s cold vs 0.41-5.11s recycled).
Each one costs ~20 GB, and eight of them were holding ~160 GB. Nothing INSIDE a worktree is
reclaimable — the deps sweep measures 0 orphaned units on every one, because they are too young to
have any.

```bash
bsc worktree list                 # every tree, what it holds, whether it is collectable
bsc worktree cap --dry-run        # what would go
bsc worktree cap                  # keep the 2 most recently BUILT parked trees
bsc worktree cap --keep 4
```

DESTRUCTIVE, so unlike the two janitors it is **never** wired into `build:plan` — you invoke it. It
refuses rather than works around:

- a **junction/symlink `node_modules`**, because `git worktree remove` follows it and wipes the
  shared root install;
- a **dirty tree** — `--force` is never passed, and that refusal is the feature. First real run kept
  `wt-swap`, which turned out to hold 7 staged source modifications on a *parked* branch. `--force`
  would have destroyed real work.

Measured on the first run: **86 GB reclaimed**, 5 trees removed, 1 correctly refused.

**`target/` is swept automatically — and ~20 GB per tree is NORMAL.** Cargo never reclaims a build
artifact: every distinct `-C metadata` (feature set × profile × lib-vs-test × rustc version × dep
version) mints a new one and orphans the old permanently. One entry point, `bsc disk gc`, runs the sweeps; it
is called from **the gate** and from `build:plan`, and is fail-safe (it swallows every error and
exits 0, because a janitor must never redden a gate or block a dev launch):

```bash
bsc disk gc --force         # force a sweep now — both directories, one report
bsc disk prune              # target/*/incremental — keep newest 1 per crate, >6h
bsc disk sweep              # target/*/deps        — keep newest 3 per crate, >6h
                            #   add --dry-run, or --root <dir> to sweep ANOTHER worktree
```

**It hangs off the GATE for a reason.** The sweeps originally ran only from `build:plan`, which only
`tauri dev` invokes — so the one tree ever collected was the tree where the app gets launched (the
one that had accumulated two months of orphans), and **no worktree had ever been swept once**. They
audited clean only because they were young. The gate is the single command every worktree agent runs.
`bsc disk gc` stamps the tree in `target/`, so repeat gate runs during iteration cost ~0ms, not 1.5s.
The stamp window is deliberately SHORTER than the age floor — when the floor came down to six hours a
one-day window would have inverted the invariant, skipping the sweep for four times longer than a
directory takes to become eligible. `gc.rs` pins that relationship in a test.

> **That two-defaults trap is gone by construction** (`the-disk-and-worktree-surface-moves-into-a-rust-crate`).
> It used to be real: `planPrune` carried its own defaults AND the runner always passed an explicit
> value, so editing the pure module's default was dead code — an earlier pass did exactly that, and
> the sweep kept running at 14 days while the docs claimed 3. Every `plan_*` function in `bsc-disk`
> now takes its policy as a REQUIRED argument, and the defaults are named consts the CLI reads
> (`sweep::DEFAULT_DAYS`, `pool::DEFAULT_KEEP`), so there is one place to change and no way to change
> the wrong one.

Set expectations from the measurements, not from the total:

- **One warm tree is legitimately ~21 GB** (incremental 8.8G · deps 7.4G · build 2.9G · a 1.4G
  static lib). The 245 GB across all trees is mostly *current* output, not garbage — the multiplier
  is having eleven trees, and the sweep does **nothing** for a young worktree (measured: 0 units on
  all ten). It bounds growth in a LONG-LIVED tree; the 2-month-old main tree gave up 5 GB.
- **`.fingerprint/` is deliberately NOT swept.** It accumulates identically (6939 dirs, some from
  June) but is **22 MB** against 24 GB in `deps/` — and sweeping 5408 of them made cargo treat those
  units as never-built and recompile **328 crates in 2m24s**. All cost, no benefit.
- **The degradation is real and accepted:** an rlib is not touched when merely *linked*, so a stable
  live dependency keeps an old mtime and can be swept, costing one rebuild. Bounded, never
  incorrect. Do not "fix" it by dropping the age floor to zero.
- The incremental default was 14 days and pruned **0 of 697**; at 3 days it pruned 214 and reclaimed
  5 GB. `--keep` never bound at any window tested — the age floor is the whole policy.

Gotchas:
- **Base drift:** a branch cut from an older `develop` can fail an *unrelated* test that broke since.
  Refresh with `git merge develop` and re-gate rather than chasing a phantom failure.
- Deleting the branch fails while it is checked out in a worktree — recycle it onto the next ref (or
  remove it) **first**, then delete the branch (order matters).
- A branch whose ref carries a migrated GitHub number (`4260-…`) is still purely local. The number is
  provenance, not a link to act on — do not `gh` anything on it.

### Dependency order for UI issues

```
#2 scaffold
  └─ #3 CSS + chrome
       ├─ #4 pane system
       └─ #5 store + router
            ├─ #6 Console screen
            ├─ #8 GitHub screen
            ├─ #9 Automations screen
            └─ #10 Settings screen
```

Issues #4 and #5 can be worked in parallel after #3 merges. Issues #6–#10 can be worked in parallel after #4 and #5 merge.

## Design Reference

**The design lives in the app.** The **Design Studio** (`src/features/designs/`, v1.0.51) authors pages, components, and animations in-app against the packaged `base-studio-code` kit, previewed live by the render-preview chain — and #3783 closed the external Claude-Design round-trip in the planner (the UI stage generates a navigable shell in-app; the drop-files intake survives only as the opt-in `external` `uiMode`).

The old `design/` folder — the browser-rendered Claude Design prototypes — was **removed** (#3834). Its trees had gone stale and partly broken, and the workflow they served is gone. Git history keeps them if a past screen ever needs consulting; a few `// Ported from design/bsc …` comments remain in `features/planner/relationship/*` as provenance.

> Not to be confused with the **runtime** `design/` directory inside a project hub (`fileIntake.ts`'s `INTAKE_DIR`, `project/ui_skeleton.rs`) — that is where a user's dropped design files are staged, and it is unrelated to the deleted repo folder.

## Companion App

**mobile-studio-code** lives in a separate repository. The WebSocket message schema between the two apps must stay in sync. Breaking changes to the tunnel protocol require coordinated PRs in both repos.
