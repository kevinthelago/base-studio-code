// The networks feature's public API. A NETWORK is a domain: the set of projects that share one concern,
// drawn as one Glance tab, and the owner of exactly one architect session.
//
// Cross-feature, import ONLY this barrel (#1545). Glance reaches networks through it; nothing reaches
// past it into `lib/` or `store`.
export { createNetworksSlice, type NetworksSlice } from "@/features/networks/store";
export { mintNetworkId, type Network } from "@/features/networks/lib/networkBridge";
