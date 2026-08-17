import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  srcHash, attest, flushAttestations, enableAttestation, attestSession,
  __resetAttestationsForTest, __pendingAttestationsForTest,
} from "./attest";
import fixtures from "@data/runtime/hash.fixtures.json";
import wire from "@data/runtime/attest-wire.fixtures.json";

beforeEach(() => {
  __resetAttestationsForTest();
  vi.mocked(invoke).mockClear();
});
afterEach(() => __resetAttestationsForTest());

describe("srcHash — the cross-language contract", () => {
  // THE test in this file. The frontend hashes what it compiled and `doctor` hashes what is in the
  // store; every "did this version run?" answer is that comparison. Two implementations that disagree
  // do not produce an error — they produce confident noise.
  it("agrees with the shared fixture, case for case", () => {
    expect(fixtures.algorithm).toBe("fnv1a64-utf8-hex16");
    expect(fixtures.cases.length).toBeGreaterThanOrEqual(6);
    for (const c of fixtures.cases) {
      expect(srcHash(c.input), c.why).toBe(c.hash);
    }
  });

  it("hashes UTF-8 BYTES, which is where a char-wise implementation would diverge", () => {
    // A `for (const ch of s)` implementation agrees with Rust on ASCII and breaks here — and this
    // repo's records are full of em dashes, so that is the normal case, not an edge case.
    expect(srcHash("—")).not.toBe(srcHash("-"));
    expect(srcHash("—")).toBe(srcHash("—"));
  });

  it("is 16 hex chars, deterministic, and sensitive to a one-character edit", () => {
    for (const s of ["", "a", "export const N = 1;"]) {
      expect(srcHash(s)).toMatch(/^[0-9a-f]{16}$/);
      expect(srcHash(s)).toBe(srcHash(s));
    }
    expect(srcHash("export const N = 1;")).not.toBe(srcHash("export const N = 2;"));
  });
});

describe("the sink", () => {
  const row = (o: Partial<Parameters<typeof attest>[0]> = {}) => ({
    specifier: "@/x", recordId: "rec", srcHash: "h1", outcome: "served" as const, ...o,
  });

  it("is INERT until enabled — a test or a preview must not need a Tauri mock", () => {
    attest(row());
    expect(__pendingAttestationsForTest()).toHaveLength(0);
  });

  it("coalesces repeats onto one row, summing n and ms and keeping the max", () => {
    enableAttestation();
    attest(row({ ms: 700 }));
    attest(row({ ms: 300 }));
    attest(row({ ms: 500 }));
    const pending = __pendingAttestationsForTest();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ n: 3, ms_total: 1500, ms_max: 700 });
  });

  it("splits on every part of the store's key, so unlike facts never merge", () => {
    enableAttestation();
    attest(row());
    attest(row({ specifier: "@/y" }));
    attest(row({ recordId: "other" }));
    attest(row({ srcHash: "h2" }));
    attest(row({ outcome: "declined-eval" }));
    expect(__pendingAttestationsForTest()).toHaveLength(5);
  });

  it("keeps the FIRST reason, matching the store's own rule", () => {
    enableAttestation();
    attest(row({ outcome: "declined-closure", reason: "needs @/a" }));
    attest(row({ outcome: "declined-closure", reason: "truncated…" }));
    expect(__pendingAttestationsForTest()[0].reason).toBe("needs @/a");
  });

  it("records a FILE-served module with an empty record id", () => {
    enableAttestation();
    attest({ specifier: "@/x", outcome: "served" });
    expect(__pendingAttestationsForTest()[0]).toMatchObject({ record_id: "", src_hash: "" });
  });

  it("stamps one session id across the batch", () => {
    enableAttestation();
    attest(row());
    attest(row({ specifier: "@/y" }));
    const sessions = new Set(__pendingAttestationsForTest().map((r) => r.session));
    expect([...sessions]).toEqual([attestSession()]);
  });

  it("flushes through ONE invoke and clears what it sent", async () => {
    enableAttestation();
    attest(row({ ms: 10 }));
    attest(row({ specifier: "@/y" }));
    await flushAttestations();
    const calls = vi.mocked(invoke).mock.calls.filter(([c]) => c === "record_attestations");
    expect(calls).toHaveLength(1);
    expect((calls[0][1] as { rows: unknown[] }).rows).toHaveLength(2);
    expect(__pendingAttestationsForTest()).toHaveLength(0);
  });

  it("still produces the SHAPE the captured wire fixture holds — the other half of the contract", async () => {
    // Rust asserts this same file deserializes; this asserts the frontend still emits it. Without the
    // pair, a rename here is a silent no-op there: serde defaults every optional field, so the app would
    // keep folding rows full of blanks and look perfectly healthy.
    enableAttestation();
    attest({ specifier: "@/features/glance/GlanceWorkspace", recordId: "glancepage", srcHash: "8e543092bdc94add", outcome: "served", ms: 700 });
    attest({ specifier: "@/features/glance/GlanceWorkspace", recordId: "glancepage", srcHash: "8e543092bdc94add", outcome: "served", ms: 900 });
    attest({ specifier: "@/broken", recordId: "broken-rec", outcome: "declined-closure", reason: "needs @/definitely/not/registered" });
    attest({ specifier: "@/shared/lib/core/format", outcome: "served" });
    await flushAttestations();

    const sent = (vi.mocked(invoke).mock.calls.find(([c]) => c === "record_attestations")![1] as { rows: Record<string, unknown>[] }).rows;
    const norm = (r: Record<string, unknown>) => ({ ...r, session: "s-fixture", at: 1755300000000 });
    expect(sent.map(norm)).toEqual(wire.rows);
  });

  it("does not invoke when there is nothing pending", async () => {
    enableAttestation();
    await flushAttestations();
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === "record_attestations")).toHaveLength(0);
  });

  it("SWALLOWS a flush failure — an observation must never break the app", async () => {
    enableAttestation();
    vi.mocked(invoke).mockRejectedValueOnce(new Error("no backend"));
    attest(row());
    await expect(flushAttestations()).resolves.toBeUndefined();
    // …and the failed batch is dropped rather than retried: a retry loop grows the queue while the app
    // is already unhappy, and a slightly lower `n` is the cheaper loss.
    expect(__pendingAttestationsForTest()).toHaveLength(0);
  });

  it("drains BEFORE awaiting, so an observation during the flush is not cleared unsent", async () => {
    enableAttestation();
    let resolveInvoke: (v: unknown) => void = () => {};
    vi.mocked(invoke).mockImplementationOnce(() => new Promise((r) => { resolveInvoke = r; }));
    attest(row());
    const inFlight = flushAttestations();
    // Arrives while the IPC is open — it belongs to the NEXT batch, not to the cleared one.
    attest(row({ specifier: "@/late" }));
    resolveInvoke(undefined);
    await inFlight;
    expect(__pendingAttestationsForTest().map((r) => r.specifier)).toEqual(["@/late"]);
  });

  it("flushes early on a burst rather than holding a whole closure until the timer", async () => {
    enableAttestation();
    // A first page mount links hundreds of modules in one tick; waiting out the timer would hold them
    // all in memory for no benefit.
    for (let i = 0; i < 500; i += 1) attest(row({ specifier: `@/m${i}`, outcome: "linked" }));
    await Promise.resolve();
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === "record_attestations").length).toBeGreaterThan(0);
  });
});
