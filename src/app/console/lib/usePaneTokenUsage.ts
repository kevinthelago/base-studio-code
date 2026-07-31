// Per-pane token + cost telemetry (#1181). Reads the latest rollup keyed by pane id — each pane's
// latest Claude transcript parsed for its `usage` totals AND its `message.model`. Feeds two surfaces:
// the header model pill's "actual running model" (so it reflects what the CLI is really running, not
// just the configured model) and the Telemetry · cost view.
//
// IN-PROCESS since #4074 (`logs_usage`), not the `bsc` bridge. #3630 moved the hot pollers off the
// bridge and left this one on it as "low-frequency" — but it polls every 4s, which made it the app's
// single biggest process spawner (415 calls in a 27-minute window). Every spawn blocked Tauri's main
// thread, so the invoke queue backed up to 25s and unrelated commands waited behind it. Same rows:
// `logs_usage` calls the same `logs::cost::usage` the CLI's `cost` verb does.

import { useState } from "react";
import { safeInvoke } from "@/shared/lib/core/safeInvoke";
import { usePoll } from "@/shared/hooks/usePoll";

/** One pane's token + cost rollup, as serialized by `bsc logs cost --full` (`logs::cost::Usage` —
 *  plain snake_case, no serde rename, so the keys match the struct). */
export interface PaneTokenUsage {
  pane: string;
  session_id: string;
  /** The model the CLI recorded in the transcript (`message.model`) — the ACTUAL running model. */
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
}

const EMPTY: Map<string, PaneTokenUsage> = new Map();

/**
 * Poll `bsc logs cost --full` and return the latest per-pane rollup, keyed by pane id. Refreshes
 * every 4s while mounted (matching the coordination/CI pollers); errors and a missing log
 * degrade to an empty map so callers fall back to the configured model.
 */
export function usePaneTokenUsage(limit = 64): Map<string, PaneTokenUsage> {
  const [byPane, setByPane] = useState<Map<string, PaneTokenUsage>>(EMPTY);
  usePoll(async (isCancelled) => {
    const rows = await safeInvoke<PaneTokenUsage[]>("logs_usage", { limit }, []);
    if (isCancelled()) return;
    const m = new Map<string, PaneTokenUsage>();
    for (const r of rows ?? []) m.set(r.pane, r);
    setByPane(m);
  }, 4000, [limit]);
  return byPane;
}
