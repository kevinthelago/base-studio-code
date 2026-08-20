// The rollback for files-to-zero — and specifically what it REFUSES.
//
// Restoring the wrong record does not fail loudly; it silently replaces a live module with a fragment
// of itself. That is why the refusal has more tests than the happy path.
import { describe, it, expect } from "vitest";
import { restorable, planRestore } from "./graph-unmaterialize.mjs";

const moduleRecord = { id: "bsc-blueprint-cli.rs", src: "crates/bsc-blueprint/src/cli.rs", code: "pub fn run() {}" };
const functionRecord = { id: "unquote.rs", src: "crates/cve/src/install.rs", code: "pub fn unquote() {}" };

describe("restorable", () => {
  it("needs both a src and a body", () => {
    expect(restorable([moduleRecord])).toHaveLength(1);
    expect(restorable([{ id: "a", code: "x" }])).toHaveLength(0);
    expect(restorable([{ id: "a", src: "p.rs" }])).toHaveLength(0);
    expect(restorable([{ id: "a", src: "  ", code: "x" }])).toHaveLength(0);
  });

  it("tolerates a missing implementations array", () => {
    expect(restorable(undefined)).toHaveLength(0);
  });
});

describe("planRestore", () => {
  it("restores a materialized module, whose source is absent by construction", () => {
    const { plan, refused } = planRestore([moduleRecord], () => false);
    expect(refused).toHaveLength(0);
    expect(plan[0].path).toBe("crates/bsc-blueprint/src/cli.rs");
    expect(plan[0].content.endsWith("\n"), "files end with a newline").toBe(true);
  });

  /**
   * THE CASE THE DRY RUN CAUGHT, and the reason this guard exists at all. `unquote.rs` is 8 lines lifted
   * OUT of `crates/cve/src/install.rs`, a live ~200-line module. Writing it back would delete everything
   * else in that file. A materialized module's source is absent; a target that EXISTS therefore means
   * this record does not own it.
   */
  it("REFUSES a record whose target file still exists", () => {
    const { plan, refused } = planRestore([functionRecord], (p) => p === "crates/cve/src/install.rs");
    expect(plan).toHaveLength(0);
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toMatch(/EXISTS/);
  });

  it("sorts one from the other in a mixed store", () => {
    const { plan, refused } = planRestore([moduleRecord, functionRecord], (p) => p.includes("cve"));
    expect(plan.map((f) => f.id)).toEqual(["bsc-blueprint-cli.rs"]);
    expect(refused.map((f) => f.id)).toEqual(["unquote.rs"]);
  });

  it("does not double a trailing newline", () => {
    const { plan } = planRestore([{ ...moduleRecord, code: "pub fn run() {}\n" }], () => false);
    expect(plan[0].content).toBe("pub fn run() {}\n");
  });
});
