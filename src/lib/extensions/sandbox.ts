// Code-pipeline sandbox (#598 M3b). Runs a validated bundle in an isolated context
// (a sandboxed iframe for visual/render pipelines, a Web Worker for compute) and talks
// to it over a tiny postMessage protocol. The host is the security boundary: the bundle
// has NO ambient authority — every side effect goes through a capability request that
// the host fulfils ONLY if the user granted that capability. Integrity is verified
// before the bundle is ever loaded.
//
// The driver (`runInSandbox`) and the harness builder are pure and injected with a
// `SandboxChannel`, so the capability gating + timeout + protocol are unit-testable
// without a real iframe/worker. The browser channel factories live in sandboxChannels.ts.

import { type Capability } from "./manifest";
import { verifyIntegrity } from "./integrity";

// ── wire protocol ─────────────────────────────────────────────────────────────
export interface RunMessage { type: "bsc:run"; ctx: unknown }
export interface ResultMessage { type: "bsc:result"; ok: boolean; output?: unknown; message?: string }
export interface CapRequestMessage { type: "bsc:cap"; id: number; capability: Capability; method: string; args?: unknown }
export interface CapResponseMessage { type: "bsc:cap-result"; id: number; ok: boolean; value?: unknown; error?: string }

export type HostToSandbox = RunMessage | CapResponseMessage;
export type SandboxToHost = ResultMessage | CapRequestMessage;

// ── channel + bridge ──────────────────────────────────────────────────────────
/** Transport to one sandbox instance. The browser factories (iframe/worker) implement
 *  this; tests provide a fake. `dispose` tears the sandbox down. */
export interface SandboxChannel {
  post(msg: HostToSandbox): void;
  subscribe(handler: (msg: SandboxToHost) => void): () => void;
  dispose(): void;
}

/** Host-side fulfilment of a *granted* capability request (read a signal, write a file,
 *  etc.). Only called after the grant check passes. May be async; throwing → error to
 *  the sandbox. */
export type CapabilityBridge = (capability: Capability, method: string, args: unknown) => Promise<unknown> | unknown;

export interface SandboxRunResult { status: "ok" | "fail"; output?: unknown; message?: string }

export interface RunOptions {
  ctx: unknown;
  granted: readonly Capability[];
  bridge?: CapabilityBridge;
  /** Hard wall-clock limit; a runaway bundle resolves to a fail. Default 15s. */
  timeoutMs?: number;
}

/**
 * Drive one sandbox run to completion. Posts the ctx, fulfils granted capability
 * requests via the bridge (denying ungranted ones), and resolves on the bundle's result
 * or the timeout — never rejects. Always disposes the channel.
 */
export function runInSandbox(channel: SandboxChannel, opts: RunOptions): Promise<SandboxRunResult> {
  const granted = new Set(opts.granted);
  const timeoutMs = opts.timeoutMs ?? 15_000;
  return new Promise<SandboxRunResult>((resolve) => {
    let done = false;
    const finish = (r: SandboxRunResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsub();
      channel.dispose();
      resolve(r);
    };
    const timer = setTimeout(() => finish({ status: "fail", message: `sandbox timed out after ${timeoutMs}ms` }), timeoutMs);
    const unsub = channel.subscribe((msg) => {
      if (msg.type === "bsc:result") {
        finish({ status: msg.ok ? "ok" : "fail", output: msg.output, message: msg.message });
        return;
      }
      if (msg.type === "bsc:cap") {
        // THE security gate: an ungranted capability is refused without touching the bridge.
        if (!granted.has(msg.capability)) {
          channel.post({ type: "bsc:cap-result", id: msg.id, ok: false, error: `capability '${msg.capability}' not granted` });
          return;
        }
        if (!opts.bridge) {
          channel.post({ type: "bsc:cap-result", id: msg.id, ok: false, error: "no capability bridge available" });
          return;
        }
        void Promise.resolve()
          .then(() => opts.bridge!(msg.capability, msg.method, msg.args))
          .then((value) => channel.post({ type: "bsc:cap-result", id: msg.id, ok: true, value }))
          .catch((e) => channel.post({ type: "bsc:cap-result", id: msg.id, ok: false, error: String(e) }));
      }
    });
    channel.post({ type: "bsc:run", ctx: opts.ctx });
  });
}

