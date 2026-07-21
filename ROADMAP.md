# Roadmap

A snapshot of where **base-studio-code** is and where it's headed. Dates aren't promised; **sequence is**.

We work one version at a time, **release-and-continue**: a version ships builds early and stays **Current** — actively worked — until its theme is complete; only then does the next minor become the focus. A released build is a checkpoint, not the end of the version.

| Version | Status | Theme |
|---|---|---|
| `1.0.3` | ✅ Complete | User experience, resiliency, the core **Default** blueprint + triage — and the parallel **run-on-any-model** `bsc-agent` pillar |
| `1.0.4` | ✅ Complete | **Enterprise integration & migration** — connect read-only to ERP/CRM/BPM, scan data + configs + behaviors into canonical data models, generate bespoke software with compliance baked in |
| `1.0.4n` | ✅ Complete · fix & polish | The rolling `1.0.4n` fix-and-polish line (`1.0.41`, `1.0.42`, …): the **codebase refactor & consolidation** sweep, **integrations as agent-authored connectors**, a data-driven planner, a wave of planner/fleet hardening, and ongoing polish |
| `1.0.5` | ✅ Complete | **The UI release** — in-app page/component/animation authoring with iterative generate→preview→refine loops — **and the maintenance bots** (#1957). Shipped through the **v1.0.51** build; UI/design-studio work still in flight rolled forward to the `1.0.52` milestone |
| `1.0.51` | ✅ Complete | **Market research, marketing & usage analytics** — the **Marketer** (market on your behalf via channel MCP servers) + generated-apps **usage analytics** |
| `1.0.52` | 🚧 Current | **Accessibility & text-to-speech** — plus the continued UI / design-studio work rolled forward from `1.0.5` |
| `2.0.0` | 🎯 Unification | Once every feature is added and the app is a defined product: cut `2.0.0` and switch to **rigorous semver**, followed strictly from there |

> **Versioning is loose until v2, on purpose.** The app is still coalescing, so numbering trades
> tidiness for velocity: **`1.0.4n`** (bump the trailing digit for each fix/polish release) → the themed
> **`1.0.5x`** steps (**`1.0.5`** UI release → **`1.0.51`** market research/analytics → **`1.0.52`**
> accessibility & TTS, current) → **`2.0.0`** (unification, then rigorous semver from there). The phase
> boundaries are tracked as GitHub milestones.
>
> _(The dated per-version sections below still describe the `1.0.4`/`1.0.5` era and lag this table — a
> fuller catch-up of that prose is pending.)_

---

## ✅ Complete — `1.0.3` · user experience, resiliency & the core Default blueprint and its triage

> Shipped, and the focus has moved on to `1.0.4`. The items below landed across the `1.0.3` line (including the parallel **run-on-any-model** pillar).

- **Run on any model** *(parallel pillar)* — a model-agnostic agent shell we own, **`bsc-agent`**: an `LlmProvider` layer (Anthropic, OpenAI, Gemini, local; `crates/llm`) plus a native agent runtime — tool use, native permission enforcement, telemetry + transcript, ancestor context + skills loading, and an MCP client — packaged as a sidecar and selected per session behind a `HarnessAdapter`. It emits the same contracts as Claude Code, which **stays the default until parity**
- **Simplicity** — a foolproof, trimmed **Default** blueprint; the advanced stages (MCP servers, automations, skills) moved to a new **Complete** blueprint
- **Planner consolidation** — Blueprints folded into the planner page with the live render-preview; lifecycle categories, the drag-reorder editor with the Design-with-Claude assistant, attachable skills/knowledge, file intake, gist sharing, and authoring your own blueprint
- **Dependencies in Deploy** — the planner locks every repo's libraries (and their registries/sources) once; publish seeds each repo's `package.json` / `Cargo.toml` (+ `.npmrc` / `.cargo/config.toml`) and the role gate keeps workers from redefining them, so the parallel fleet stops colliding on deps
- **plan.db working store** — the plan's live state (context required-set, fleet + per-stream permissions, deploy, MCP, the authored blueprint, issues) moved into a per-project SQLite store, rehydratable from GitHub
- **Progress-gated triage** — relaunch reads issue status from plan.db, resumes from what changed, and **skips workers that already finished** so completed work doesn't restart
- **Resiliency** — **crash recovery** (unclean-shutdown detection + one-click session restore), faster/lazier boot (metrics + logging deferred off the startup path), durable per-project repo links, and **log management** (view / filter / limit / clear / export in Settings → Logs)
- **Richer publishing** — repos go out with a description, stack-derived topics, and a plan-driven README, plus the standard community-health files
- **Fleet model** — least-privilege workers in git worktrees coordinated by a director; workers build against planned contracts **in parallel** (no runtime dependency-wait) and don't spin up their own sub-agents
- Parallel **console** sessions, the **Skills** library, **GitHub** integration, **automations**, **MCP extensions**, the **Deploy** stage + pane, and the optional **mobile tunnel** (zero-knowledge Cloudflare relay, Noise IK E2E)

## 🚧 Current — `1.0.4` · enterprise integration & migration

> Released and in active development — we ship builds early and keep working `1.0.4` until its theme is complete.

- **Pull data from enterprise systems** — ERP, CRM, BPM, and other software solutions — into canonical **data models** via **agent-authored connector manifests** (the planner probes the source and authors the connector — no native per-vendor code) + MCP connectors (Salesforce, monday.com, QuickBooks, Quickbase, HubSpot, Airtable), capturing **data, configurations, and behaviors** (automations, business processes), not just rows
- **Migrate off an existing solution to bespoke generated software** — the source scan dictates the app's schema + logic; map it into your own custom app, generated and run by the fleet
- **Compliance** — a user-updatable Compliance MCP server (regulations, accessibility, user-protection) integrated into the planner, so generated software is compliant by default
- **Research** — a **built-in** literature MCP server (arXiv · Semantic Scholar · PubMed/PMC · Crossref, native PDF extraction, citation-grounded search), so the planner can ground plans and skills in the latest real sources with no download, build, or Docker
- **Console polish** — native copy/paste (hotkeys scoped to the Console page) and Claude's own TUI input restored, with auto-redraw nudges for the CLI's jumbled-text bug
- **Hardened agent isolation** *(security track, #1916/#1988)* — the least-privilege model moved to a **deny-list** (sessions auto-run, gated by always-on PreToolUse hooks; the allow-list is an opt-in posture toggle), plus an opt-in **model-agnostic OS sandbox**: sessions run inside a **sealed WSL2 distro** (no `/mnt/c`, no Windows interop), so the *environment* is the cage and any LLM is confined — built and installed from **Settings → Security**. Per-agent isolation (a Linux user per worker/director) is queued for `1.0.5` (#1994)

## 📦 Checkpoint — `1.0.41` · consolidation & hardening ahead of the UI release

> The large volume of no-user-facing-feature refactor, integration-architecture, and fix work that accumulated on the `1.0.4` line, cut as a labeled checkpoint before the `1.0.5` UI release. Everything here ships continuously to `develop`.

- **Codebase refactor & consolidation** — a structural-debt sweep clearing the runway for the UI release:
  - **Feature-first frontend** — the React tree reorganized into vertical slices (`app/` shell · `features/` UI + pure `lib/` + slice + `index.ts` barrel · `shared/` · `store/`) with a `@/…` path alias replacing deep relative imports; every rail screen's entry lives at its `index.tsx`
  - **Shared UI primitives & a consistency sweep** — scattered UI consolidated onto one primitive each: `Banner`, `Card`, `Button`, `StatTile`, `EmptyState`, `BackButton`/`IconButton`, `StatusDot`, `ModalScrim`/`Dialog`, `Toggle`, `Avatar`, `LabelChip`, the analytics charts, and promise-returning prompt/confirm dialogs; a `.mono` typography vocabulary and a dead-CSS pass
  - **Decomposition & dedup** — the ~3k-line `Planning.tsx` and `FocusedBodies.tsx` split into focused, colocated hooks and per-body files; `handlePublish` extracted into a React-free `publishSteps.ts`; reusable `usePoll`/`useGithubQuery`/`useCoordLog` + `safeInvoke`/`fireInvoke` replacing hand-rolled boilerplate
  - **Rust consolidation** — a shared `bsc-cli-util` crate; blueprint + published-marker logic delegated to the Tauri-free `bsc-blueprint`/`bsc-project` crates; the mobile-tunnel core extracted to a Tauri-free `bsc-tunnel` crate; launch/settings/permissions consolidated into a `session/` domain; normalized crate naming (dir == package); `src-tauri/prompts` → `src-tauri/data`; **plan.db is now the sole fleet store** (legacy `fleet.json` reader removed); `tests.rs` decomposed; the orphaned reference-context subsystem removed
- **Integrations as agent-authored connectors** *(epic #1962)* — the planner now probes a source and **authors the connector as a validated manifest** (probe → validate → try, captured as reusable skills). The native per-vendor connectors, presets, and catalog were **removed** in favor of a manifest-only scan, a **dynamic Source pane** (declare → build → confirm mapping), and runtime **self-describing OAuth** in the manifest — plus a connector dev-loop CLI (`bsc data connector probe/validate/try`)
- **Data-driven planner** — the Rust-inline planner prose, the stage registry, the role→capability table, and the deploy taxonomy/enums extracted to `@data/*` single sources; planner tag-parsing migrated to `bsc` reads and the dead parsers / stale prompt emitters removed
- **Planner & fleet hardening** — a unified **stage vocabulary** (one canonical token per stage) with milestone phases removed; the **Repos + Deploy** stages merged into one **Deployment** pane and **Fleet + Streams** into one **Streams** pane (both carded and collapsible); plus a wave of fixes: the Fleet "No fleet running" identity mismatch, the stale warden re-quarantine across relaunch, worker folder-trust and the `bsc-*` prompt-on-every-command, the triage/fleet tab mis-named "# Goal", session settings written to a bogus cwd path, conflicting self-merge vs `auto-pr` stream responsibilities, and mode-aware deploy gates
- **Observability** — pane-tagged permission-deny logging (`perm.log`) from the deny hooks, surfaced as a stream in `crates/logs`

## 🔜 Next — `1.0.5` · the UI release

- An in-app, **Claude-Design-like** way to define each **page, component, and animation** — generate, preview, and iterate UI inside the planner (closing the external Claude Design round-trip), rendered live by the render-preview
- **UI loops** — iterative design loops that **generate → live-preview → refine** a UI in-app until it's right, the same tight loop the agent fleet runs for code

> Foundation work for the `1.0.5` line, landing ahead of the UI editor:

- **Integrations platform** — one global connection registry reused across every project, projected four ways (migration **data source** · **incident/CVE** stream · **MCP server** · **app seed**); connectors are **authored by the planner agent** as validated manifests
- **Per-agent OS isolation** — a Linux user per worker/director inside the sandbox (#1994), building on the sealed-WSL2 environment
- **Maintenance mode** — a worker that finishes its issues stays alive in a ready posture for the director to dispatch new or regressed lane work to, instead of ending

## Later

- The execution-side **conductor** (staged build → test → review → integrate)
- Expanded blueprint catalog and richer per-stage gates and checks

---

## Versioning & Releases

base-studio-code is on the **`1.0.x`** series and under active development. **`1.0.0` was the first official release** — the first version considered stable and ready for general use. The `1.0.x` line is bumped conservatively: **patch** bumps for fixes and small improvements, **minor** bumps for feature releases (e.g. enterprise integration & migration lands as `1.0.4`).

We work one version at a time, **release-and-continue**: a version ships builds early and stays **Current** — actively worked — until its theme is complete; only then does the next version become the focus. A released build is a checkpoint, not the end of the version. Until `2.0.0` the numbering is loose (see the phase note above); from `2.0.0` on we follow rigorous semver.

**Cutting a release** is one command — `npm run release` bumps the version (both `package.json` and `tauri.conf.json`), stamps the CHANGELOG, commits, tags `vX.Y.Z`, and pushes, which triggers the build + GitHub Release. See [CHANGELOG.md](CHANGELOG.md) for the full release history.
