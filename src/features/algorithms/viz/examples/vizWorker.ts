// The vizCode SANDBOX worker (#3233) — a dedicated module Web Worker that compiles + runs a stored
// trace-program in an ISOLATED global scope (no DOM, no app state) and posts the recorded frames back.
// This is where untrusted stored `vizCode` executes, so `new Function` (in compileVizProgram) and the
// algorithm's `run` never touch the main thread. Spawned lazily by `vizSandbox.runInSandbox`.

import { runVizProgram } from "./vizProgram";
import type { VizWorkerRequest, VizWorkerResponse } from "./vizSandbox";

// `self` is the worker global. Typed loosely (a minimal shape) to avoid pulling in the TS "webworker" lib,
// which would clash with the app-wide "dom" lib (duplicate `self`/`postMessage` declarations). The message
// types are shared with the client via `import type` (erased — no runtime cycle with vizSandbox).
const ctx = self as unknown as {
  postMessage(message: VizWorkerResponse): void;
  onmessage: ((event: { data: VizWorkerRequest }) => void) | null;
};

ctx.onmessage = ({ data }) => {
  try {
    const { datatype, input, frames, source } = runVizProgram(data.code, data.input);
    ctx.postMessage({ id: data.id, ok: true, datatype, input, frames, source });
  } catch (err) {
    ctx.postMessage({ id: data.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
