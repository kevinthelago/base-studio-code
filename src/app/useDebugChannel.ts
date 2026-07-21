// useDebugChannel (#3437, epic #3260) — answer `bsc debug` from the live view, and ACK it.
//
// THE ROUND TRIP
//   bsc debug → request file → Rust watcher → `bsc://debug` → HERE → inspect → `debug_ack` → reply
//
// This is the thin adapter: it supplies the real DOM capabilities and ALWAYS acks — success or a stated
// error. Silence would strand the Rust waiter until its timeout and surface as "the frontend did not
// answer", sending someone to debug the channel instead of their actual bug. The decisions live in the
// pure `debugBridge.ts`.
//
// SEEING INTO THE PREVIEW
// A preview iframe is an OPAQUE origin (`sandbox="allow-scripts"`, no `allow-same-origin`), so
// `contentDocument` is null and nothing here can read it. That is a real trust boundary and is not
// weakened: the pan/zoom engine is ASKED to describe itself over `postMessage` (`{__probe:1}`), and a
// preview that never answers is reported as silent — which is itself the diagnosis.
import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { mountedPreviewFrames } from "@/features/designs";
import { log } from "@/shared/lib/core/log";
import {
  inspectDebug, REPORTED_STYLES,
  type DebugRequest, type DebugResult, type EngineProbe, type InspectDeps,
} from "./debugBridge";

/** How long to wait for one preview engine's `__probeReply`. Short: the engine answers in the same tick
 *  when it is alive, so anything longer only delays reporting a SILENT engine — the interesting case. */
const ENGINE_PROBE_MS = 250;

/** Ask one preview's engine to describe itself; `null` when it does not answer in time. */
function probeEngine(iframe: HTMLIFrameElement): Promise<EngineProbe | null> {
  const win = iframe.contentWindow;
  if (!win) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: EngineProbe | null) => {
      if (done) return;
      done = true;
      window.removeEventListener("message", onMsg);
      clearTimeout(timer);
      resolve(v);
    };
    const onMsg = (e: MessageEvent) => {
      // Correlate by SOURCE WINDOW, as the preview frame + runtime probe already do (#2908): several
      // previews can be mounted, and taking the first reply would attribute one engine's state to another.
      if (e.source !== win) return;
      const d = e.data as { __probeReply?: EngineProbe } | null;
      if (d?.__probeReply) finish(d.__probeReply);
    };
    const timer = setTimeout(() => finish(null), ENGINE_PROBE_MS);
    window.addEventListener("message", onMsg);
    try {
      win.postMessage({ __probe: 1 }, "*");
    } catch {
      finish(null); // a cross-origin refusal is "no answer", not a crash
    }
  });
}

/** The real-DOM capability set handed to the pure inspector. */
function liveDeps(): InspectDeps {
  return {
    at: (x, y) => document.elementFromPoint(x, y),
    rectOf: (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    },
    stylesOf: (el) => {
      const cs = getComputedStyle(el);
      const out: Record<string, string> = {};
      for (const k of REPORTED_STYLES) out[k] = cs.getPropertyValue(k) || "";
      return out;
    },
    query: (selector) => Array.from(document.querySelectorAll(selector)),
    frames: () => mountedPreviewFrames(),
    probeEngine,
  };
}

/**
 * Listen for `bsc://debug` and answer it. Mounted once by the shell.
 *
 * An invalid selector is a STATED error, not a crash: `querySelectorAll` throws on bad syntax, and the
 * caller needs "that selector is malformed" rather than a timeout.
 */
export function useDebugChannel(): void {
  useEffect(() => {
    let disposed = false;
    const un = listen<DebugRequest & { id: string }>("bsc://debug", (e) => {
      const { id, ...req } = e.payload;
      void (async () => {
        let result: DebugResult | null = null;
        let error: string | null = null;
        try {
          result = await inspectDebug(req as DebugRequest, liveDeps());
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }
        if (disposed) return;
        try {
          await invoke("debug_ack", { ack: { id, ...(error ? { error } : { result }) } });
        } catch (err) {
          // The waiter will time out; log so the failure is attributable rather than mysterious.
          log.error(`debug: could not ack ${id}: ${String(err)}`);
        }
      })();
    });
    return () => {
      disposed = true;
      void un.then((f) => f());
    };
  }, []);
}
