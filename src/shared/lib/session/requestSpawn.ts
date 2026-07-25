// Pool-slot identity for warm-pool debugger sessions (#3535). The overflow sessions are POOL SLOTS, not
// per-request: a slot is a small stable integer, and a session claims a request only AFTER it launches
// (via `bsc request claim`), so its identity can't be the request id. These helpers name a slot's pane
// (the PTY), its Glance node, and the inverse the graph uses to resolve a node back to its pane.
//
// The spawn DECISION lives in `poolPlan.ts` (pure, tested); this file is only identity, imported by the
// mount (`RequestSessionsMount`), the Glance graph (`studioProject`), and the team augment (`team.ts`) —
// none of which may reach into the others — so it sits here in shared.

/** The PTY pane id for pool slot `n`. Under the `debug-studio:` prefix so it is full-capability like the
 *  standing debug session (`isFullCapabilitySession`, #3520). */
export function poolPaneId(slot: number): string {
  return `debug-studio:pool-${slot}`;
}

/** The Glance node id for pool slot `n` — distinct from the pane id because the Studio Network's node ids
 *  are team-position ids; {@link poolSlotFromNodeId} is the inverse the graph uses to open the slot. */
export function poolNodeId(slot: number): string {
  return `debugger-pool-${slot}`;
}

/** The pool slot behind a graph node, or null when the node is not a pool session. */
export function poolSlotFromNodeId(nodeId: string): number | null {
  const m = /^debugger-pool-(\d+)$/.exec(nodeId);
  return m ? Number(m[1]) : null;
}

/** The pool slot behind a PANE id, or null when the pane is not a pool session. The mount tracks sessions
 *  by pane id and needs the slot back to allocate the lowest free one and to publish live slots. */
export function poolSlotFromPaneId(paneId: string): number | null {
  const m = /^debug-studio:pool-(\d+)$/.exec(paneId);
  return m ? Number(m[1]) : null;
}
