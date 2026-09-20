# Rust → algorithms-graph migration: what is actually available

> **SESSION ARTIFACT — not maintained.** A POINT-IN-TIME REVIEW, measured 2026-08-19. The direction it surveyed happened: the algorithms graph now holds 204 rust implementations, and `npm run gate` compiles the rust nodes on every run.
> See [`README.md`](README.md) for why this lives here.

A review of the Rust/backend tree for records-migration opportunities, measured against the live
tooling on 2026-08-19. Every number below came from running the shipped `bsc` binary or scanning the
tree — nothing is estimated. No file in the repo and no live store was written; the write experiments
ran in a throwaway store via `BSC_GRAPH_STORE`.

---

## The headline: for Rust, "retire the file" is not on the table

The frontend campaign deleted ~1,050 modules because a **runtime loader** resolves a record before the
bundle ever needs the file. Cargo has no such loader — **it compiles the file, always.** So the Rust
equivalent of that campaign is not a deletion. It is an **authority inversion**: the record becomes
what an author edits, the file becomes an emitted artifact, and a gate catches the two disagreeing.

This is not a new finding — it is already decided. `epic-command-surfaces-are-nodes`, decision 2
(2026-08-17): *emit stays COMMITTED, not generated*, because gitignoring it breaks rust-analyzer,
clippy's view, git blame, sccache source-path keying and code review.

**So the honest scope: this migration retires zero `.rs` files.** What it buys is history, revert,
composes edges, and one authoring surface — not a smaller tree. Worth doing, but it should not be sold
or measured as the frontend campaign was.

The tree in question: **331 `.rs` files · 127,508 lines · 6.33 MB** across `src-tauri/src` + `crates`.

---

## What works today, proven end to end

`harvest --module` on a `.rs` file produces a **byte-exact whole-file candidate**, and `emit` writes it
back to **exactly the path it came from**. That round trip is real and I ran it:

```
bsc algorithms harvest crates/bsc-persona/src/lib.rs --module --apply   → id=lib.rs, src=crates/bsc-persona/src/lib.rs
bsc algorithms emit impl lib.rs <dir>                                   → <dir>/crates/bsc-persona/src/lib.rs
```

It lands back over its own file because `emit_path` is `<folder>/<id>` and, for a *module* record, the
id **is** the filename. The "never write over the shared `src`" guarantee in `emit.rs` protects
function-level records — it does not obstruct module records. That is the mechanism the migration
needs, and it exists.

The prepended provenance stamp compiles: `// stamp` above a `//!` inner doc comment and a `#![...]`
inner attribute is legal Rust (verified with `rustc --edition 2021`, exit 0).

---

## The opportunity, tiered

| Tier | Files | What it is |
|---|---:|---|
| **1 — viable now** | **132** (2.35 MB) | Unique basename · declares no submodules · no `#[tauri::command]`. Round trip works today. |
| 2 — blocked on id collision | 153 | Basename is not unique. Cannot round-trip at all (see below). |
| 3 — already migrated, as inventory only | 46 records | Function-level records carrying `src`. Can never become build-authoritative. |

Tier 1 by area — the concentration is real, not spread thin:

```
plandb 23 · data 13 · bsc-component 11 · llm 8 · research 7 · bsc-cad 6
src-tauri/console 6 · src-tauri/platform 6 · bsc-util 5 · bsc-agent 4 · bsc-ui 4 · bsc 4
```

Good first targets are small, leaf and pure: `crates/plandb/src/{classify,market,requirement,skipped,
deploy,triage}.rs` (46–86 L), `crates/bsc-cad/src/stl.rs` (42 L), `crates/data/src/source_meta.rs`
(36 L), and `bsc-tunnel`'s `noise.rs` (34 L) — the last of which has since migrated and is now the
record `bsc-tunnel--noise.rs`.

---

## Four defects that block the epic's own acceptance criteria

### 1. The id is load-bearing twice, and the two roles conflict — this kills slice 1 as written

A module record's `id` is the **bare basename**, and that same id is the **emitted filename**. For
Rust those two requirements are incompatible: **153 of 331 files** share a basename — `lib.rs` ×39,
`cli.rs` ×28, `mod.rs` ×24.

The guard is good and it refuses correctly:

```
bsc: 'lib.rs' already names a DIFFERENT module: crates/bsc-persona/src/lib.rs
This harvest would overwrite it, because a module id comes from the file stem and `impl set` merges by id.
Rename one of the files, or write the record deliberately with `bsc algorithms impl set --id <a-distinct-id>`.
```

But **the workaround it suggests breaks emit.** Measured: writing the teams module as
`--id bsc-teams-lib.rs` emits to `crates/bsc-teams/src/bsc-teams-lib.rs` — the wrong path, and a
hyphenated name that can never be a Rust module (`mod bsc-teams-lib;` is not an identifier).

