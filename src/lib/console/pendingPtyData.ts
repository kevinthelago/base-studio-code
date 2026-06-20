/**
 * Rolling byte buffer for PTY output that arrives while a TerminalView is
 * hidden (background tab, fullscreen-of-another-pane, view switched off
 * "console"). Drops oldest chunks once over `maxBytes` so a long-streaming
 * background pane can't grow the JS heap without bound — matching what xterm
 * does to its own scrollback for visible terminals.
 *
 * Flushed in one `term.write` call when the pane becomes visible, so background
 * panes pay zero render cost while hidden and the user sees everything still
 * within the cap when they switch back. Part of #52's "make each pane cheaper"
 * direction (the other lever besides WebGL + per-slice selectors).
 */
export class PendingPtyData {
  private chunks: string[] = [];
  private bytes = 0;
  constructor(private readonly maxBytes: number) {}

  /** Append a PTY chunk. Drops oldest chunks first to stay under `maxBytes`. */
  push(s: string): void {
    if (s.length === 0) return;
    this.chunks.push(s);
    this.bytes += s.length;
    // Keep at least one chunk so a single oversized payload survives intact;
    // dropping it would lose data the user might still want to see on flush.
    while (this.bytes > this.maxBytes && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!;
      this.bytes -= dropped.length;
    }
  }

  /** Return everything buffered as one string and clear. Empty string when nothing pending. */
  flush(): string {
    if (this.chunks.length === 0) return "";
    const out = this.chunks.join("");
    this.chunks = [];
    this.bytes = 0;
    return out;
  }

  /** Current byte count. Used by callers that want to skip a no-op flush. */
  size(): number { return this.bytes; }
}
