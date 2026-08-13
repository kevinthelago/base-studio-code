# Kickoff — sandbox-by-default, then the planner/designer/librarian path

You are picking up a settled plan. The design decisions below are **already made by the maintainer**;
do not relitigate them. Your job is to execute in order, verify against reality rather than against
tests alone, and stop to ask only where this document says to.

Read `CLAUDE.md` first. Work each issue in its own worktree under the repo root (`wt<issue>`), one
branch per issue, PR to `develop`, per the Parallel worktree agents section.

---

## Standing rules for this path

**Verify against the running system, not just the gate.** This codebase has repeatedly had work marked
done that was not: #4235 shipped nine drifted `shared/ui` records nobody was watching, five issues sat
open with their work already merged, #4148 was not reproducible at all, and #4154's "confirmed still
broken" turned out to be three *other* defects. A green suite is necessary and not sufficient.

**A silent skip is a bug.** The recurring failure shape here is machinery that reports success because
it looked at nothing — an exclusion nobody declared (#4239), a guard scoped to the wrong half (#4246),
an unknown flag ignored (#4154). If you add a check, make its *coverage* assertable, and make "no
findings" mean "nothing was wrong" rather than "nothing was examined".

**Never chain a state change onto a command that can fail.** Merge, verify `MERGED`, *then* close.

**`Closes #N` does not auto-close on a `develop` merge.** Close manually after verifying the merge.

---

## Phase 1 — #4260 · Sandbox by default (TOP PRIORITY)

Every agent session runs in the sealed WSL2 distro with per-agent filesystem isolation. The Settings
toggle is removed. There is one posture, not two.

### What already exists — do NOT rebuild it

| | state |
|---|---|
| #1988 — sealed WSL2 distro (`bsc-agent-sandbox`; no `/mnt/c`, no Windows interop) | **closed, built** |
| #1994 — per-agent FS isolation via **Linux users**, one locked-down home per agent | **closed**, landed in #2355 + #2379 |

Both halves exist. They are merely **opt-in**: `pty_create` takes an optional `wsl_distro`, and the only
thing that sets it is `src/store/slices/projects.ts:607` (`if (paths?.wslDistro) …`) at fleet start,
behind a Settings → Security toggle.

### The work

1. Every agent session launches into the distro — worker, director, triage, and the studio sessions
   (planner/designer/librarian). Not conditional on a setting.
2. Remove the Settings → Security toggle **and the store field behind it**.
3. Per-agent Linux user per session, so worker↔worker and worker↔director are isolated by the OS
   rather than by the `bsc-scope` write hook alone.
4. Update `CLAUDE.md` — it still calls per-agent isolation *"planned for v1.0.5"*, a month stale.

### The decision that gates this — ASK BEFORE BUILDING

**What happens when the distro is not provisioned?** Today that is harmless (the session runs on the
host). Once the toggle is gone it must mean something:

- **Fail closed (recommended, pending maintainer confirmation on #4260):** no distro ⇒ no agent
  session, with the provision action surfaced at launch — the shape the GitHub-readiness banner
  (#297 S1) already uses. If the isolation is the point, running without it is not a degraded mode.
- **Fail open:** silently run on the host. Guts the decision — the one time it matters is the one time
  it will not be there.

Confirm on #4260 before implementing. Everything else in Phase 1 is mechanical.

### Verify on a REAL fleet, via raw Bash — not through the hook, not in a unit test

#1994 is closed but has not been exercised end to end recently. This is the acceptance that matters:

- [ ] Two concurrent workers cannot read each other's worktree **via raw Bash**.
- [ ] A worker cannot read the director's home, and vice versa.
- [ ] No `/mnt/c`, no Windows interop from inside a session (the #1988 floor still holds).
- [ ] A fleet of N launches with N isolated users and no cross-talk.

If per-agent users turn out not to hold, **say so and stop** — that is a finding, not a blocker to work
around. Better learned before the toggle is gone.

---

## Phase 2 — the librarian gap

**#4136 · Librarian-curated algorithms land with no `src`/`folder`.** They cannot sit in the folder tree
the rail organizes by. `crates/bsc-graph` is now free (#4154 landed), so this can go immediately and
alone.

Note the shape of the recent fix there: `bsc graph impl set` merges (#4154), the provenance gate now
reads the **stored** record, and unknown flags error. Do not reintroduce a gate that inspects only the
supplied flags — that was the defect that blocked 17 entries.

---

## Phase 3 — the planner path

### #3787 · Migrate the planner/Projects panes into the graph (last thread of #3782)

The graph migration is otherwise **complete**: 12/12 pages render from the graph, 0 drift, 0 unbound,
`shared/ui` at 53/53. Follow the established recipe — page → graph source, behavior stays registered
code — and verify live (`bsc shot` + the `graph-loader` log), not compile-only.

### ⚠ REQUIRED CHECK — is the UI system routed into the project planner pane?

Do this **before** touching #3787, and report the answer even if nothing needs changing. Three issues
converge here and it is not currently clear which are real:

- **#4115** — *the planner must know which projects use our data-driven UI: a `uiSystem` axis.*
- **#3899** — *Discovery never asks whether the UI is generated in-app or dropped in; it just defaults
  to `custom`.*
- **#3783** — closed the external Claude-Design round-trip: the UI stage now generates a navigable
  shell in-app, and the drop-files intake survives only as the opt-in `external` `uiMode`.

**What to establish, with evidence:**

1. Does the planner's UI stage actually route into the in-app graph/Design-Studio path, or does it
   still land on the `external` drop-files intake by default? Check `uiMode` end to end — where it is
   set, what sets it, and what the default is when Discovery never asks (#3899).
2. Is there a `uiSystem` axis on a project at all yet (#4115), or is it still unbuilt? If unbuilt, the
   planner cannot know which projects use the data-driven UI — say so plainly.
3. Does the **project planner pane** surface the UI system / kit binding for the project, or is that
   only reachable from the Design Studio? Name the file and the code path either way.
4. `CLAUDE.md` states `mode` (not the removed lifecycle `category`) decides whether a built-in
   auto-pins the packaged UI kit — confirm that is still true in code.

Report as: *routed / partially routed / not routed*, each with the file and line that proves it. If it
is not routed, that likely reorders Phase 3 — #4115 and #3899 would come before #3787, because
migrating a pane that points at the wrong UI path just migrates the wrong thing.

### Then the smaller planner items

- **#4228** — lessons belong in the Planner, not Skills (the queue is per-project data on a surface
  with no project).
- **#3899** / **#4115** — per the check above.

---

## Phase 4 — the graph optimization route

**Correctness first. Do not optimize a graph with known-wrong records — it bakes the wrong ones in.**

### #4246 · Adjudicate the 22 drifted modules (blocking, and needs the maintainer)

The app renders the **store**; every guard checked the **seed**. #4247 added the store↔file guard, which
immediately reported **22 drifted modules across 5 pages**. The largest are not subtle:

```
security-profiles      differs from ProfilesTab.tsx    — 148 differing (file 151 / store   3)
github-pulse           renders LESS than Pulse.tsx     — 192 differing (file 130 / store  74)
automations-schedules  renders LESS than Schedules.tsx — 130 differing (file  80 / store  30)
skillspage             renders LESS than index.tsx     —  70 differing (file  75 / store  21)
```

Which copy is right is a **per-module judgement** — do not automate it. #4179 is the worked example for
`skillspage`. Start with `security-profiles`: 3 element nodes against 151 is less like drift than a
broken record, and it may resolve the class rather than one instance.

Only after adjudication: re-stamp them so they rejoin the reconcile (#4207 built `restampUnstamped`;
note it deliberately **defers `role: page`** records, because stamping one arms `seedAuthoritative` and
would force the seed over the store).

### Then performance, in this order

1. **#3871** — boot fires ~40 `bsc` process spawns at once, a ~6s stall before the app is usable. The
   biggest single win.
2. **#4152** — warm `bsc`: serve the hot read verbs from a long-lived process.
3. **#4149** — cull off-screen graph nodes and edges.

### #3087 · The curator loop — the keystone

A dedicated **curator** (not the director, not every worker) runs **post-landing** to harvest reusable
components + algorithms into the global stores and keep the graph minimal by command-driven
optimization. This is the only thing standing between *"the graph works"* and *"the graph compounds
across projects"*, and it does not exist yet.

It deserves its own session. Do not start it as a tail-end task.

---

## Also open, not on the critical path

Fork-ready and independent: **#4134** (Shift+Enter submits instead of newline) · **#3917** (a torn-off
window cannot be docked back) · **#4208** (two load-dependent test flakes) · **#3910** (a `bsc-ui` test
reads the developer's live store, red on `develop`).

Deferred with a recorded reason: **#4259** (off-screen preview capture — the durable fix for the
view-steering problem; the route is chosen and the killer risk retired, see the issue comment).

---

## Environment notes that will otherwise cost you an hour

- **The staged sidecar is `~/.base-studio-code/bin/bsc.exe`**, not `target/debug/bsc.exe`. Sessions exec
  the staged copy. `cargo build --bin bsc` then copy it across — and orphaned `bsc` processes can
  outlive the app and hold the file, so clear those first if the copy reports *Device or resource busy*.
- **`~/.base-studio-code/config/fleet/*.md` mirrors the packaged seed and WINS when present.** Editing
  `src-tauri/data/fleet/*.md` alone is invisible to a running install. Refresh the mirror + restart.
- **Cargo workspace root is the repo root**, not `src-tauri/`. In a worktree, `unset CARGO_TARGET_DIR`
  and scope with `-p <crate>`.
- Nested worktrees are **zero-install** — do not run `npm install` in them, and never junction
  `node_modules`.
