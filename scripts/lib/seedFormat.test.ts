// Request #169: `serializeSeed` used to reformat with a 1-space indent + escaped non-ASCII (documented
// as "Python's json.dumps(indent=1, ensure_ascii=True)"), which was never what the packaged seed
// actually held on disk — reconstructing the real 6.6 MB seed that way differed by 72,941 bytes. These
// pin the real on-disk shape: 2-space indent, literal non-ASCII, one trailing newline.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { serializeSeed } from "./seedFormat.mjs";

describe("serializeSeed", () => {
  it("round-trips a value through 2-space indent plus exactly one trailing newline", () => {
    const value = { b: 1, a: [1, 2, 3] };
    expect(serializeSeed(value)).toBe(JSON.stringify(value, null, 2) + "\n");
  });

  it("does not escape non-ASCII characters", () => {
    const value = { note: "em dash — and an accent é" };
    const out = serializeSeed(value);
    expect(out).toContain("—");
    expect(out).toContain("é");
    expect(out).not.toMatch(/\\u/);
  });

  it("is byte-identical to the real packaged seed on a round trip", () => {
    const path = "src-tauri/data/knowledge/algorithms.json";
    const original = readFileSync(path, "utf8");
    const reserialized = serializeSeed(JSON.parse(original));
    expect(reserialized).toBe(original);
  });
});
