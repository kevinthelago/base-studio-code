// The frontend ↔ github-state bridge (#2446) — mirrors the last-known GitHub board state into the
// bsc-project store (`~/.base-studio-code/github-state.json`) so the durable copy is reachable from a
// live session via `bsc project github-state` (golden rule: every persistent app store is
// `bsc`-reachable). Same pattern as projectLinksBridge (#2253): the zustand copy is the write-through
// CACHE; each successful fetch pushes the whole state here. Global (no project key) → null.
import { bscWrite } from "@/shared/lib/core/bsc";
import type { GithubState } from "./githubState";

/** Write-through the whole state (`bsc project github-state set`, JSON on stdin). Fire-and-forget;
 *  never throws (degrades to cache-only when the bridge/binary is absent). */
export async function pushGithubState(state: GithubState): Promise<void> {
  await bscWrite(null, ["project", "github-state", "set"], state);
}
