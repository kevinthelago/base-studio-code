// Project relationships (#2253, part of #2205) — a user-drawn edge between two projects on the Glance
// L1 network: `from` depends on / consumes `to` over a contract of `kind` (Glance's api/data/events).
// The editable source of truth for the project network's edges (frontend store for now; migrates to the
// `bsc project` store for agent-reachability later). Pure model.
import type { GEdgeKind } from "./glanceGraph";

export interface ProjectLink {
  id: string;
  from: string;
  to: string;
  kind: GEdgeKind;
}

/** Deterministic id for a link, so adding the same edge twice is idempotent. */
export const projectLinkId = (from: string, to: string, kind: GEdgeKind): string => `${from}>${to}:${kind}`;
