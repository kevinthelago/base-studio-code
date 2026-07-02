// Per-pane token + cost telemetry (#1181). Polls `bsc logs cost --full` over the `bsc` bridge
// (#2144) — which parses each pane's latest Claude transcript for its `usage` totals AND its
// `message.model` — and returns the latest rollup keyed by pane id. Feeds two surfaces: the header
// model pill's "actual running model" (so it reflects what the CLI is really running, not just the
// configured model) and the Telemetry · cost view.

import { useState } from "react";
import { bscJson } from "@/shared/lib/core/bsc";
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
    const rows = await bscJson<PaneTokenUsage[]>(null, ["logs", "cost", "--full", "--limit", String(limit), "--json"], []);
    if (isCancelled()) return;
    const m = new Map<string, PaneTokenUsage>();
    for (const r of rows ?? []) m.set(r.pane, r);
    setByPane(m);
  }, 4000, [limit]);
  return byPane;
}
