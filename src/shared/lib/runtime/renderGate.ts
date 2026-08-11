// The render gate's memory (#graph-render-gate) — the last source per component id that COMPILED **and
// RENDERED** without throwing.
//
// Under store-always-wins nothing resets a bad record, so one bad in-app edit would blank that surface.
// `GraphComponent` mounts this instead of the caller's empty fallback when the current source fails.
//
// RENDERED, not merely compiled: a component can compile and still throw on its first render (a bad hook
// call, a missing prop). The entry is therefore written from a post-commit effect, which by construction
// cannot run for a render the error boundary caught.
//
// Lives in its own module rather than beside the component for two reasons: a component file that also
// exports helpers breaks Fast Refresh, and the gate's state is not the component's — a test needs to
// clear it without reaching into the tree.
//
// Per SESSION, deliberately. Persisting it onto the record would mean a store write per successful render
// — churning `rev` and spamming history — and across a restart a broken record still shows the caller's
// fallback exactly as before, so this is never worse than the old behaviour.
import type { ComponentType } from "react";

/** id → the last source that worked, with the component built from it. */
export const lastGood = new Map<string, { source: string; Comp: ComponentType<Record<string, unknown>> }>();

/** Clear the gate — module state, so a test needs this between cases. */
export function resetLastGood(): void {
  lastGood.clear();
}
