// Domain publisher (#2498) — the rev/dedup/debounce engine behind the generic `store_state`
// projections. One instance fans every domain's pushes through the single `tunnel_set_store_state`
// entry point (#2497) with three guarantees:
//   • DEBOUNCE — rapid store churn coalesces into one frame per domain per window (~300ms).
//   • DEDUP    — an unchanged payload (byte-equal serialized JSON) is never re-sent, so poll-driven
//                sources (faults, coord log) that rebuild identical objects cost nothing on the wire.
//   • REV      — a monotonically increasing per-domain revision stamps each send, so mobile can
//                cheap-skip stale replays. The counter never resets while the app lives.
// Pure (no Tauri/React imports): the transport is injected, so the whole engine is unit-testable
// with fake timers. The app-wide singleton bound to `tunnelSetStoreState` lives in tunnelDomains.ts.

/** Injected transport — the shape of `tunnelSetStoreState`. */
export type DomainSend = (domain: string, rev: number, json: string) => Promise<void>;

export interface DomainPublisherOpts {
  send: DomainSend;
  /** Per-domain debounce window in ms (default 300). `0` sends synchronously (tests). */
  debounceMs?: number;
  /** Error sink for a failed send (default: swallow — the tunnel may simply be down). */
  onError?: (domain: string, err: unknown) => void;
}

export interface DomainPublisher {
  /** Queue one domain's projection. Serializes now (a later mutation can't corrupt the frame),
   *  debounces per domain, and skips the send entirely when the payload is byte-identical to the
   *  last one sent for that domain. */
  publish(domain: string, payload: unknown): void;
  /** Cancel pending timers and forget the last-sent cache so the next publish re-sends each domain
   *  (used when the relay restarts). Rev counters are NOT reset — they stay monotonic. */
  reset(): void;
  /** The current revision for a domain (0 = never sent). Exposed for tests/diagnostics. */
  rev(domain: string): number;
}

export function createDomainPublisher(opts: DomainPublisherOpts): DomainPublisher {
  const debounceMs = opts.debounceMs ?? 300;
  const onError = opts.onError ?? (() => {});
  const revs = new Map<string, number>();
  const lastSent = new Map<string, string>();
  const pending = new Map<string, { json: string; timer: ReturnType<typeof setTimeout> | null }>();

  const fire = (domain: string): void => {
    const p = pending.get(domain);
    if (!p) return;
    pending.delete(domain);
    if (lastSent.get(domain) === p.json) return; // unchanged since the last send — drop
    const rev = (revs.get(domain) ?? 0) + 1;
    revs.set(domain, rev);
    lastSent.set(domain, p.json);
    opts.send(domain, rev, p.json).catch((e) => onError(domain, e));
  };

  return {
    publish(domain, payload) {
      const json = JSON.stringify(payload);
      const p = pending.get(domain);
      if (p) {
        // A send is already scheduled — just refresh the payload it will carry.
        p.json = json;
        return;
      }
      if (lastSent.get(domain) === json) return; // no change at all — nothing to schedule
      if (debounceMs <= 0) {
        pending.set(domain, { json, timer: null });
        fire(domain);
        return;
      }
      const timer = setTimeout(() => fire(domain), debounceMs);
      pending.set(domain, { json, timer });
    },
    reset() {
      for (const p of pending.values()) if (p.timer) clearTimeout(p.timer);
      pending.clear();
      lastSent.clear();
    },
    rev(domain) {
      return revs.get(domain) ?? 0;
    },
  };
}
