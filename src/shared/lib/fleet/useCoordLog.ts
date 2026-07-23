// useCoordLog (#1495) — one home for reading + replaying the coordination log. The
// `read coord log → ingestCoordLog(lines, emptyCoordState())` pair was hand-rolled in
// every fleet hook (the coordinator, the director pump, the worker auto-end, the live fleet view,
// the tunnel control). This centralizes the read so a change to the log format or the limit lands
// in one place. The read is `bsc logs tail coord --oldest` over the `bsc` bridge (#2144) — raw,
// chronological (oldest-first) lines, the same shape the old `read_coord_log` command returned.
//
//  - readCoordState(limit): the imperative read. Returns `null` on a read FAILURE (so the actuator
//    loops keep their "skip this tick, don't touch ref state" guard) and the full ingest result
//    otherwise. A successful read of an EMPTY log returns an empty-but-non-null result.
//  - useCoordLog({ limit, ms }): the polling hook for views that just want the latest state — polls
//    via usePoll and returns the latest `{ state, ready, answered }`, keeping the last good result
//    across a transient read failure.

import { useState } from "react";
import { logsTail } from "@/shared/lib/core/logsBridge";
import { useLogStream } from "@/shared/hooks/useLogStream";
import { ingestCoordLog, emptyCoordState } from "./coordination";

/** The replayed coord state (`state`/`ready`/`answered`) plus the raw `lines` — the director
 *  pump still needs the unparsed log for its cursor-based heartbeat. */
export type CoordResult = ReturnType<typeof ingestCoordLog> & { lines: string[] };

/** Read + replay the coordination log. `null` on a read failure; the replay + raw lines otherwise. */
export async function readCoordState(limit = 1000): Promise<CoordResult | null> {
  // In-process read (#3630) — `null` fallback preserves the "read failed → skip this tick" guard.
  const lines = await logsTail("coord", limit, true, null);
  if (!lines) return null;
  return { lines, ...ingestCoordLog(lines, emptyCoordState()) };
}

interface UseCoordLogOptions {
  /** Lines to read from the tail of the log (default 1000). */
  limit?: number;
  /** @deprecated Legacy poll cadence — ignored since #3638 (reads are event-driven on `logs://coord`).
   *  Kept so existing `{ ms }` call sites still type-check; remove once none pass it. */
  ms?: number;
}

/** Poll the coordination log and return the latest replay. Keeps the last good result on a
 *  transient read failure rather than blanking. */
export function useCoordLog(opts: UseCoordLogOptions = {}): CoordResult {
  const { limit = 1000 } = opts;
  const [result, setResult] = useState<CoordResult>(() => ({ lines: [], ...ingestCoordLog([], emptyCoordState()) }));
  // Event-driven (#3638): re-read + replay only when the coord log changes (plus mount + a slow
  // backstop), instead of polling every `ms`. `opts.ms` is retained on the type for back-compat but no
  // longer drives the read cadence — the `logs://coord` change event does.
  useLogStream("coord", async (isCancelled) => {
    const res = await readCoordState(limit);
    if (isCancelled() || !res) return;
    setResult(res);
  }, [limit]);
  return result;
}
