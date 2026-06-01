# gh executor (#230)

Run a publish-adapter `PublishOp[]` (#226) against GitHub — the side-effecting layer that
actually creates the board / milestones / labels / issues / sub-issues / dependencies.

## Pure orchestration, injected side effects

`executePublish(ops, repo, perform)` is **pure orchestration**: it decides the requests
and threads created ids forward, but the side effect — performing a request — is an
**injected `perform` function**. So it's unit-testable with a mock performer (no GitHub),
and the real performer is a thin Tauri adapter over `github_post` / `github_request`.

```
PublishOp[]  ──executePublish(perform)──▶  ordered GhRequests  ──perform──▶  GitHub
```

## What each op does

- `milestone` → POST a milestone (number cached for issue assignment).
- `label` → POST a label.
- `epic` → POST the parent issue, then each child; for non-`parent+task-list` rungs, link
  children via the **sub-issues API** using the child's **database id** (threaded from the
  create response).
- `dependency` → the `body-text` rung posts a `depends_on:` comment on the source issue;
  richer rungs (Project field / native relationship) are surfaced as warnings (wired later).
- `project` / `iteration` → Projects v2 is GraphQL — warned, wired later.

`ExecResult` returns the request count, created-object counts, and `warnings` (ops not
fully wired are surfaced, never silently dropped).

## Role gate

Running the executor mutates GitHub, so it's gated by **role-scoped capabilities (#219)**:
the planner role can't invoke it; the director / an explicit user-confirmed "Publish"
action can. The module itself is just orchestration — the gate is enforced at the call site.

## Pipeline

```
plan → decompose (#228) → FeatureContract[] (#200)
     → buildPublishPlan (#226) [+ capability (#203) + strategy (#204)]
     → executePublish (#230) → real GitHub objects
```
