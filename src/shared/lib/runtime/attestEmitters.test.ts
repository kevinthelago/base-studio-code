// The EMITTERS, tested through the real loader (#runtime-attests-what-actually-ran).
//
// `attest.test.ts` proves the sink coalesces and that the hash matches Rust. Neither says anything about
// whether the loader CALLS it — and an emitter that is never reached is the exact failure this feature
// exists to end: every gate green, the store empty, and "no record ever declined" indistinguishable from
// "attestation was never wired up".
//
// So these drive `loadComponentFromSource` and assert on what came out of the sink. The compile step is
// INJECTED (esbuild-wasm is browser-only), and the fixtures are hand-written CommonJS — the same shape
// esbuild emits and the same approach `componentLoader.test.ts` already takes.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadComponentFromSource } from "@/shared/lib/runtime/componentLoader";
import { registerAppModule, __resetRegistry } from "@/shared/lib/runtime/moduleRegistry";
import {
  enableAttestation, __resetAttestationsForTest, __pendingAttestationsForTest, srcHash,
} from "./attest";

/** The injected compile: the fixtures are already CJS, so this is identity. What matters is that
 *  `scanRequires` runs over it exactly as it does over esbuild's real output. */
const identity = async (src: string) => src;

beforeEach(() => {
  __resetRegistry();
  __resetAttestationsForTest();
  enableAttestation();
});
afterEach(() => {
  __resetAttestationsForTest();
  __resetRegistry();
});

/** Rows for one outcome, so each case reads as the fact it asserts. */
const rows = (outcome: string) => __pendingAttestationsForTest().filter((r) => r.outcome === outcome);

const COMPONENT = 'module.exports = { default: function C() { return null; } };\n';

describe("the loader attests what it decided", () => {
  it("attests every module in the closure that SERVED, with the hash of what linked", async () => {
    const sibling = 'module.exports = { helper: function () { return 1; } };\n';
    const entry = `const sib = require("@/components/sib");\n${COMPONENT}`;
    await loadComponentFromSource(entry, (spec) => (spec === "@/components/sib" ? sibling : null), undefined, identity);

    const linked = rows("linked");
    // The sibling is an ORDINARY closure member — the same shape an algorithm implementation takes, and
    // the reason LINKAGE is the honest claim for one rather than an execution count.
    const sib = linked.find((r) => r.specifier === "@/components/sib");
    expect(sib, `expected @/components/sib among [${linked.map((r) => r.specifier).join(", ")}]`).toBeTruthy();
    // The hash is of the SOURCE THAT LINKED, so a later edit cannot inherit this evidence.
    expect(sib!.src_hash).toBe(srcHash(sibling));
  });

  it("attests a DECLINED-CLOSURE override instead of only logging it", async () => {
    // A record whose closure needs a module that is neither registered nor a record: the runtime serves
    // the platform module instead and the record is INERT. That is the case which was invisible — one
    // warn line, and a graph that looked healthy.
    const broken = 'const nope = require("@/definitely/not/registered");\nmodule.exports = { X: nope };\n';
    const entry = `const b = require("@/broken");\n${COMPONENT}`;
    registerAppModule("@/broken", { X: 1 }); // the platform module it shadows, so the page still loads
    await loadComponentFromSource(entry, (spec) => (spec === "@/broken" ? broken : null), undefined, identity);

    const d = rows("declined-closure").find((r) => r.specifier === "@/broken");
    expect(d, `expected @/broken declined, got [${rows("declined-closure").map((r) => r.specifier).join(", ")}]`).toBeTruthy();
    // The REASON names the missing module. Without it the finding says "something was wrong" and the
    // reader is back to the log dive this replaced.
    expect(d!.reason).toContain("@/definitely/not/registered");
    // A declined record has no version to claim ran.
    expect(d!.src_hash).toBe("");
  });

  it("attests a DECLINED-EVAL override — it compiled and linked, then threw at module init", async () => {
    // The commonest real cause is a build-time-only form (`import.meta.glob` survives esbuild verbatim);
    // a bare throw reaches the identical decision point.
    const exploding = 'throw new Error("module init boom");\n';
    const entry = `const b = require("@/boom");\n${COMPONENT}`;
    registerAppModule("@/boom", { ok: true });
    await loadComponentFromSource(entry, (spec) => (spec === "@/boom" ? exploding : null), undefined, identity);

    const d = rows("declined-eval").find((r) => r.specifier === "@/boom");
    expect(d, `expected @/boom declined-eval, got [${rows("declined-eval").map((r) => r.specifier).join(", ")}]`).toBeTruthy();
    expect(d!.reason).toContain("boom");
  });

  it("never attributes the ENTRY's failure to the modules it pulled in", async () => {
    // An entry that exports no component still LINKED its closure. Attesting those as failed would blame
    // every dependency for the entry's problem — and those rows are what `doctor` reads to decide whether
    // an implementation is live.
    const sibling = 'module.exports = { helper: function () { return 1; } };\n';
    const entry = 'const sib = require("@/components/sib");\nmodule.exports = { notAComponent: 1 };\n';
    await expect(
      loadComponentFromSource(entry, (spec) => (spec === "@/components/sib" ? sibling : null), undefined, identity),
    ).rejects.toThrow();
    expect(rows("linked").some((r) => r.specifier === "@/components/sib")).toBe(true);
    expect(rows("declined-compile")).toHaveLength(0);
    expect(rows("declined-closure")).toHaveLength(0);
    expect(rows("declined-eval")).toHaveLength(0);
  });

  it("emits NOTHING when the sink is off — the loader must never REQUIRE attestation", async () => {
    // Every existing loader test runs with it off, and none of them should have to learn about it.
    __resetAttestationsForTest(); // leaves it disabled
    await loadComponentFromSource(COMPONENT, () => null, undefined, identity);
    expect(__pendingAttestationsForTest()).toHaveLength(0);
  });
});
