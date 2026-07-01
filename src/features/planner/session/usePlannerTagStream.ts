// usePlannerTagStream (#1474) — the planner's PTY output buffer. Owns the two output buffers and a
// `processChunk` that, per PTY data chunk, strips ANSI, accumulates, and caps the buffer. The
// planner used to emit structured `<tag>`s parsed here; every one has since moved to plan.db via a
// `bsc plan …` command reflected by the section poll (the last, `<plan_focus>`, removed in #2017),
// so this hook no longer parses anything — it just maintains the buffers the autopilot reads.
//
//   bufRef         — the accumulated output buffer (the caller's restart clears it)
//   autopilotTxRef — an UN-consumed copy of the same output, read by the autopilot idle-detector
//
// Both refs are returned so the caller's restart (clears bufRef) and autopilot (reads
// autopilotTxRef) keep their existing access. `processChunk` is a stable callback, so the
// once-attached `pty_data` listener is set up a single time.

import { useCallback, useRef } from "react";
import { stripAnsi } from "./planningTerminal";

export interface PlannerTagStream {
  /** Feed one PTY data chunk: accumulate it and parse/dispatch any structured tags it completes. */
  processChunk: (payload: string) => void;
  /** The tag-scan buffer (the caller's restart clears it). */
  bufRef: React.MutableRefObject<string>;
  /** The un-consumed output copy the autopilot idle-detector reads. */
  autopilotTxRef: React.MutableRefObject<string>;
}

export function usePlannerTagStream(): PlannerTagStream {
  // Accumulated stripped output. Historically drained by the tag parsers as they consumed tags;
  // every planner tag now writes to plan.db via `bsc plan …` and is reflected by the section poll,
  // so nothing is parsed here anymore (the last, `<plan_focus>`, was removed in #2017). The buffer +
  // its un-consumed autopilot copy remain: the autopilot idle-detector (#746) reads them, and the
  // cap keeps them bounded.
  const bufRef = useRef("");
  // Autopilot (#746): an un-consumed copy of the planner's raw output, for idle-detection + user-sim.
  const autopilotTxRef = useRef("");

  const processChunk = useCallback((payload: string) => {
    bufRef.current += stripAnsi(payload);
    autopilotTxRef.current += stripAnsi(payload); // un-consumed copy for the autopilot (#746)

    // Cap buffer to prevent unbounded growth while preserving any partial
    // in-progress tag that hasn't received its closing counterpart yet.
    const MAX_BUF = 120_000;
    if (bufRef.current.length > MAX_BUF) {
      const lastTagStart = bufRef.current.lastIndexOf("<");
      bufRef.current = bufRef.current.slice(
        lastTagStart > 0 && lastTagStart > bufRef.current.length - MAX_BUF
          ? lastTagStart
          : bufRef.current.length - MAX_BUF
      );
    }
  }, []);

  return { processChunk, bufRef, autopilotTxRef };
}
