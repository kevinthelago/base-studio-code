import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  parseDepcheck, parseTsPrune, parseCargoMachete, scanDeadCode, DEAD_CODE_SCANNERS,
} from "../lib/deadcode";

describe("deadcode parsers (#626)", () => {
  it("parseDepcheck pulls unused deps + devDeps from JSON", () => {
    const out = parseDepcheck(JSON.stringify({ dependencies: ["lodash", "moment"], devDependencies: ["typescript"], missing: { x: [] } }));
    expect(out.map((f) => f.symbol)).toEqual(["lodash", "moment", "typescript"]);
    expect(out[0]).toMatchObject({ kind: "unused-dep", path: "package.json", tool: "depcheck" });
  });
  it("parseDepcheck tolerates garbage", () => {
    expect(parseDepcheck("not json")).toEqual([]);
    expect(parseDepcheck(JSON.stringify({}))).toEqual([]);
  });

  it("parseTsPrune reads `path:line - name`, skipping used-in-module", () => {
    const stdout = [
      "src/a.ts:12 - foo",
      "src/b.ts:3 - bar (used in module)",
      "src/c.ts:99 - Baz",
      "garbage line",
    ].join("\n");
    const out = parseTsPrune(stdout);
    expect(out.map((f) => f.symbol)).toEqual(["foo", "Baz"]);
    expect(out[0]).toMatchObject({ kind: "unused-export", path: "src/a.ts", tool: "ts-prune" });
    expect(out[1].detail).toMatch(/line 99/);
  });

  it("parseCargoMachete reads indented crates under a manifest", () => {
    const stdout = [
      "cargo-machete found the following unused dependencies in /repo:",
      "my-crate -- /repo/Cargo.toml:",
      "\tserde",
      "\tonce_cell",
      "",
      "If you believe these are false positives...",
    ].join("\n");
    const out = parseCargoMachete(stdout);
    expect(out.map((f) => f.symbol)).toEqual(["serde", "once_cell"]);
    expect(out[0]).toMatchObject({ kind: "unused-dep", path: "/repo/Cargo.toml", tool: "cargo-machete" });
  });

  it("registry covers js + rust scanners", () => {
    expect(DEAD_CODE_SCANNERS.some((s) => s.stack === "js")).toBe(true);
    expect(DEAD_CODE_SCANNERS.some((s) => s.stack === "rust")).toBe(true);
  });
});

describe("scanDeadCode dispatch (#626)", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("runs + parses when the tool ran", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ tool: "depcheck", ran: true, stdout: JSON.stringify({ dependencies: ["lodash"] }), stderr: "", error: null });
    const out = await scanDeadCode({ repoPath: "/r", tool: "depcheck" });
    expect(out.ran).toBe(true);
    expect(out.findings.map((f) => f.symbol)).toEqual(["lodash"]);
  });

  it("surfaces a not-ran result as an error, no findings", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ tool: "depcheck", ran: false, stdout: "", stderr: "", error: "couldn't run npx: not found" });
    const out = await scanDeadCode({ repoPath: "/r", tool: "depcheck" });
    expect(out).toMatchObject({ ran: false, findings: [] });
    expect(out.error).toMatch(/not found/);
  });

  it("a thrown invoke is caught", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("boom"));
    const out = await scanDeadCode({ repoPath: "/r", tool: "depcheck" });
    expect(out.ran).toBe(false);
  });
});
