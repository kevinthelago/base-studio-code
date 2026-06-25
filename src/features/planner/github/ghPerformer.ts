// Tauri performer — the real side-effecting boundary for the gh executor (#230).
// Routes a GhRequest to the Rust GitHub commands the rest of the app uses
// (github_post / github_request), so the pure publish pipeline can create real
// GitHub objects. This is the ONE place that imports Tauri; keep the orchestration
// in ghExecutor.ts pure.
//
// Running this mutates GitHub, so it must only be invoked behind the publish / role
// gate (#219) — never by a planner session.

import { invoke } from "@tauri-apps/api/core";
import { buildPublishPlan, type PublishInput } from "./publishAdapter";
import { executePublish, type ExecResult, type GhRequest, type GhResponse, type Performer } from "./ghExecutor";

/**
 * A {@link Performer} backed by the app's GitHub backend commands. POST → `github_post`,
 * GET → `github_request`; the created object's `number`/`id` are mapped back so the
 * executor can thread them (milestone numbers, issue ids for sub-issues).
 */
export function tauriPerformer(token: string): Performer {
  return async (req: GhRequest): Promise<GhResponse> => {
    if (req.method === "POST") {
      const res = await invoke<{ number?: number; id?: number } | null>("github_post", {
        token,
        path: req.path,
        body: req.body ?? {},
      });
      return { number: res?.number, id: res?.id };
    }
    if (req.method === "GET") {
      const res = await invoke<{ number?: number; id?: number } | null>("github_request", {
        token,
        path: req.path,
      });
      return { number: res?.number, id: res?.id };
    }
    // The executor only emits POST/GET today; surface anything else loudly.
    throw new Error(`tauriPerformer: unsupported method ${req.method} for ${req.path}`);
  };
}

/**
 * Capstone: build the publish plan and execute it against real GitHub in one call.
 * `input` carries the capability profile (#203) + execution strategy (#204), so the
 * created objects are capability-correct. Gate this behind the publish action (#219).
 */
export function publishViaTauri(input: PublishInput, repo: string, token: string): Promise<ExecResult> {
  return executePublish(buildPublishPlan(input), repo, tauriPerformer(token));
}
