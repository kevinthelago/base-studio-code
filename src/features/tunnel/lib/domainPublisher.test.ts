// Domain publisher (#2498) — rev/dedup/debounce discipline for the store_state projector.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDomainPublisher, type DomainSend } from "./domainPublisher";

describe("createDomainPublisher", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const collect = () => {
    const sent: { domain: string; rev: number; json: string }[] = [];
    const send: DomainSend = (domain, rev, json) => {
      sent.push({ domain, rev, json });
      return Promise.resolve();
    };
    return { sent, send };
  };

  it("debounces rapid publishes into one send carrying the latest payload", () => {
    const { sent, send } = collect();
    const p = createDomainPublisher({ send, debounceMs: 300 });
    p.publish("glance", { v: 1 });
    p.publish("glance", { v: 2 });
    p.publish("glance", { v: 3 });
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(300);
    expect(sent).toEqual([{ domain: "glance", rev: 1, json: JSON.stringify({ v: 3 }) }]);
  });

  it("bumps the rev monotonically per domain and keeps domains independent", () => {
    const { sent, send } = collect();
    const p = createDomainPublisher({ send, debounceMs: 0 });
    p.publish("glance", { v: 1 });
    p.publish("org", { o: 1 });
    p.publish("glance", { v: 2 });
    expect(sent.map((s) => [s.domain, s.rev])).toEqual([["glance", 1], ["org", 1], ["glance", 2]]);
    expect(p.rev("glance")).toBe(2);
    expect(p.rev("org")).toBe(1);
    expect(p.rev("never-sent")).toBe(0);
  });

  it("never re-sends an unchanged payload (no send, no rev bump)", () => {
    const { sent, send } = collect();
    const p = createDomainPublisher({ send, debounceMs: 0 });
    p.publish("skills", { a: [1, 2] });
    p.publish("skills", { a: [1, 2] }); // structurally identical, new object
    expect(sent).toHaveLength(1);
    expect(p.rev("skills")).toBe(1);
  });

  it("drops a debounced send whose payload settled back to the last-sent value", () => {
    const { sent, send } = collect();
    const p = createDomainPublisher({ send, debounceMs: 100 });
    p.publish("mcp", { on: true });
    vi.advanceTimersByTime(100);
    p.publish("mcp", { on: false });
    p.publish("mcp", { on: true }); // flapped back before the window closed
    vi.advanceTimersByTime(100);
    expect(sent).toHaveLength(1);
    expect(p.rev("mcp")).toBe(1);
  });

  it("serializes at publish time so a later mutation cannot corrupt the frame", () => {
    const { sent, send } = collect();
    const p = createDomainPublisher({ send, debounceMs: 100 });
    const payload = { items: [1] };
    p.publish("themes", payload);
    payload.items.push(2); // mutated after publish, before the timer fires
    vi.advanceTimersByTime(100);
    expect(sent[0].json).toBe(JSON.stringify({ items: [1] }));
  });

  it("reset cancels pending sends and forgets last-sent (re-send) but keeps revs monotonic", () => {
    const { sent, send } = collect();
    const p = createDomainPublisher({ send, debounceMs: 100 });
    p.publish("glance", { v: 1 });
    vi.advanceTimersByTime(100);
    p.publish("glance", { v: 2 });
    p.reset(); // pending v:2 dropped
    vi.advanceTimersByTime(100);
    expect(sent).toHaveLength(1);
    p.publish("glance", { v: 1 }); // same as last sent — but the cache was reset, so it re-sends
    vi.advanceTimersByTime(100);
    expect(sent).toHaveLength(2);
    expect(sent[1].rev).toBe(2); // rev continued, never reset
  });

  it("routes a send failure to onError instead of throwing", async () => {
    const errs: string[] = [];
    const p = createDomainPublisher({
      send: () => Promise.reject(new Error("relay down")),
      debounceMs: 0,
      onError: (domain) => errs.push(domain),
    });
    p.publish("alerts", { n: 1 });
    await vi.runAllTimersAsync();
    expect(errs).toEqual(["alerts"]);
  });
});
