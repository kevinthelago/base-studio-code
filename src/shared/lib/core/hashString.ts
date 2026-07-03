// hashString (#2256) — a tiny, stable, non-cryptographic content fingerprint. Used to detect when a
// confirmed planning stage's content has CHANGED since it was confirmed (so just that stage resets).
// Not for security — only for change detection — so a cheap 32-bit rolling hash (djb2 variant) is
// plenty. Deterministic across runs/processes for the same input, which is the whole contract: the
// store's write-through and the poll's reconcile must agree on the same string → same fingerprint.

/** A stable base36 fingerprint of `content` (empty string → a fixed sentinel). Same input ⇒ same
 *  output, in any process — so the confirm-time and revisit-time fingerprints compare equal. */
export function hashString(content: string): string {
  let h = 5381;
  for (let i = 0; i < content.length; i++) {
    // h * 33 + c, kept in 32-bit range so the result is process-independent.
    h = (Math.imul(h, 33) + content.charCodeAt(i)) | 0;
  }
  // >>> 0 → unsigned, so the base36 string has no leading '-'. Prefix with the length as a cheap
  // extra discriminator (collisions on the 32-bit hash still differ if the lengths do).
  return `${content.length.toString(36)}-${(h >>> 0).toString(36)}`;
}
