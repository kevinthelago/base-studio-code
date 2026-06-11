/**
 * FNV-1a 32-bit hash — the canonical hash for the planner-sync protocol.
 *
 * Operates on UTF-8 bytes via TextEncoder for cross-platform parity: Rust
 * hashes &str bytes directly (UTF-8); JS must encode first. The Math.imul +
 * >>> 0 form is the only correct 32-bit overflow pattern in JavaScript (a plain
 * `*` promotes to float64 and loses precision past 53 bits; Math.imul gives the
 * correct low 32 bits of the integer product).
 *
 * Pinned test vectors in src/lib/plannerCore.fixtures.json (fnv1a32 section).
 */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  const bytes = new TextEncoder().encode(s);
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** Lowercase 8-char hex representation of an fnv1a32 result. */
export function fnv1a32hex(s: string): string {
  return fnv1a32(s).toString(16).padStart(8, "0");
}