// ── harness ───────────────────────────────────────────────────────────────────
/**
 * Wrap a pipeline bundle in the in-sandbox harness. The bundle registers its entry via
 * `definePipeline(run)` (or assigns `globalThis.__bscPipeline`); `run(ctx)` may be async
 * and returns the pipeline output. Capabilities are requested via `bsc.request(cap,
 * method, args)` which resolves through the host gate. Works in both an iframe (posts to
 * `parent`) and a Worker (posts to `self`).
 */
export function buildSandboxHarness(bundle: string): string {
  return [
    '"use strict";',
    "(function () {",
    "  var _id = 0, _pending = {};",
    '  var _peer = (typeof self !== "undefined" && self.parent && self.parent !== self) ? self.parent : self;',
    '  function send(m){ _peer.postMessage(m, "*"); }',
    "  self.bsc = { request: function(capability, method, args){",
    "    return new Promise(function(res, rej){",
    "      var id = ++_id; _pending[id] = { res: res, rej: rej };",
    '      send({ type: "bsc:cap", id: id, capability: capability, method: method, args: args });',
    "    });",
    "  } };",
    "  var __pipeline = null;",
    "  globalThis.definePipeline = function(fn){ __pipeline = fn; };",
    "  try {",
    bundle,
    "  } catch (e) {",
    '    send({ type: "bsc:result", ok: false, message: "bundle load error: " + String(e && e.message || e) });',
    "  }",
    "  self.addEventListener('message', function(ev){",
    "    var data = ev.data; if (!data) return;",
    '    if (data.type === "bsc:run") {',
    "      Promise.resolve().then(function(){",
    "        var fn = __pipeline || globalThis.__bscPipeline;",
    '        if (typeof fn !== "function") throw new Error("pipeline did not call definePipeline(run)");',
    "        return fn(data.ctx);",
    '      }).then(function(out){ send({ type: "bsc:result", ok: true, output: out }); })',
    '       .catch(function(e){ send({ type: "bsc:result", ok: false, message: String(e && e.message || e) }); });',
    '    } else if (data.type === "bsc:cap-result") {',
    "      var p = _pending[data.id]; if (!p) return; delete _pending[data.id];",
    '      data.ok ? p.res(data.value) : p.rej(new Error(data.error || "capability denied"));',
    "    }",
    "  });",
    "})();",
  ].join("\n");
}

// ── orchestrator ──────────────────────────────────────────────────────────────
export type ChannelFactory = (harnessJs: string, runtime: "iframe" | "worker") => SandboxChannel;

export interface RunCodePipelineArgs {
  bundle: string;
  /** sha256 integrity recorded at install; verified before load. */
  integrity?: string;
  runtime: "iframe" | "worker";
  ctx: unknown;
  granted: readonly Capability[];
  bridge?: CapabilityBridge;
  timeoutMs?: number;
  /** Injected for tests; defaults to the real iframe/worker factory at the call site. */
  makeChannel: ChannelFactory;
}

/**
 * Verify integrity → build the harness → create a sandbox → run. A failed integrity
 * check refuses to load the bundle (no channel is created). Never throws.
 */
export async function runCodePipeline(args: RunCodePipelineArgs): Promise<SandboxRunResult> {
  if (!(await verifyIntegrity(args.bundle, args.integrity))) {
    return { status: "fail", message: "bundle integrity check failed — not running" };
  }
  const harness = buildSandboxHarness(args.bundle);
  let channel: SandboxChannel;
  try {
    channel = args.makeChannel(harness, args.runtime);
  } catch (e) {
    return { status: "fail", message: `could not create sandbox: ${String(e)}` };
  }
  return runInSandbox(channel, { ctx: args.ctx, granted: args.granted, bridge: args.bridge, timeoutMs: args.timeoutMs });
}
