// @vitest-environment node
// Node env so computeIntegrity (Web Crypto) is available; the driver is DOM-free.
import { describe, it, expect, vi } from "vitest";
import {
  runInSandbox, buildSandboxHarness, runCodePipeline,
  type SandboxChannel, type HostToSandbox, type SandboxToHost,
} from "../lib/extensions/sandbox";
import { computeIntegrity } from "../lib/extensions/integrity";

/** A fake sandbox channel: records host posts and lets the test play the sandbox. */
class FakeChannel implements SandboxChannel {
  posted: HostToSandbox[] = [];
  disposed = false;
  private handler: ((m: SandboxToHost) => void) | null = null;
  post(m: HostToSandbox) { this.posted.push(m); }
  subscribe(h: (m: SandboxToHost) => void) { this.handler = h; return () => { this.handler = null; }; }
  dispose() { this.disposed = true; }
  emit(m: SandboxToHost) { this.handler?.(m); }
  capResults() { return this.posted.filter((m): m is Extract<HostToSandbox, { type: "bsc:cap-result" }> => m.type === "bsc:cap-result"); }
}

describe("runInSandbox (#598 M3b)", () => {
  it("posts the run ctx and resolves on the bundle result; disposes the channel", async () => {
    const ch = new FakeChannel();
    const p = runInSandbox(ch, { ctx: { a: 1 }, granted: [] });
    expect(ch.posted[0]).toEqual({ type: "bsc:run", ctx: { a: 1 } });
    ch.emit({ type: "bsc:result", ok: true, output: 42 });
    expect(await p).toMatchObject({ status: "ok", output: 42 });
    expect(ch.disposed).toBe(true);
  });

  it("fulfils a GRANTED capability via the bridge", async () => {
    const bridge = vi.fn(async () => "signal-value");
    const ch = new FakeChannel();
    const p = runInSandbox(ch, { ctx: {}, granted: ["read-signals"], bridge });
    ch.emit({ type: "bsc:cap", id: 1, capability: "read-signals", method: "get", args: { k: "x" } });
    await vi.waitFor(() => expect(ch.capResults().length).toBe(1));
    expect(ch.capResults()[0]).toMatchObject({ id: 1, ok: true, value: "signal-value" });
    expect(bridge).toHaveBeenCalledWith("read-signals", "get", { k: "x" });
    ch.emit({ type: "bsc:result", ok: true });
    expect((await p).status).toBe("ok");
  });

  it("DENIES an ungranted capability without touching the bridge (the security gate)", async () => {
    const bridge = vi.fn();
    const ch = new FakeChannel();
    const p = runInSandbox(ch, { ctx: {}, granted: ["read-signals"], bridge });
    ch.emit({ type: "bsc:cap", id: 7, capability: "network", method: "fetch", args: {} });
    expect(ch.capResults()[0]).toMatchObject({ id: 7, ok: false });
    expect(ch.capResults()[0].error).toMatch(/not granted/);
    expect(bridge).not.toHaveBeenCalled();
    ch.emit({ type: "bsc:result", ok: false, message: "done" });
    expect((await p).status).toBe("fail");
  });

  it("a granted capability with no bridge is refused", async () => {
    const ch = new FakeChannel();
    const p = runInSandbox(ch, { ctx: {}, granted: ["write-files"] });
    ch.emit({ type: "bsc:cap", id: 3, capability: "write-files", method: "write", args: {} });
    expect(ch.capResults()[0]).toMatchObject({ id: 3, ok: false });
    expect(ch.capResults()[0].error).toMatch(/no capability bridge/);
    ch.emit({ type: "bsc:result", ok: true });
    await p;
  });

  it("times out a runaway bundle and disposes", async () => {
    vi.useFakeTimers();
    const ch = new FakeChannel();
    const p = runInSandbox(ch, { ctx: {}, granted: [], timeoutMs: 1000 });
    vi.advanceTimersByTime(1000);
    const r = await p;
    expect(r.status).toBe("fail");
    expect(r.message).toMatch(/timed out/);
    expect(ch.disposed).toBe(true);
    vi.useRealTimers();
  });
});

describe("buildSandboxHarness (#598 M3b)", () => {
  it("embeds the bundle and wires the protocol + capability bridge", () => {
    const h = buildSandboxHarness("definePipeline(function(ctx){ return ctx.x * 2; });");
    expect(h).toContain("ctx.x * 2");          // bundle embedded
    expect(h).toContain("definePipeline");
    expect(h).toContain("self.bsc");           // capability request surface
    expect(h).toContain("bsc:run");
    expect(h).toContain("bsc:cap-result");
  });
});

describe("runCodePipeline (#598 M3b)", () => {
  it("refuses to load when integrity fails — no channel created", async () => {
    const makeChannel = vi.fn(() => { throw new Error("should not be called"); });
    const r = await runCodePipeline({ bundle: "CODE", integrity: "sha256:wrong", runtime: "worker", ctx: {}, granted: [], makeChannel });
    expect(r.status).toBe("fail");
    expect(r.message).toMatch(/integrity/);
    expect(makeChannel).not.toHaveBeenCalled();
  });

  it("runs end-to-end when integrity matches", async () => {
    const bundle = "BUNDLE_SOURCE";
    const integrity = await computeIntegrity(bundle);
    const makeChannel = (_harness: string, _runtime: "iframe" | "worker") => {
      const ch = new FakeChannel();
      const orig = ch.post.bind(ch);
      ch.post = (m: HostToSandbox) => { orig(m); if (m.type === "bsc:run") queueMicrotask(() => ch.emit({ type: "bsc:result", ok: true, output: "ran" })); };
      return ch;
    };
    const r = await runCodePipeline({ bundle, integrity, runtime: "worker", ctx: { n: 1 }, granted: [], makeChannel });
    expect(r).toMatchObject({ status: "ok", output: "ran" });
  });
});
