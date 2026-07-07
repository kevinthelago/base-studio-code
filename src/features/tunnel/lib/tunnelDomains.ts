// The app-wide store_state publisher (#2498) — the singleton the projector hook and the
// planner's plan-domain push share, bound to the real `tunnel_set_store_state` command.
// Kept apart from domainPublisher.ts so the engine stays Tauri-free and unit-testable.

import { createDomainPublisher } from "./domainPublisher";
import { tunnelSetStoreState, type StoreDomain } from "./tunnelClient";
import { log } from "@/shared/lib/core/log";

const publisher = createDomainPublisher({
  send: tunnelSetStoreState,
  onError: (domain, e) => log.error(`tunnel: store_state[${domain}] push failed: ${e}`),
});

/** Publish one domain's projection over the tunnel — debounced, deduped, rev-stamped.
 *  Safe to call on every derivation: an unchanged payload never reaches the wire. */
export function publishTunnelDomain(domain: StoreDomain, payload: unknown): void {
  publisher.publish(domain, payload);
}

/** Forget the last-sent cache (the next publish per domain re-sends). Called when the relay
 *  (re)starts so a fresh Rust-side store is repopulated even if the store didn't change. */
export function resetTunnelDomains(): void {
  publisher.reset();
}
