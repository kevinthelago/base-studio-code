import { describe, it, expect } from "vitest";
import { hashAbs } from "./hash";

/** The former private copy in glanceData.ts / glanceFleet.ts, verbatim — the reference
 *  implementation hashAbs must reproduce exactly (#2421). */
function legacyHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

describe("hashAbs — byte-compatible with the former glance hash()", () => {
  const samples = [
    "", "a", "director", "worker-1", "worker-2p-abc123",
    "p-lxq8-9k2f4a", "reporting", "analytics",
    // Long strings overflow into the sign bit, where `>>> 0` vs `| 0`+abs diverge —
    // exactly the case the derivation must get right.
    "a-much-longer-project-identifier-that-overflows-32-bits",
    "worker-3p-m4nifest-2421", "🚀 non-ascii too",
  ];

  it("matches the legacy implementation on every sample (incl. sign-bit overflows)", () => {
    for (const s of samples) {
      expect(hashAbs(s), JSON.stringify(s)).toBe(legacyHash(s));
    }
  });

  it("is non-negative and deterministic", () => {
    for (const s of samples) {
      expect(hashAbs(s)).toBeGreaterThanOrEqual(0);
      expect(hashAbs(s)).toBe(hashAbs(s));
    }
  });

  it("keeps the modulo assignments the samples rely on stable", () => {
    // Pin a few concrete values so a future "simplification" to >>>0 (which flips
    // sign-bit cases) fails loudly rather than silently recoloring sample data.
    expect(hashAbs("director") % 3).toBe(legacyHash("director") % 3);
    expect(hashAbs("a-much-longer-project-identifier-that-overflows-32-bits") % 4)
      .toBe(legacyHash("a-much-longer-project-identifier-that-overflows-32-bits") % 4);
  });
});
