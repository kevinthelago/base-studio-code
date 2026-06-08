import { describe, it, expect } from "vitest";
import {
  MANIFEST_VERSION, wrapExtension, validateManifest, parseManifest,
  encodeShareCode, decodeShareCode,
} from "../lib/extensions/manifest";

describe("extension manifest envelope (#598)", () => {
  it("wraps a payload with the current envelope version + omits empty meta", () => {
    const m = wrapExtension("blueprint", "bp-1", "My BP", "1.0.0", { hello: "world" });
    expect(m).toMatchObject({ manifest: MANIFEST_VERSION, kind: "blueprint", id: "bp-1", name: "My BP", version: "1.0.0", payload: { hello: "world" } });
    expect("author" in m).toBe(false);
    expect("capabilities" in m).toBe(false);
  });

  it("carries supplied meta (author / capabilities / integrity)", () => {
    const m = wrapExtension("pipeline", "p1", "P", "2.1.0", {}, {
      author: "kev", capabilities: ["render", "read-signals"], integrity: "sha256:abc",
    });
    expect(m.author).toBe("kev");
    expect(m.capabilities).toEqual(["render", "read-signals"]);
    expect(m.integrity).toBe("sha256:abc");
  });

  it("validates a well-formed manifest and rejects malformed ones", () => {
    const good = wrapExtension("blueprint", "bp", "n", "1.0.0", {});
    expect(validateManifest(good).ok).toBe(true);
    expect(validateManifest(null).ok).toBe(false);
    expect(validateManifest({}).ok).toBe(false);
    expect(validateManifest({ manifest: 1, kind: "wat", id: "x", name: "y", version: "1", payload: {} }).ok).toBe(false);
    expect(validateManifest({ manifest: 1, kind: "blueprint", id: "", name: "y", version: "1", payload: {} }).ok).toBe(false);
    expect(validateManifest({ manifest: 1, kind: "blueprint", id: "x", name: "y", version: "1" }).ok).toBe(false); // no payload
  });

  it("refuses a manifest newer than this app supports", () => {
    const r = validateManifest({ manifest: MANIFEST_VERSION + 1, kind: "blueprint", id: "x", name: "y", version: "1", payload: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/newer/i);
  });

  it("parseManifest tolerates bad JSON", () => {
    expect(parseManifest("{not json").ok).toBe(false);
    expect(parseManifest(JSON.stringify(wrapExtension("skill", "s", "n", "1", {}))).ok).toBe(true);
  });

  it("share code round-trips losslessly (incl. unicode)", () => {
    const m = wrapExtension("blueprint", "bp-é", "Café plan ☕", "1.0.0", { note: "naïve – 3D" });
    const code = encodeShareCode(m);
    expect(code).not.toContain("="); // base64url, unpadded
    const back = decodeShareCode(code);
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.manifest).toEqual(m);
  });

  it("decodeShareCode rejects garbage", () => {
    expect(decodeShareCode("!!!not base64!!!").ok).toBe(false);
  });
});
