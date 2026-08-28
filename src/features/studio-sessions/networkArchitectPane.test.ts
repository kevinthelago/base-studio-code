// The pane id for a network's architect is agreed by TWO codebases, and a disagreement is silent.
//
// The frontend mints it (`networkArchitectPaneId`) and mounts a terminal on it. Rust decides whether
// `bsc session stop <id>` may name it (`bsc_session::network_architect_slug`) and derives the session's
// workspace directory from it. If the two ever drift, the session still launches and still runs — it is
// simply unreachable from the command surface, and `bsc session stop` reports "not a system session"
// about a pane that is plainly alive. Nothing else in either suite would notice.
//
// So this test reads the RUST source and pins the grammar against it, rather than asserting the
// frontend agrees with itself.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { networkArchitectPaneId, NETWORK_ARCHITECT_PERSONA } from "@/features/studio-sessions/NetworkArchitectMount";

const RUST = readFileSync("crates/bsc-session/src/lib.rs", "utf8");

describe("the network architect pane id", () => {
  it("is `<networkId>:architect`, one colon, the network id as the key", () => {
    expect(networkArchitectPaneId("network-kitchen")).toBe("network-kitchen:architect");
    // ONE colon: the pane grammar reads the key as `paneId.split(":")[0]`, so a compound key takes a
    // hyphen. `network-kitchen` is already the id the `bsc network` store mints, which is why the key
    // and the network id cannot drift apart.
    expect(networkArchitectPaneId("network-kitchen").split(":")).toHaveLength(2);
    expect(networkArchitectPaneId("network-kitchen").split(":")[0]).toBe("network-kitchen");
  });

  it("matches the prefix and tail Rust resolves against", () => {
    // Rust: `pub const NETWORK_PREFIX: &str = "network-";`
    const prefix = RUST.match(/NETWORK_PREFIX: &str = "([^"]+)"/)?.[1];
    const tail = RUST.match(/NETWORK_ARCHITECT_TAIL: &str = "([^"]+)"/)?.[1];
    expect(prefix, "Rust must still declare NETWORK_PREFIX").toBeDefined();
    expect(tail, "Rust must still declare NETWORK_ARCHITECT_TAIL").toBeDefined();

    const pane = networkArchitectPaneId(`${prefix}kitchen`);
    expect(pane.startsWith(prefix!)).toBe(true);
    expect(pane.endsWith(tail!)).toBe(true);
    // …and the slug Rust would recover is the one we put in.
    expect(pane.slice(prefix!.length, pane.length - tail!.length)).toBe("kitchen");
  });

  it("runs as the architect persona the packaged charter describes", () => {
    // The same identity the Teams Studio architect carries: a network changes which DOMAIN the
    // architect is pointed at, not what an architect is.
    expect(NETWORK_ARCHITECT_PERSONA).toBe("persona-architect");
  });
});
