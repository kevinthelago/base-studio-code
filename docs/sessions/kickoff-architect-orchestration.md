# Kickoff — architect orchestration

> **SESSION ARTIFACT — not maintained.** A KICKOFF BRIEF, consumed by the session it was written for.
> See [`README.md`](README.md) for why this lives here.


Paste the block below to start the next session.

---

Read `bsc plan get architect-orchestrates-the-system-sessions` first — it is the epic for this work
and carries the maintainer's directives verbatim, the grounding, and the open questions.

## Where things stand

`develop` is green. The three-tier funnel (architect → director → workers) landed this session and is
verified end to end:

- The **app starts nothing and pushes nothing.** `injectPrompt` has zero callers; `injectCallers.test.ts`
  is a ratchet asserting the empty set, so a new injector fails immediately.
- The **director starts nodes** (`bsc fleet wake` creates the pane instead of refusing) and reads its
  workers (`bsc fleet list`).
- The **architect reads its directors** (`bsc fleet directors`) — read-only, scoped by construction.
- The **decision ledger** (`bsc plan decision`) records what each tier decided and validates the cited
  authority clause against the stored requirement, so a citation is checkable rather than decorative.

## What the epic changes

The maintainer has redirected: the architect's Glance node should **expand into** the system sessions
rather than have them as L0 siblings; the architect **starts / stops / requests services from** system
personas; it **creates directors seeded with the discovery files**; it **starts new projects**; and
system sessions become **per technology**.

Grounding already checked: the algorithms graph partitions on `tech` (95 rust · 70 typescript · 13
python) and `bsc algorithms impl list --tech <t>` exists, so per-technology sessions map onto a partition
that is already there.

Three items carry supersession notes pointing at the epic — read them before touching their code:
`glance-reads-left-to-right-sessions-to-libraries`, `architect-sees-director-state`,
`funnel-architect-front-door`.

## Settle these two before building

1. **The injection trade.** The architect is `none` on git/github/code/net/ui and `restrictedAllow`
   *because* it ingests raw user prose — `roleModel.ts` says so explicitly, and being the least capable
   session is the mitigation. Starting sessions and creating projects widens exactly that surface.
   Name the mitigation deliberately (a fixed set of app-owned personas and scaffolds keeps "what can be
   started" a closed set no injected text can extend) rather than arriving at it one grant at a time.

2. **Does stop reach directors?** Stopping a studio is cheap and reversible. Stopping a director ends
   coordination of a running fleet, and under the no-app-injection model its workers have no other route
   back except the user's click. Both readings are defensible; the consequences differ a lot.

## Traps this session paid for

- **The kit-sync guard fires on almost any non-test `src/` edit.** `react-ui.json` bundles the
  first-party emit closure, so `GlanceCanvas.tsx`, `store/slices/projects.ts` and
  `shared/lib/session/**` all tripped it. `UPDATE_KITS=1 npx vitest run
  src/features/designs/lib/reactUiKit.gen.test.ts` is part of the gate, not a design-studio step. It
  surfaces as a confusing failure in the *designs* suite.
- **A generated-artifact merge conflict is resolved by regenerating**, never by picking a side —
  `react-ui.json` auto-merges into a state matching neither parent while looking resolved.
- **Records import app modules.** A hook registered in `graphPlatform.ts`/`appModules.ts` cannot be
  deleted even when empty; reduce it to an inert export (the `useFleetGate` shape) or record
  compilation breaks at runtime.
- **`bsc plan add` upserts CONTENT only** — status is a separate verb (`bsc plan status <ref> <status>`).
- **Verify a merge landed before stamping it.** One merge conflicted after the change record was already
  stamped `merged` this session.
- **A green suite is weak evidence for a deletion.** Three pumps removed this session had no tests at
  all, so the suite stayed green throughout.

## Still open besides the epic

`funnel-ui-into-stores` (in_progress) — the `awaiting` label is written to the store
(`plan-pane-shell` rev 14) but **unverified on screen**; `bsc shot frame` timed out and reaching the
state needs a project mid-funnel. The decision/authority readout is unbuilt: `bsc plan decision list`
returns the data, nothing renders it.

`only-the-user-resumes-a-session` (in_progress) — the launch half is fixed and maintainer-confirmed;
what keeps it open is that its acceptance now points at the tier-delivery model.

Also open: `coordinator-stops-waking-sessions`, `coord-prefix-names-the-sender`,
`coord-log-is-app-wide-answers-cross-projects`, `studio-dock-records-drifted-from-their-files`.

## Workflow

Local-first on the `bsc` surface, per `CLAUDE.md`: one item = one ref = one branch = one nested
worktree (`wt-<short>`, zero-install). Open the change record at the START. Gate is typecheck · lint ·
test · cargo where Rust changed, plus the kit regen. Record what each gate **actually** did; a skipped
gate is recorded as skipped. Stop at `complete` — the actor that wrote the change does not verify it.
No pushes, no GitHub writes.

`bsc app shot take` works against the running app and is the only way to see layout or cascade.
