// Project relationships / inter-app contracts (#2253 → #3786 Phase 2) — a Glance L0 network edge:
// `from` (a project) depends on / consumes `to` over a contract of `kind` (Glance's api/data/events).
// #3786 Phase 2 generalizes the TARGET: `to` can be another project (the default), an external `service`,
// or an `mcp` server, described by an optional `target` descriptor. The editable source of truth for the
// project network's edges — a write-through cache over the global `bsc project link` store (the same CLI
// an agent uses to learn what its project consumes). Pure model.
import type { GEdgeKind } from "./glanceGraph";
// Cross-feature TYPE only, via the barrel (#1309 boundary) — the endpoint's application architecture,
// the same `AppType` vocabulary a project is classified by. `import type` is erased at build (no cycle).
import type { AppType } from "@/features/planner";

/** What a contract's `to` endpoint IS (#3786 Phase 2): another `project` (the default), an external
 *  `service`, or an `mcp` server. */
export type ContractTargetType = "project" | "service" | "mcp";

/** The endpoint a contract points at (#3786 Phase 2). Present only for a NON-project contract (an external
 *  service / mcp server) — a plain project↔project link leaves `target` absent (byte-compatible with the
 *  pre-#3786 shape). `name`/`url`/`appType` are optional descriptors of the external endpoint. */
export interface ContractTarget {
  type: ContractTargetType;
  name?: string;
  url?: string;
  appType?: AppType;
}

export interface ProjectLink {
  id: string;
  from: string;
  to: string;
  kind: GEdgeKind;
  /** The target endpoint (#3786). ABSENT ⇒ a project↔project link (`{ type: "project" }`) — kept absent
   *  so a legacy project link's persisted/wire shape is byte-identical. Present for a `service` / `mcp`
   *  contract, carrying the endpoint descriptor Glance draws as an external contract node. */
  target?: ContractTarget;
}

/** Deterministic id for a link, so adding the same edge twice is idempotent. Target-agnostic (the id is
 *  the same shape whatever the target endpoint is), matching the Rust `link_id`. */
export const projectLinkId = (from: string, to: string, kind: GEdgeKind): string => `${from}>${to}:${kind}`;

/** True when a contract points at another PROJECT (the default) — i.e. it draws as a normal L0
 *  project→project edge, not an external band contract node. A missing/`project` target is a project
 *  contract. */
export const isProjectContract = (l: ProjectLink): boolean => !l.target || l.target.type === "project";
