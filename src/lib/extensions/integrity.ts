// Bundle integrity for code-bearing extensions (#598 M3). A gist owner can edit a gist
// after you install it, so we record a sha256 of the code bundle at install time and
// verify it on every load — a silent edit (or a swapped file) fails the check and the
// pipeline won't run. Web Crypto is available in the Tauri webview and Node 20+.

/** sha256 of a string → lowercase hex. */
export async function sha256Hex(content: string): Promise<string> {
  const data = new TextEncoder().encode(content);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Integrity string recorded in a manifest: `sha256:<hex>`. */
export async function computeIntegrity(content: string): Promise<string> {
  return "sha256:" + (await sha256Hex(content));
}

/** Verify a bundle against a recorded integrity string. Missing / malformed / mismatch ⇒ false. */
export async function verifyIntegrity(content: string, expected: string | undefined): Promise<boolean> {
  if (!expected || !expected.startsWith("sha256:")) return false;
  return (await computeIntegrity(content)) === expected;
}
