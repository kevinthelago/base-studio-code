# Compiled nodes: a methodology for Rust in the algorithms graph

> **SESSION ARTIFACT — not maintained.** A METHODOLOGY NOTE answering whether a node can carry its compiled counterpart. It can: `bsc graph build` compiles a node from its own composes closure and stamps the verdict, with `--wasm` writing to a content-addressed sidecar. The wider work is the OPEN epic `epic-compiled-nodes-carry-their-artifact`.
> See [`README.md`](README.md) for why this lives here.

Answering "can a node carry its compiled counterpart, and would that simplify testing/building/gating?"

**Short answer: yes, and it is more valuable than it first looks — but for a different population than the
one the last review was about.** Every number below was measured on this machine on 2026-08-19, quiet
(no cargo/rustc/node running). Nothing in the repo or the live store was written.

---

## The measurement that reframes the question

I classified every Rust module and every Rust graph node by what it needs in order to compile:

| population | context-free (std only) | needs `crate::` / `super::` |
|---|---:|---:|
| **Leaf module candidates** (the file-migration target) | **7** of 132 | **125** of 132 |
| **Graph algorithm nodes** (already in the graph) | **82** of 83 | 1 |

These are two different kinds of thing, and the compiled-node idea works brilliantly for one and not at
all for the other:

- **Graph algorithm nodes are already context-free** — because `harvest`/`curate` lifted them *out* of
  their context. That is also exactly why they drifted from their files (last review: `severity_of` in
  the graph is a different function from the one that ships).
- **App modules are welded to their crate.** 125 of 132 reference `crate::` or `super::`, with a median
  of 4 internal references each.

And the hard constraint underneath: **rustc's compilation unit is the crate.** You cannot compile half a
crate. So a node can carry compiled code only where the node already *is* a compilation unit. That is a
property of the language, not of our tooling, and no amount of graph work changes it.

---

## What I proved works

### 1. The closure is already on the node

`merge-sort.rs` declares `composes: ['merge.rs', 'rust.vec', 'rust.slice']` and its code opens with
`use crate::merge::merge;`. The materialization rule falls straight out:

- composed record with `role: algorithm` → emit as a sibling module (`crate::merge::merge` then resolves)
- composed record with `role: primitive` → skip, it *is* std

I materialized that closure into a micro-crate and ran it:

```
closure: ['merge-sort.rs', 'merge.rs']   →  src/lib.rs + src/merge.rs + a 5-line Cargo.toml
cargo test:  COLD 5.51s   ·   WARM 1.66s   ·   1 passed
```

### 2. Standalone compilation already works for most nodes — and fails loudly for the rest

I compiled all 83 Rust algorithm nodes, each with its own closure, as isolated crates:

```
COMPILE standalone : 65
FAIL to compile    : 18
whole sweep        : 16.4 s   (serial, including one rustc process per node)
```

The failures are concentrated and diagnosable: 31×`E0423` + 19×`E0425` + 8×`E0433` — "cannot find value
/ type in scope". The harvest **strips the `use` statements**, so e.g. `word-frequencies.rs` calls
`HashMap::new()` with no `use std::collections::HashMap;`. Two records also carry a broken unicode
escape.

**That is the finding that makes the case.** The stored Rust nodes are *prose-grade, not compile-grade*,
and nothing in the repo has ever been able to tell. A compile check is the one oracle that cannot be
fooled — it would have caught all 18 of these, and it is the only thing that could have caught
`severity_of` silently becoming a different function.

### 3. The wasm artifact is small and fast

`wasm32-unknown-unknown` is already installed on this machine.

```
rustc --target wasm32-unknown-unknown --crate-type cdylib \
      -C opt-level=z -C panic=abort -C lto=fat -C codegen-units=1 -C strip=symbols

quick-sort.rs  →  12,385 bytes  in  865 ms
```

(Unoptimized it is 1.5 MB; the flags above are the whole difference. 82 nodes ≈ 1 MB total.)

### 4. There is a third copy of every algorithm, and it is unchecked

`quick-sort` exists in the graph **three times**:

1. `quick-sort.rs` — the Rust implementation
2. `quick-sort.ts` — the TypeScript implementation
3. `vizCode` on the node — a **hand-written JavaScript re-implementation** with animation hooks
   (`a.compare`, `a.swap`, `a.mark`)

