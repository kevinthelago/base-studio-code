# Decompose (#228)

The bridge where the planning model (#201) meets the FeatureContract (#200). Walk the
plan tree, take the **contract-ready** feature/component nodes (the maturity gate,
`kickableNodes`), and emit a `FeatureContract` skeleton for each. The output renders to
issue bodies (`renderFeatureContract`) and feeds the publish adapter (#226).

## `decompose(plan, opts) → FeatureContract[]`

For each kickable node it derives:
- `id` / `title` from the node; `goal` from `node.summary` (or `Implement <title>.`);
- `owns` from the node's **nearest layer ancestor** via `opts.ownsByLayer[layer]`;
- `stream` = that layer id;
- `dependsOn` from `opts.dependsOn[nodeId]`;
- `verification.gate` from `opts.gate`.

The **seam fields** (`consumes` / `produces`) and acceptance detail are left as minimal
placeholders — they come from the plan's contract edges / the planner, not from the bare
node. So decompose produces *issue skeletons*, ready to finalize and publish.

## Options

`{ gate?, dependsOn?, ownsByLayer?, kinds? }` — `kinds` overrides which node kinds are
decomposed (default: `feature` + `component`, i.e. the work kinds).

## Pipeline

```
plan tree (#201) ──decompose──▶ FeatureContract[] (#200)
                                   │
                   renderFeatureContract ──▶ issue bodies
                   buildPublishPlan (#226) ──▶ PublishOp[] ──▶ gh executor (follow-on)
```

Only `contract-ready` nodes flow through — under-specified parts of the plan stay out of
the work queue until they mature.
