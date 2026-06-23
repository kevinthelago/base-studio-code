// Per-pane token + cost telemetry (#1181). Polls the Rust `read_token_usage` command — which
// parses each pane's latest Claude transcript for its `usage` totals AND its `message.model` —
// and returns the latest rollup keyed by pane id. Feeds two surfaces: the header model pill's
// "actual running model" (so it reflects what the CLI is really running, not just the configured
// model) and the Telemetry · cost view.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/** One pane's token + cost rollup, as serialized by the Rust `read_token_usage` command
 *  (tokens.rs `TokenUsage` — plain snake_case, no serde rename, so the keys match the struct). */
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
 * Poll `read_token_usage` and return the latest per-pane rollup, keyed by pane id. Refreshes
 * every 4s while mounted (matching the coordination/CI pollers); errors and a missing log
 * degrade to an empty map so callers fall back to the configured model.
 */
export function usePaneTokenUsage(limit = 64): Map<string, PaneTokenUsage> {
  const [byPane, setByPane] = useState<Map<string, PaneTokenUsage>>(EMPTY);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const rows = await invoke<PaneTokenUsage[]>("read_token_usage", { limit })
        .catch(() => [] as PaneTokenUsage[]);
      if (cancelled) return;
      const m = new Map<string, PaneTokenUsage>();
      for (const r of rows ?? []) m.set(r.pane, r);
      setByPane(m);
    };
    load();
    const id = setInterval(load, 4000);
    return () => { cancelled = true; clearInterval(id); };
  }, [limit]);
  return byPane;
}