**82 of 96 Rust nodes carry such a JS twin**, and 15 concepts exist in both the Rust and TypeScript
kits. Nothing checks that any of the three agree. A compiled wasm artifact lets the *real* code drive
the animation, collapsing three copies into one.

---

## The proposed methodology

### The node gains a `build` facet

```jsonc
"build": {
  "hash":     "sha256(code + closure code + toolchain + flags)",  // the cache key
  "verdict":  "pass" | "fail",
  "targets":  { "native": {...}, "wasm32": { "artifact": "<sha>", "bytes": 12385 } },
  "at":       "2026-08-19T...",
  "toolchain":"1.8x.0"
}
```

Artifacts go in a **content-addressed sidecar** (`~/.base-studio-code/knowledge/artifacts/<sha256>`),
**not** inline in `algorithms.json` — that file is already 8.74 MB and binaries would wreck it. The node
stores the hash; the bytes live beside it. This is sccache's model, at node granularity.

Unchanged hash ⇒ nothing recompiles. That is where "dramatically simplify" actually comes from: the
16.4s sweep collapses to a hash comparison for every node that did not move.

### Two tiers, and the boundary is the compile itself

| Tier | Population | What the node carries | How it is gated |
|---|---:|---|---|
| **R — Runnable** | 65 today, 83 after the import fixes | closure, native test verdict, wasm artifact | compiles + tests **alone** |
| **A — Attested** | the 125 crate-coupled modules | source + content hash + the crate that compiles it | gate asserts node bytes == file bytes |

The tier is **not a judgement call** — a node either compiles standalone or it does not. The check
assigns the tier, so it cannot rot the way a hand-maintained list would. Tier A is the emit-gate from
the last review, restated: it does not make a module independently runnable (nothing can), but it makes
"are these bytes the bytes that were actually compiled?" answerable.

### Sequencing

1. **Fix the 18 non-compiling nodes.** Mostly restoring stripped `use` statements. The compile sweep is
   the oracle, so this is mechanical and verifiable.
2. **Give `bsc graph test` a Rust path.** It is currently hardcoded TypeScript — it writes `{stem}.ts`,
   generates a `vitest.config.ts` and runs `npx vitest` (`cli.rs:90`). A Rust node handed to it today
   would have its source written into a `.ts` file and fed to vitest.
3. **Add the `build` facet + the artifact cache**, with the hash as the cache key.
4. **Wire `bsc graph gate` into `npm run gate`** — Tier R compiles and tests, Tier A attests. The gate
   is five steps today (typecheck, lint, vitest, clippy, nextest) and checks the graph **not at all**.
5. **Then the wasm payoff:** replace hand-written `vizCode` with the compiled node, and run one shared
   test vector against the Rust and TypeScript artifacts of the 15 shared concepts.

---

## What this does NOT do

It does **not** shrink the workspace gate. That is ~1m07s and ~8 GB, dominated by the 125
crate-coupled modules and by DuckDB — and those cannot be compiled per-node, because they are not
compilation units. Tier R nodes are not in the build path at all; they are a knowledge library.

So the honest framing: **this makes the graph trustworthy and gives it a gate it has never had. It does
not replace `cargo nextest --workspace`.** If per-node compilation of *app* code is the goal, that is a
crate-decomposition project — one node = one crate — and it belongs with
`isolate-command-surfaces-as-standalone-binaries`, where the measurement discipline for it already
lives.

One deliberate note on wasm: the epic weighed wasm+wasmtime and rejected it, on the argument that the
surfaces needing a hot swap are store surfaces (SQLite, DuckDB, filesystem) which are hardest in wasm.
**That rejection stands and this does not reopen it** — it was about command surfaces. Tier R nodes are
pure, std-only and do no I/O, which is the one population the argument does not cover.

---

## Recommendation

Do it, scoped to Tier R, in the order above — but treat step 1 as the real prize. The headline result
here is not that nodes *could* be compiled; it is that **18 of 83 do not compile and nobody knew**, and
that 82 of them carry an unchecked hand-written JS twin. The compiled-node mechanism is worth building
mostly because it is the only thing that makes those two facts impossible to reintroduce.
