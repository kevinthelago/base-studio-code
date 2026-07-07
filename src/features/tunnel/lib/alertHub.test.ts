// Alert hub (#2498) — fold → publish the alerts domain → one FCM push per FRESH alert.
import { describe, it, expect, vi } from "vitest";
import { createAlertHub } from "./alertHub";
import type { AlertEvent } from "./alerts";
import type { AlertsPayload } from "./storeProjections";

const alert = (id: string, kind: AlertEvent["kind"] = "agent-paused", at = 1): AlertEvent => ({
  id, kind, paneId: "demo:auth", text: `text for ${id}`, at,
});

function makeHub() {
  const published: AlertsPayload[] = [];
  const pushed: { kind: string; title: string; body: string }[] = [];
  const hub = createAlertHub({
    publish: (payload) => published.push(payload as AlertsPayload),
    push: (a, title, body) => {
      pushed.push({ kind: a.kind, title, body });
      return Promise.resolve();
    },
  });
  return { hub, published, pushed };
}

describe("createAlertHub", () => {
  it("publishes the inbox and pushes once per fresh alert", () => {
    const { hub, published, pushed } = makeHub();
    hub.record([alert("a"), alert("b", "worker-question")]);
    expect(published).toHaveLength(1);
    expect(published[0].alerts.map((a) => a.id)).toEqual(["a", "b"]);
    expect(pushed).toEqual([
      { kind: "agent-paused", title: "Agent paused — demo:auth", body: "text for a" },
      { kind: "worker-question", title: "Worker question — demo:auth", body: "text for b" },
    ]);
    expect(hub.inbox().map((a) => a.id)).toEqual(["a", "b"]);
  });

  it("re-recording the same candidates publishes and pushes NOTHING (dedup)", () => {
    const { hub, published, pushed } = makeHub();
    hub.record([alert("a")]);
    hub.record([alert("a")]); // e.g. the coord poll re-derived the same event
    expect(published).toHaveLength(1);
    expect(pushed).toHaveLength(1);
  });

  it("accumulates across records — the inbox grows, only new alerts push", () => {
    const { hub, published, pushed } = makeHub();
    hub.record([alert("a")]);
    hub.record([alert("a"), alert("b")]);
    expect(published).toHaveLength(2);
    expect(published[1].alerts.map((a) => a.id)).toEqual(["a", "b"]);
    expect(pushed.map((p) => p.body)).toEqual(["text for a", "text for b"]);
  });

  it("seed folds + publishes WITHOUT pushing, and a later record won't re-push it", () => {
    const { hub, published, pushed } = makeHub();
    hub.seed([alert("historic-1"), alert("historic-2")]); // the first coord-log read
    expect(published).toHaveLength(1);
    expect(published[0].alerts.map((a) => a.id)).toEqual(["historic-1", "historic-2"]);
    expect(pushed).toHaveLength(0);
    hub.record([alert("historic-1"), alert("live")]); // subsequent poll: only the live one pushes
    expect(pushed.map((p) => p.body)).toEqual(["text for live"]);
  });

  it("survives a push rejection (routed to onError, publish already done)", async () => {
    const errs: unknown[] = [];
    const hub = createAlertHub({
      publish: () => {},
      push: () => Promise.reject(new Error("no fcm")),
      onError: (e) => errs.push(e),
    });
    hub.record([alert("a")]);
    await vi.waitFor(() => expect(errs).toHaveLength(1));
    expect(hub.inbox()).toHaveLength(1);
  });
});
