// sha256 over text (#2465) — the frontend's half of the kit-store integrity contract. The global
// UI-kit store keys immutable `id@version` artifacts by the sha256 of their bytes (lowercase hex);
// this must produce the SAME digest as the Rust store (`crates/bsc-ui/src/kit.rs::sha256_hex`) and
// the generator sidecar (node:crypto in reactUiKit.gen.test.ts) so a pin verified here is the pin
// the store enforces. WebCrypto (async) — available in the WebView and in Node ≥ 20.

/** Lowercase hex sha256 of `text` (UTF-8 bytes). */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
