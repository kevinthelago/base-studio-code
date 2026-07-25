# `shared/lib/algorithms/` — the algorithms graph's node code, as real modules

Every implementation node in `@data/knowledge/algorithms.json` carries a `code` string: the reusable
implementation the graph promises "stands alone". Until #3465 that string was **hand-written into the
JSON** and nothing checked it — `llm-energy.ts` (#3462) shipped with no test referencing it at all, so
"self-contained" was a claim, not a fact. That is the same "declared but never rendered" failure the
react-d3 kit hit, and the graph's one guarantee is exactly the thing it would break.

So the code lives here as a **real TypeScript module** and the JSON is generated from it:

```
src/shared/lib/algorithms/<name>.ts   ← the source of truth
        │
        │  UPDATE_ALGOS=1 npx vitest run seedAlgorithms.gen
        ▼
src-tauri/data/knowledge/algorithms.json  (the node's `code`)
```

What that buys, none of which inspection can give you:

- **It compiles.** `tsc` type-checks it with the rest of the repo, so a node's code cannot be
  syntactically broken or reference a type that does not exist.
- **It runs.** Its test imports the module and executes it, so the behaviour is real.
- **It is genuinely standalone.** The generator test asserts each file has **no `import`** — the one
  property that makes "reusable outside the app" true rather than aspirational.
- **It cannot drift.** The same test fails when the JSON no longer matches the file.

## Adding one

1. Write `<name>.ts` — no imports, exported entry point, documented.
2. Write `<name>.test.ts` — execute it; this is the node's executable spec.
3. Add the node to `algorithms.json` with its `id`/`name`/`summary`/`composes` and `"code": ""`.
4. `UPDATE_ALGOS=1 npx vitest run seedAlgorithms.gen` to fill in `code`.

## Why these live in `shared/`, not in the algorithms feature

They are the algorithms *graph's* content, so `features/algorithms/` is the intuitive home — but the
app code that should DELEGATE to them (`shared/lib/fleet/fleetLive.ts`,
`shared/lib/github/fleetGithub.ts`) is itself in `shared/`, and **`shared/` may not import from a
feature** (#1626). Putting them in the feature would have meant either breaking that boundary or
leaving the logic duplicated — and duplication is the thing this issue exists to remove.

`shared/` is also simply where they belong on the merits: a module with **no imports at all** is the
most feature-agnostic code in the repo. The algorithms feature reads them the same way anything else
does. The graph JSON they generate stays backend-owned under `src-tauri/data/knowledge/`.

## Which direction the dependency runs

The app's own function keeps its app-specific types (`CoordState`, `GhPull`, …) and **delegates** to
the generic one here. That is the only direction that works: a graph node cannot import app types
without ceasing to be standalone, but the app can freely depend on a generic algorithm.
