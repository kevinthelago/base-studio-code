// safeInvoke / fireInvoke (#1497) — typed wrappers for the ubiquitous ad-hoc Tauri error handling.
// The codebase has 100+ `invoke(...).catch(...)` sites with inconsistent conventions (silent
// swallow, fallback return, log). These two cover the common cases so the intent is explicit and a
// failed command degrades the same way everywhere.

import { invoke, type InvokeArgs } from "@tauri-apps/api/core";
import { startInvokeTimer } from "@/shared/lib/core/invokeTiming";

/**
 * `invoke()` that resolves to `fallback` instead of rejecting — for the `invoke(...).catch(() =>
 * <fallback>)` reads. Pass `undefined` for a command with no args. `onError` observes the swallowed
 * error (e.g. to log it) without changing the fallback. Round-trip is timed (#3626) — a slow call
 * gets a `[invoke]` line in the app log's perf scope.
 */
export async function safeInvoke<T>(
  cmd: string,
  args: InvokeArgs | undefined,
  fallback: T,
  onError?: (e: unknown) => void,
): Promise<T> {
  const done = startInvokeTimer(cmd);
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    onError?.(e);
    return fallback;
  } finally {
    done();
  }
}

/** Fire-and-forget `invoke()` whose rejection is swallowed (optionally observed via `onError`).
 *  Round-trip is timed (#3626) like `safeInvoke`. */
export function fireInvoke(cmd: string, args?: InvokeArgs, onError?: (e: unknown) => void): void {
  const done = startInvokeTimer(cmd);
  void invoke(cmd, args).catch((e) => { onError?.(e); }).finally(done);
}
