// The main-thread client for the vizCode SANDBOX (#3233). Stored `vizCode` is run in a dedicated Web
// Worker (`vizWorker.ts`) — an isolated global scope with NO DOM access — and the recorded frames are
// posted back for replay. This keeps untrusted stored code (once the graph becomes Studio-importable,
// #2889) off the main thread, and makes a runaway program (e.g. `while(true)`) wedge only the worker,
// which we TERMINATE on timeout so the app never freezes.

import type { VizRun } from "./vizProgram";
import type { Frame } from "../../lib/trace";
import type { VizDatatype } from "./vizProgram";

/** Main → worker: run this program (optionally on an overriding input). `id` correlates the reply. */
export interface VizWorkerRequest {
  id: number;
  code: string;
  input?: unknown;
}

/** Worker → main: the recorded frames, or a compile/runtime error message. */
export type VizWorkerResponse =
  | { id: number; ok: true; datatype: VizDatatype; input: VizRun["input"]; frames: Frame[] }
  | { id: number; ok: false; error: string };

/** How long a single program may run in the worker before we treat it as wedged (infinite loop) and
 *  terminate the worker. Real trace-programs finish in well under this. */
const TIMEOUT_MS = 4000;

interface Pending {
  resolve: (run: VizRun) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, Pending>();

/** Tear down the worker and fail every in-flight call. Called on timeout (a wedged worker blocks ALL queued
 *  calls, since it is single-threaded) or on a fatal worker error; the next call lazily respawns a fresh one. */
function resetWorker(err: Error): void {
  if (worker) {
    worker.terminate();
    worker = null;
  }
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.reject(err);
  }
  pending.clear();
}

/** Lazily spawn the module worker + wire its message/error handlers. */
function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./vizWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }: MessageEvent<VizWorkerResponse>) => {
      const p = pending.get(data.id);
      if (!p) return;
      pending.delete(data.id);
      clearTimeout(p.timer);
      if (data.ok) p.resolve({ datatype: data.datatype, input: data.input, frames: data.frames });
      else p.reject(new Error(data.error));
    };
    worker.onerror = () => resetWorker(new Error("visualization worker crashed"));
  }
  return worker;
}

/**
 * Run a stored `vizCode` in the sandbox and resolve with its recorded frames (#3233).
 *
 * @param code the impl's `vizCode` descriptor expression.
 * @param input optional overriding input (the "your input" seam); omit for the descriptor default.
 * @returns the datatype, the input used, and the frames.
 * @throws if the program is malformed, throws at runtime, or exceeds {@link TIMEOUT_MS} (a likely infinite
 *   loop — the worker is terminated and respawned for the next call).
 */
export function runInSandbox(code: string, input?: unknown): Promise<VizRun> {
  // Prefer the isolated worker. If `Worker` is unavailable (test / SSR) or construction fails (a non-Node
  // stub), fall back to running INLINE. In the app (Tauri WebView) `Worker` always constructs, so untrusted
  // vizCode NEVER runs on the main thread there; the inline path only ever runs trusted test/SSR code.
  if (typeof Worker !== "undefined") {
    try {
      return postToWorker(code, input);
    } catch {
      /* worker construction failed — fall through to inline */
    }
  }
  return import("./vizProgram").then(({ runVizProgram }) => runVizProgram(code, input));
}

/** Post one run to the (lazily spawned) worker and await its reply, with a wedged-worker timeout. Throws
 *  synchronously if the worker cannot be constructed (caught by {@link runInSandbox} → inline fallback). */
function postToWorker(code: string, input?: unknown): Promise<VizRun> {
  const w = getWorker();
  const id = ++seq;
  return new Promise<VizRun>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      // The wedged worker is blocking every queued call — terminate + respawn so the next call recovers.
      resetWorker(new Error("visualization program timed out (possible infinite loop)"));
      reject(new Error("visualization program timed out (possible infinite loop)"));
    }, TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    w.postMessage({ id, code, input } satisfies VizWorkerRequest);
  });
}
