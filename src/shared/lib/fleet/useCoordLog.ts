// useCoordLog (#1495) — one home for reading + replaying the coordination log. The
// `invoke("read_coord_log") → ingestCoordLog(lines, emptyCoordState())` pair was hand-rolled in
// every fleet hook (the coordinator, the director pump, the worker auto-end, the live fleet view,
// the tunnel control). This centralizes the read so a change to the log format or the limit lands
// in one place.
//
//  - readCoordState(limit): the imperative read. Returns `null` on a read FAILURE (so the actuator
//    loops keep their "skip this tick, don't touch ref state" guard) and the full ingest result
//    otherwise. A successful read of an EMPTY log returns an empty-but-non-null result.
//  - useCoordLog({ limit, ms }): the polling hook for views that just want the latest state — polls
//    via usePoll and returns the latest `{ state, ready, answered }`, keeping the last good result
//    across a transient read failure.

import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { usePoll } from "@/shared/hooks/usePoll";
import { ingestCoordLog, emptyCoordState } from "./coordination";

/** The replayed coord state (`state`/`ready`/`answered`) plus the raw `lines` — the director
 *  pump still needs the unparsed log for its cursor-based heartbeat. */
export type CoordResult = ReturnType<typeof ingestCoordLog> & { lines: string[] };

/** Read + replay the coordination log. `null` on a read failure; the replay + raw lines otherwise. */
export async function readCoordState(limit = 1000): Promise<CoordResult | null> {
  const lines = await invoke<string[]>("read_coord_log", { limit }).catch(() => null);
  if (!lines) return null;
  return { lines, ...ingestCoordLog(lines, emptyCoordState()) };
}

interface UseCoordLogOptions {
  /** Lines to read from the tail of the log (default 1000). */
  limit?: number;
  /** Poll cadence in ms (default 1000). */
  ms?: number;
}

/** Poll the coordination log and return the latest replay. Keeps the last good result on a
 *  transient read failure rather than blanking. */
export function useCoordLog(opts: UseCoordLogOptions = {}): CoordResult {
  const { limit = 1000, ms = 1000 } = opts;
  const [result, setResult] = useState<CoordResult>(() => ({ lines: [], ...ingestCoordLog([], emptyCoordState()) }));
  usePoll(async (isCancelled) => {
    const res = await readCoordState(limit);
    if (isCancelled() || !res) return;
    setResult(res);
  }, ms, [limit]);
  return result;
}
