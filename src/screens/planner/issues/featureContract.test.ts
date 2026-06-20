import { describe, it, expect } from "vitest";
import {
  renderFeatureContract,
  validateContracts,
  type FeatureContract,
} from "./featureContract";

function base(overrides: Partial<FeatureContract> = {}): FeatureContract {
  return {
    id: "lan-ws",
    title: "Add plaintext ws:// LAN transport",
    goal: "Serve plaintext ws:// on the LAN.",
    acceptance: ["ws:// client completes the handshake"],
    owns: ["src-tauri/src/tunnel.rs"],
    consumes: [],
    produces: [],
    verification: { tests: [], gate: ["cargo test"] },
    dependsOn: [],
    ...overrides,
  };
}

describe("renderFeatureContract", () => {
  it("renders the core sections with a heading", () => {
    const md = renderFeatureContract(base({ stream: "tunnel", phase: "1" }));
    expect(md).toContain("# Add plaintext ws:// LAN transport  ·  stream: tunnel  ·  phase: 1");
    expect(md).toContain("## Goal");
    expect(md).toContain("## Acceptance criteria\n- [ ] ws:// client completes the handshake");
    expect(md).toContain("## Ownership boundary");
    expect(md).toContain("## Verification");
  });

  it("omits optional sections when empty", () => {
    const md = renderFeatureContract(base());
    expect(md).not.toContain("## Consumes");
    expect(md).not.toContain("## Produces");
    expect(md).not.toContain("## Non-goals");
    expect(md).not.toContain("## Dependencies");
    expect(md).not.toContain("## Notes");
  });

  it("renders consumes/produces tables and escapes pipes in signatures", () => {
    const md = renderFeatureContract(
      base({
        consumes: [
          { name: "handle_client", definedIn: "tunnel.rs", signature: "async fn handle_client<S>(..)" },
        ],
        produces: [
          {
            name: "TunnelStatus.scheme",
            definedIn: "tunnel.rs",
            signature: '"ws" | "wss"',
            invariants: "matches the bound listener",
          },
        ],
      }),
    );
    expect(md).toContain("## Consumes (inbound — frozen; do not read their impl)");
    expect(md).toContain("`handle_client`");
    expect(md).toContain("## Produces (outbound — frozen for dependents)");
    // The union pipe must be escaped so it doesn't break the table row.
    expect(md).toContain('`"ws" \\| "wss"`');
    expect(md).toContain("matches the bound listener");
  });

  it("renders dependencies when present", () => {
    const md = renderFeatureContract(base({ dependsOn: ["#35"], blocks: ["#99"] }));
    expect(md).toContain("## Dependencies");
    expect(md).toContain("- depends_on: #35");
    expect(md).toContain("- blocks: #99");
  });
});

describe("validateContracts", () => {
  const producer = base({
    id: "producer",
    produces: [{ name: "Widget", definedIn: "a.ts", signature: "type Widget" }],
  });
  const consumer = base({
    id: "consumer",
    consumes: [{ name: "Widget", definedIn: "a.ts", signature: "type Widget" }],
    dependsOn: ["producer"],
  });

  it("passes a clean set where every consume resolves to a produce", () => {
    const v = validateContracts([producer, consumer]);
    expect(v.ok).toBe(true);
    expect(v.dangling).toHaveLength(0);
    expect(v.duplicateProduces).toHaveLength(0);
    expect(v.unknownDependencies).toHaveLength(0);
  });

  it("flags a dangling consume nothing produces", () => {
    const v = validateContracts([consumer]); // no producer in the set
    expect(v.ok).toBe(false);
    expect(v.dangling).toEqual([
      { featureId: "consumer", ref: expect.objectContaining({ name: "Widget" }) },
    ]);
  });

  it("flags a contract produced by two features", () => {
    const v = validateContracts([producer, { ...producer, id: "producer2" }]);
    expect(v.duplicateProduces).toEqual([{ name: "Widget", producedBy: ["producer", "producer2"] }]);
    expect(v.ok).toBe(false);
  });

  it("flags an unknown dependency, and resolves issue refs via idByRef", () => {
    const dependsOnRef = base({ id: "x", dependsOn: ["#35"] });
    expect(validateContracts([dependsOnRef]).unknownDependencies).toEqual([
      { featureId: "x", dependsOn: "#35" },
    ]);
    // With a ref→id map, #35 resolves to the producer's id.
    const mapped = validateContracts([producer, base({ id: "x", consumes: producer.produces, dependsOn: ["#35"] })], {
      "#35": "producer",
    });
    expect(mapped.unknownDependencies).toHaveLength(0);
    expect(mapped.ok).toBe(true);
  });
});
