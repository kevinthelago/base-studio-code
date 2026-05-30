// gh executor (#230) — run a publish-adapter PublishOp[] (#226) against GitHub: the
// side-effecting layer that actually creates the board / milestones / labels /
// issues / sub-issues / dependencies.
//
// The orchestration is kept PURE via an injected `perform` function, so it's
// unit-testable without hitting GitHub (tests pass a mock performer). The real
// performer is a thin Tauri adapter (github_post / github_request); running the
// executor sits behind the role gate (#219) — the planner can't run it.
//
// Free of React / xterm / Tauri imports.

import type { PublishOp } from "./publishAdapter";

/** A GitHub REST request to perform. */
export interface GhRequest {
  method: "GET" | "POST" | "PATCH" | "PUT";
  /** REST path, e.g. `repos/owner/name/milestones`. */
  path: string;
  body?: Record<string, unknown>;
}

/** What performing a request yields — a created object's number and/or database id. */
export interface GhResponse {
  /** Issue/milestone number. */
  number?: number;
  /** Database id (needed by the sub-issues API). */
  id?: number;
}

/** Side-effecting boundary: perform one request, return its created identifiers. */
export type Performer = (req: GhRequest) => Promise<GhResponse>;

export interface ExecResult {
  /** Total requests performed. */
  requests: number;
  created: {
    milestones: number;
    labels: number;
    epics: number;
    issues: number;
    dependencies: number;
  };
  /** Ops not fully wired (e.g. Projects v2 GraphQL), surfaced rather than silently dropped. */
  warnings: string[];
}

/**
 * Execute the publish operations in order, threading created ids forward (milestone
 * numbers, issue numbers + database ids) so later ops reference real objects. Each
 * op's physical representation (from the capability mapping) decides the calls:
 *
 * - `milestone` → POST a milestone.
 * - `label` → POST a label.
 * - `epic` → POST the parent issue, then each child issue; for non-`parent+task-list`
 *   rungs, link children via the sub-issues API (needs the child's database id).
 * - `dependency` → `body-text` rung posts a `depends_on:` comment on the source issue;
 *   richer rungs (Project field / native relationship) are warned (wired later).
 * - `project` / `iteration` → Projects v2 is GraphQL; warned, wired later.
 */
export async function executePublish(ops: PublishOp[], repo: string, perform: Performer): Promise<ExecResult> {
  const milestoneNumber: Record<string, number> = {};
  const issueNumber: Record<string, number> = {};
  const issueId: Record<string, number> = {};
  const created = { milestones: 0, labels: 0, epics: 0, issues: 0, dependencies: 0 };
  const warnings: string[] = [];
  let requests = 0;

  const run = (req: GhRequest): Promise<GhResponse> => {
    requests += 1;
    return perform(req);
  };

  for (const op of ops) {
    switch (op.op) {
      case "project":
        warnings.push("project (Projects v2) is GraphQL — not created by the REST executor");
        break;

      case "iteration":
        warnings.push(`iteration "${op.title}" (Projects v2) is GraphQL — not created by the REST executor`);
        break;

      case "milestone": {
        const res = await run({ method: "POST", path: `repos/${repo}/milestones`, body: { title: op.title } });
        if (res.number != null) milestoneNumber[op.title] = res.number;
        created.milestones += 1;
        break;
      }

      case "label":
        await run({ method: "POST", path: `repos/${repo}/labels`, body: { name: op.name } });
        created.labels += 1;
        break;

      case "epic": {
        const parent = await run({ method: "POST", path: `repos/${repo}/issues`, body: { title: op.title } });
        if (parent.number != null) issueNumber[op.title] = parent.number;
        created.epics += 1;

        for (const child of op.childTitles) {
          const c = await run({ method: "POST", path: `repos/${repo}/issues`, body: { title: child } });
          if (c.number != null) issueNumber[child] = c.number;
          if (c.id != null) issueId[child] = c.id;
          created.issues += 1;

          const linkable = op.representation !== "parent+task-list";
          if (linkable && parent.number != null && c.id != null) {
            await run({
              method: "POST",
              path: `repos/${repo}/issues/${parent.number}/sub_issues`,
              body: { sub_issue_id: c.id },
            });
          } else if (linkable) {
            warnings.push(`could not link "${child}" under "${op.title}" (missing parent number or child id)`);
          }
        }
        break;
      }

      case "dependency": {
        const fromNum = issueNumber[op.from] ?? Number(op.from.replace(/^#/, ""));
        if (op.representation === "body-text" && Number.isFinite(fromNum)) {
          await run({
            method: "POST",
            path: `repos/${repo}/issues/${fromNum}/comments`,
            body: { body: `depends_on: ${op.to}` },
          });
        } else {
          warnings.push(`dependency ${op.from} → ${op.to} via "${op.representation}" not wired yet`);
        }
        created.dependencies += 1;
        break;
      }
    }
  }

  return { requests, created, warnings };
}