**Consequence for the plan as filed:** `command-surface-crates-become-graph-records` names
bsc-persona (317 L) + bsc-teams (167) + bsc-blueprint (151) as slice 1. Those are six files across
exactly **two** ids — `lib.rs` and `cli.rs`. Under the current derivation the slice can migrate one
crate, not three. The id scheme needs a path-derived form (e.g. `bsc-persona--lib.rs`, or an id
distinct from the emit filename) **before** slice 1 is picked up.

### 2. The round trip is not byte-identical — two independent causes

The slice's acceptance says *"the emitted source is byte-identical to what the crate compiled from
before the migration."* Measured on `crates/bsc-persona/src/lib.rs` — 3,948 B in, 4,109 B out:

- **the stamp line** is prepended (by design, ~160 B); and
- **line endings are corrupted**: the original is pure CRLF, the emitted file is mixed CRLF+LF.
  `render()` does `format!("{}\n", code.trim_end())`, so the stamp's terminator and the final newline
  are LF while the body stays CRLF.

Cause 1 means the criterion needs rewording (byte-identical *body*, which `emitted_body` already
isolates). Cause 2 is a real bug and matters more than it looks: on a repo with `.gitattributes` and a
gate that would diff emit against disk, a mixed-ending file churns.

### 3. A Rust module's carried "test" is a byte-for-byte copy of the module

Rust keeps tests inline in `#[cfg(test)] mod tests`, so the colocated-test harvest — correct for
TypeScript's separate `*.test.ts` — grabs the whole file. Verified on `crates/bsc-util/src/deny.rs`:

```
code len: 9732   test src len: 9732   test src == whole module code?  True
```

**116 of the 132 Tier-1 candidates carry inline tests**, so a naive migration stores ~2.3 MB twice:
the store would grow from 8.74 MB to ~13.4 MB, roughly half of it pure duplication. The Rust path
needs to either extract the `#[cfg(test)]` block or carry no separate test at all.

### 4. Nothing gates emit drift — and the drift is already here

The gate is five steps — typecheck, lint, vitest, clippy, nextest (`scripts/gateScope.mjs:31`). There
is **no emit or drift step**, and no reference to `graph emit` anywhere in `scripts/` or
`package.json`. The epic is explicit that this is the whole design requirement: *"emit has to be
gated, or the records are decoration that diverges within a week."*

That is not hypothetical. Of the **46** existing Rust records carrying a `src`:

| | count |
|---|---:|
| record body still matches the file | **13** |
| **drifted** — function found, body differs | **28** |
| function name not found in the claimed file | 2 |
| `src` points at a crate that no longer exists (`crates/netcon-core/`) | 3 |

Two of those "drifts" are worth separating, because they are different problems. `jaccard` differs
only by harvest normalization (visibility promoted to `pub`, type paths fully qualified) — benign.
`severity_of` is a **different function entirely**: the record is
`severity_of(scores: &[f64]) -> f64`, the file is `severity_of(v: &serde_json::Value) -> Severity`.
`curate` idealized it into a library form. That is the state the whole set is in: **inventory-grade,
not source-grade.**

And `relink` cannot repair it — measured `--dry-run` on the live store: `alreadyLinked: 909,
linked: 0, unmatched: 41`. It recovers a *missing* `src`, not a *stale* one.

### One thing that is NOT a hazard, checked

`bsc algorithms emit all` against the repo root would write 948 files, 83 of them `.rs`, and **overwrite
zero existing tracked files**. The 83 are new stray files (`crates/cve/src/split-segments.rs`,
`core/merge-sort.rs`, …). They are clutter, and their hyphenated names could never be compiled as
modules, but there is no data-loss trap sitting in the tree today.

---

## Recommendation

Do the migration, but fix the tooling first — three of the four defects are one-slice fixes, and every
one of them is cheaper now than after 132 records exist.

1. **Fix the module-record id derivation** so it is path-derived and collision-free, and decouple it
   from the emit filename. This is the gating change; without it Tier 2's 153 files are permanently
   unreachable and slice 1 cannot be done as filed.
2. **Fix the CRLF handling in `render()`**, and reword the acceptance criterion to byte-identical
   *body* (which `emitted_body` already gives you).
3. **Stop duplicating the module into its own test slot** on the Rust path.
4. **Add the emit-drift gate step** — it is the entire reason the inversion is safe, and it is the one
   piece the epic says the design rests on. Add it *before* the first migration, not after.
5. **Then migrate Tier 1 in tranches**, starting with the small `plandb`/`bsc-cad`/`bsc-tunnel` leaves.
6. **Separately, decide what to do with the 33 stale function-level records.** They are a knowledge
   library, not a build input, and they should be either re-harvested or explicitly marked as
   idealized so nobody reads them as the code that ships. The 3 pointing at `crates/netcon-core/`
   should be suppressed or repointed.

One scoping note worth stating plainly: none of this reduces the file count, and the store grows by
roughly 2.4 MB (4.6 MB if the test duplication is not fixed first). The return is authoring surface,
history and revert over 132 modules — not a smaller codebase.
