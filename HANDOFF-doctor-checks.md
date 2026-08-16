# Handoff — the doctor/graph-health half of the open designer requests

Three of the six open `bsc request` items are new **static checks over the component store**. They all
land in `crates/bsc-component/src/graph_health.rs` and its TS twin `src/features/designs/lib/graphHealth.ts`,
and none of them touch the preview runtime — which is what the other session is working, so the two halves
do not collide.

Plan items are already filed. Work them in this order (cheapest and most load-bearing first).

---

## 1 · `props-metadata-that-does-not-match-the-signature-has-no-bulk-check` (request #88)

A doctor finding that parses each record's top-level destructured prop signature (or its interface/type
block) out of `srcText` and diffs it against the record's `props[]`, naming the specific missing/extra
props.

Do this one first: an **empty `props: []` on a component with a real typed signature** silently disables
the preview's sample-data synthesizer, and four such components were found one at a time by accident
(`github-language-mix`, `github-open-prs`, `github-activity-heatmap`, `railtree`). Running this in bulk
partitions the open render-error backlog into "fixable by populating metadata" vs "needs the infra fix" —
which is worth more than the four individual repairs.

## 2 · `a-composes-edge-that-names-nothing-is-reported-as-a-duplicate` (request #89)

A `composes[]` entry that resolves to no component id or name gets its own finding category
(`dangling-composes-reference`), distinct from orphan/dangling-branch/duplicate.

The evidence: `GhGroup` and `GhReposGroup` both declared `composes: ["GhItemRow"]` against a component that
existed nowhere. Doctor reported them as a fuzzy near-duplicate **pair** instead, whose suggested action
("merge X into Y") is not just less useful — it is impossible, because the preview sandbox forbids the
first-party import a merge would require. The right fix in every instance of this pattern
(`LocalPageFallback`'s 11 wrappers, the 4 mobile-layout routes) is to author the canonical record the
dangling reference already names.

Note the Standards doc already **claims** this check exists. Part of the job is making the doc and the
code agree — either way round.

## 3 · `a-family-of-siblings-that-skips-its-shared-shell-is-invisible` (request #87)

Given a widely-composed primitive and a grouping convention (folder or name-suffix), report which family
members do **not** compose it. Plus a companion check flagging raw hex/rgb literals in `srcText` as a
use-a-design-token finding.

This one has a measured cost attached: answering "are these ~35 `settings/*Card` components duplicated?"
took a **~480k-token fork** of manual srcText reading, because `dupes`/`similar` structurally cannot see
"shares a shell primitive" when the props differ (a toggle card has `enabled`/`onToggle`, an info card has
`value`/`label`). `bsc ui used-by ui-card` answered it in one call — 77 composers, one real outlier
(`AutomationCard`, which hand-rolls its own Surface/Tag shell and a hardcoded hex theme object).

---

## One thing to know about the other half

The three preview-runtime items (#84/#85/#86) are done and sitting on local branches awaiting review:
`the-loaded-state-drops-a-required-container-prop`, `the-preview-has-no-vite-raw-import-either`,
`the-sampler-silently-omits-a-required-prop-it-cannot-type`. They do **not** touch `graph_health.rs` or
`graphHealth.ts`, so nothing here collides with them.

Two of them matter to this work anyway:

- **#88 partitions with #84.** `bsc ui preview-props` now emits an `unsampled` array naming the REQUIRED
  props whose type the sampler cannot read. That is a different failure from an empty `props: []` — this
  check's target — and having both makes the render-error backlog separable: a component with no props
  metadata at all is #88's, one with correct metadata and an unreadable TYPE is already reported.
- **The `props: []` records are the bigger half.** Of 585 records, **231 carry no props metadata**, against
  7 components with an unsampleable type. That ratio is the argument for doing #88 first.

⚠️ All three of those branches regenerate `react-ui.json` + `react-ui-kit.meta.json`, so they will conflict
with each other on merge. Regenerate, never hand-merge — see the `kit-meta-conflicts-on-every-merge` note.
If a check here ends up importing something from `componentPreview.ts`, expect the same.

## Working notes

- Read each item first: `bsc plan get <ref>` — the acceptance criteria are on the record.
- One ref = one branch = one worktree, cut from local `develop`, nested at the repo root as `wt-<short>`
  so it stays zero-install.
- Open the change record at the **start**: `bsc plan change new <ref> --note "<title>" --description "…"`.
- All three findings exist in **two** implementations that must stay in lockstep — the Rust `graph_health`
  and the TS `graphHealth` twin. Same input, same findings.
- Gate: `npm run typecheck` · `npm run lint` · `npm test` · `cargo check --workspace` ·
  `cargo clippy --workspace --all-targets -- -D warnings` · `cargo test -p bsc-component`.
  Record what each one actually did with `bsc plan change gate <ref> <name> <pass|fail|not-run>`.
- Iterate with `cargo check -p bsc-component` / `cargo test -p bsc-component --lib` — building the `bsc`
  binary is ~9s warm and ~343s cold, and the crate's own tests reach the whole CLI surface.
- Nothing is pushed. Stop at `bsc plan status <ref> complete`; the reviewer stamps `verified` and merges.
- When each lands, resolve its request: `bsc request resolve <88|89|87> --note "…"`.
