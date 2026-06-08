// @vitest-environment node
// Runs in node so Web Crypto's crypto.subtle is available (jsdom's may lack it).
import { describe, it, expect } from "vitest";
import { sha256Hex, computeIntegrity, verifyIntegrity } from "../lib/extensions/integrity";

describe("integrity (#598 M3)", () => {
  it("sha256Hex matches the known 'abc' vector", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("computeIntegrity is sha256:<hex>", async () => {
    expect(await computeIntegrity("abc")).toBe("sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("verifyIntegrity matches identical content and rejects edits / bad formats", async () => {
    const good = await computeIntegrity("bundle();");
    expect(await verifyIntegrity("bundle();", good)).toBe(true);
    expect(await verifyIntegrity("bundle(); /* edited */", good)).toBe(false);
    expect(await verifyIntegrity("bundle();", undefined)).toBe(false);
    expect(await verifyIntegrity("bundle();", "md5:whatever")).toBe(false);
  });
});
