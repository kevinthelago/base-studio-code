// The hidden-pane handoff — what a pane does with PTY output it cannot render yet, and how it catches
// up when it can. Pure: no React, no xterm, no Tauri. `TerminalView` wires it to all three.
//
// ## What this replaces, and why the old answer was worse than no answer
//
// `PendingPtyData` buffered a hidden pane's output in RAM and, past 256 KB, dropped the OLDEST chunks:
//
//     while (this.bytes > this.maxBytes && this.chunks.length > 1) this.chunks.shift();
//
// PTY output is not lines. It is text INTERLEAVED WITH ANSI ESCAPE SEQUENCES, split wherever a `read()`
// happened to stop — frequently mid-sequence. Dropping from the FRONT of that does two things, and the
// second is the damaging one:
//
//   1. the flushed stream can BEGIN mid-sequence, so xterm misparses the remainder;
//   2. the sequences that establish STATE are silently lost — auto-wrap (DECAWM), scroll regions,
//      alt-screen enter/exit, character attributes, cursor addressing. Everything drawn afterwards
//      renders under the wrong terminal state, permanently.
//
// That is exactly the reported symptom: the newest ~20 lines correct (state re-established by later
// sequences) while older scrollback above sits in the wrong layout. And it was reached ROUTINELY, not in
// a corner — measured PTY throughput is 3-13 KB per 2s across all panes and #187 keeps every tab's panes
// mounted, so one busy hidden pane crossed 256 KB in well under a minute.
//
// ## The answer is that the bytes are already durable
//
// Rust records every byte of every session to disk as it reads them (`console::pty::scrollback`), with
// offsets recorded only where the stream is provably BETWEEN escape sequences. So a hidden pane does not
// need a second, lossy copy in the renderer's heap: it can drop what it cannot draw and ask for the
// history back at a SAFE BOUNDARY when it is shown. The buffer was defending memory against a problem
// the disk had already solved.
//
// What is left here is the small amount of reasoning that is genuinely the frontend's: which live batch
// a reveal has already covered, and what to do with the one kind of output disk cannot give back.

/** One batch of PTY output, as Rust emits it on `pty_data_<pane>`.
 *
 *  `upto` is the RECORDING offset the batch reaches. `null` means the batch is not in the recording at
 *  all — an older backend that still sends a bare string, a session whose recording failed to open, or
 *  a notice the emitter generated itself (the cage-death banner). That distinction is the whole basis of
 *  {@link dispositionWhileHidden}: a recorded batch is safe to throw away, an unrecorded one is not. */
export interface PtyChunk {
  data: string;
  upto: number | null;
}

/** What `pty_scrollback_reveal` hands back: the replay text, and the offset it ends at. */
export interface ScrollbackReveal {
  text: string;
  upto: number;
}

/**
 * Has the terminal already been given this batch?
 *
 * A reveal reads the recording up to its own offset while holding the emitter's cursor, so everything at
 * or below that number is on screen by the time the reply arrives. Tauri does NOT guarantee ordering
 * between an event and a command reply, so a batch emitted just before the lock can still be delivered
 * after the reveal returns — this is the check that closes that seam, not a belt-and-braces one.
 *
 * An unrecorded batch is never a duplicate: no reveal can have replayed something that was never
 * written down, so it is always written and never advances the mark.
 */
export function isAlreadyReplayed(upto: number | null, writtenUpto: number): boolean {
  return upto !== null && upto <= writtenUpto;
}

/** What to do with a batch that arrives while the pane cannot render it. */
export type HiddenDisposition = "drop" | "hold";

/**
 * Drop a batch the recording already owns; hold one it does not.
 *
 * DROPPING IS THE POINT. The bytes are on disk, verbatim and uncapped, and a reveal will replay them
 * from a boundary the recorder verified — which is strictly more than the old buffer could offer even
 * before it started corrupting them. Holding a recorded batch would rebuild the very copy this exists to
 * delete.
 *
 * "hold" is reached only when nothing is recording this pane, so there is no other copy to fall back on.
 */
export function dispositionWhileHidden(chunk: PtyChunk): HiddenDisposition {
  return chunk.upto === null ? "hold" : "drop";
}

/** A full reset (RIS) plus a line saying output was lost. See {@link UnrecordedPtyText}. */
export const TRUNCATION_NOTICE =
  "\x1bc\r\n\x1b[2m…earlier output was dropped: this session is not being recorded…\x1b[0m\r\n";

/**
 * The bounded hold for output that is NOT in the recording — the only case disk cannot answer.
 *
 * In practice this holds a handful of emitter-generated notices and nothing else. It fills up only when a
 * session's recording failed to open, and then it is the sole copy of that session's output, so it must
 * stay bounded.
 *
 * WHEN IT OVERFLOWS IT DOES NOT DROP FROM THE FRONT, which is the entire lesson of the bug above. It
 * discards what it holds and starts again, and {@link flush} then prefixes {@link TRUNCATION_NOTICE} —
 * a RIS, which puts the terminal into a DEFINED state rather than an inherited-and-wrong one, followed
 * by a line admitting the gap.
 *
 * The honest residue, stated rather than glossed: the retained tail begins at whatever chunk edge the
 * discard fell on, so its first bytes may be the middle of one escape sequence and garble a single
 * fragment. That is bounded to one fragment because the RIS in front of it re-establishes state.
 * Dropping from the front had no such bound — it lost the state sequences themselves, and every line
 * drawn afterwards inherited the mistake.
 */
export class UnrecordedPtyText {
  private chunks: string[] = [];
  private bytes = 0;
  private truncated = false;

  constructor(private readonly maxBytes: number) {}

  push(s: string): void {
    if (s.length === 0) return;
    if (this.bytes + s.length > this.maxBytes) {
      // Start over rather than shift() — see the class doc. Losing the tail we were holding is a
      // visible gap; losing the front of it is an invisible corruption.
      this.chunks = [];
      this.bytes = 0;
      this.truncated = true;
    }
    this.chunks.push(s);
    this.bytes += s.length;
  }

  /** Everything held, as one string, and clear. `""` when nothing is held AND nothing was lost. */
  flush(): string {
    const body = this.chunks.join("");
    const out = this.truncated ? TRUNCATION_NOTICE + body : body;
    this.chunks = [];
    this.bytes = 0;
    this.truncated = false;
    return out;
  }

  /** Whether a flush would write anything. A truncation is worth writing even with nothing held. */
  pending(): boolean {
    return this.bytes > 0 || this.truncated;
  }
}
