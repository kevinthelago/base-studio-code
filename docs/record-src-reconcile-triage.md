# record-src-reconcile — record↔file provenance: RESOLVED

`node scripts/reconcile-record-src.cjs` now reports **zero** unresolved records.

    384 packaged records:  ok 242 · intentional 119 · null-src 23
                           stale-pointer 0 · moved 0 · drifted 0

Every record either matches the file its `src` names, carries a specific `srcDivergence` saying why it
deliberately does not, or has a null `src` (with `srcRetired` naming the file it superseded).

## Why almost all of it was NOT staleness

The item began from #4235s finding that the FILE was the newer copy nine times out of nine. Measured
across all 384, the difference is overwhelmingly BY CONSTRUCTION, because a record has two constraints a
file does not:

1. **It must be self-standing.** The loader resolves only registered modules and sibling records, so a
   record VENDORS what a file may simply import — and may never carry a relative specifier.
2. **It must render with no props and no backend.** The preview mounts a record cold, so records default
   their parameters, substitute sample data for `invoke`/`useAppStore`, and stub handlers.

Those two produce four annotated classes: preview parameterization, preview data substitution, vendoring,
and deliberate stubs for components that cannot run in a preview at all (`terminalview` drives a real PTY).

## What WAS genuinely stale — the real finds

- `tabstrip` — hand-rolled its tab row and silently ignored `onClose`/`onAdd`/`onRename`/`onReorder`/
  `onTearOff`, all props it declares; also predated stable tab-id identity.
- `collapsiblecard` — rendered an older design (bare glyph vs the file bordered mono icon chip).
- 4 settings cards — user-facing COPY rewritten in the files and never propagated;
  `issuesecuritycard` still described the toggle without the untrusted-input-channel rationale.
- `accessibilitypage` — omitted `<TtsCard />`, the page only card.
- `tablepage` — stale padding, and raw spans where the file had refactored to a shared `ELLIPSIS`
  carrying `minWidth: 0` (without which a long cell widens its column instead of truncating).
- `glancechatdock` — a stale ACCESSIBLE NAME (“Collapse stream” vs “Collapse stream (agent stays alive)”).

Each was MERGED, never copied: the file logic taken, the record preview affordances kept.

## Keeping it at zero

- `node scripts/reconcile-record-src.cjs` re-runs the whole check; it writes only under
  `--apply` / `--annotate` / `--retire`.
- `seedProjectionCoverage.test.ts` stops a new record field being silently dropped by the projection
  allowlist — the failure `seedRoundTrip` structurally cannot see.
