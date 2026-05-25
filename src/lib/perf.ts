// Lightweight frontend performance monitor.
//
// Emits ONE aggregated metrics line on a steady ~2s cadence (logging per-event
// would add IPC + file-write work on the already-overloaded main thread). The
// line combines:
//   • jank      — main-thread long tasks (count / worst / total blocked ms)
//   • pty       — pty_data events reaching the frontend (count / KB / ms spent
//                 synchronously in the term.write handler)
//   • terms     — number of mounted terminals
// Together these tell us whether the lag is rendering load (jank high, terms high)
// vs. data volume (pty high) vs. handler cost (pty ms high).

import { log } from "./log";

/** Long tasks at or above this many ms count toward the jank tally. */
const LONG_TASK_MS = 100;
/** How often (ms) to flush the aggregated metrics line. */
const FLUSH_MS = 2000;
/** Heap usage above this fraction of the limit gets its own warning. */
const HEAP_WARN_RATIO = 0.85;

/** JS heap snapshot (MB), or null when the runtime doesn't expose it. */
export interface HeapInfo { usedMB: number; limitMB: number; }

/**
 * Reads the WebView's JS heap usage. `performance.memory` is a non-standard
 * Chromium API (present in the WebView2 renderer) — absent elsewhere, hence the
 * guard. Used to spot renderer memory growth, e.g. a 4×4 triage's 16 terminals.
 */
export function readHeap(): HeapInfo | null {
  const m = (performance as unknown as {
    memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
  }).memory;
  if (!m || !m.jsHeapSizeLimit) return null;
  return {
    usedMB: Math.round(m.usedJSHeapSize / 1048576),
    limitMB: Math.round(m.jsHeapSizeLimit / 1048576),
  };
}

interface PerfStats {
  jankCount: number;
  jankTotalMs: number;
  jankWorstMs: number;
  ptyEvents: number;
  ptyBytes: number;
  ptyHandlerMs: number;
  renders: number;
  /** Per-window count of how often each store key changed (finds re-render loops). */
  storeWrites: Record<string, number>;
  terminals: number;
}

const stats: PerfStats = {
  jankCount: 0, jankTotalMs: 0, jankWorstMs: 0,
  ptyEvents: 0, ptyBytes: 0, ptyHandlerMs: 0,
  renders: 0,
  storeWrites: {},
  terminals: 0,
};

function resetWindow(): void {
  stats.jankCount = 0; stats.jankTotalMs = 0; stats.jankWorstMs = 0;
  stats.ptyEvents = 0; stats.ptyBytes = 0; stats.ptyHandlerMs = 0;
  stats.renders = 0;
  stats.storeWrites = {};
  // terminals is a live count, not a per-window tally — leave it.
}

/** Build the aggregated metrics line, or null when there was no activity. Pure. */
export function formatPerfSummary(s: PerfStats, elapsedMs: number, heap?: HeapInfo | null): string | null {
  // Report on any activity — including a re-render/store-write loop that produces
  // no long-task jank and no pty traffic (exactly the case we're chasing).
  const idle = s.jankCount === 0 && s.ptyEvents === 0 && s.renders === 0
    && Object.keys(s.storeWrites).length === 0;
  if (idle) return null;
  const parts: string[] = [];
  if (s.jankCount > 0) {
    parts.push(`jank ${s.jankCount}× (worst ${Math.round(s.jankWorstMs)}ms, total ${Math.round(s.jankTotalMs)}ms)`);
  }
  if (s.ptyEvents > 0) {
    parts.push(`pty ${s.ptyEvents} evt, ${Math.round(s.ptyBytes / 1024)}KB, ${Math.round(s.ptyHandlerMs)}ms write`);
  }
  if (s.renders > 0) {
    parts.push(`${s.renders} renders`);
  }
  // Surface the top 2 most-frequently-written store keys — a re-render loop shows
  // up here as one key changing hundreds of times per window.
  const top = Object.entries(s.storeWrites).sort((a, b) => b[1] - a[1]).slice(0, 2);
  if (top.length > 0) {
    parts.push(`store ${top.map(([k, n]) => `${k}×${n}`).join(", ")}`);
  }
  parts.push(`${s.terminals} terms`);
  if (heap) {
    parts.push(`heap ${heap.usedMB}/${heap.limitMB}MB`);
  }
  return `[perf] ${(elapsedMs / 1000).toFixed(1)}s · ${parts.join(" · ")}`;
}

/** Record one pty_data event: payload size + synchronous handler time. Hot path — keep cheap. */
export function recordPtyData(bytes: number, handlerMs: number): void {
  stats.ptyEvents += 1;
  stats.ptyBytes += bytes;
  stats.ptyHandlerMs += handlerMs;
}

/** Adjust the live mounted-terminal count (+1 on mount, -1 on unmount). */
export function bumpTerminals(delta: number): void {
  stats.terminals = Math.max(0, stats.terminals + delta);
}

/** Count one React commit of an instrumented component (e.g. ConsoleScreen). */
export function recordRender(): void {
  stats.renders += 1;
}

/** Count one change to a store key (for spotting which key drives a re-render loop). */
export function recordStoreWrite(key: string): void {
  stats.storeWrites[key] = (stats.storeWrites[key] ?? 0) + 1;
}

let observer: PerformanceObserver | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let lastFlush = 0;

/** Start the long-task observer + the periodic metrics flush. Idempotent. */
export function startPerfMonitor(): void {
  if (timer) return;
  if (typeof PerformanceObserver !== "undefined") {
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration >= LONG_TASK_MS) {
            stats.jankCount += 1;
            stats.jankTotalMs += entry.duration;
            stats.jankWorstMs = Math.max(stats.jankWorstMs, entry.duration);
          }
        }
      });
      observer.observe({ entryTypes: ["longtask"] });
    } catch {
      observer = null;
    }
  }
  lastFlush = performance.now();
  timer = setInterval(() => {
    const now = performance.now();
    const heap = readHeap();
    const line = formatPerfSummary(stats, now - lastFlush, heap);
    lastFlush = now;
    resetWindow();
    if (line) log.warn(line);
    // Fire even when otherwise idle — a heap creeping toward the limit (e.g. a
    // 4×4 triage's terminals) is exactly the signal we want, regardless of jank.
    if (heap && heap.usedMB / heap.limitMB >= HEAP_WARN_RATIO) {
      log.warn(`[perf] high heap: ${heap.usedMB}/${heap.limitMB}MB (${Math.round(100 * heap.usedMB / heap.limitMB)}%)`);
    }
  }, FLUSH_MS);
}

export function stopPerfMonitor(): void {
  observer?.disconnect();
  observer = null;
  if (timer !== null) { clearInterval(timer); timer = null; }
  resetWindow();
  stats.terminals = 0;
}

/**
 * Time an async operation, logging a warning when it exceeds `thresholdMs`.
 * Returns the operation's result untouched (and still times on throw).
 */
export async function timed<T>(label: string, fn: () => Promise<T>, thresholdMs = 50): Promise<T> {
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    const ms = performance.now() - t0;
    if (ms >= thresholdMs) log.warn(`[perf] ${label} took ${Math.round(ms)}ms`);
  }
}
