import { describe, it, expect, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { generateRefactorUnits } from "../lib/refactorUnits";
import { removalVerified, rescanForRemoval, findingKey } from "../lib/verifyRemoval";
import { type VerifiedFinding } from "../lib/deadcodeVerify";
import { type DeadCodeFinding } from "../lib/deadcode";

const vf = (over: Partial<VerifiedFinding>): VerifiedFinding => ({
  kind: "unused-export", path: "src/a.ts", symbol: "Foo", detail: "", tool: "ts-prune",
  confidence: "medium", verdict: "confirmed", reason: "", ...over,
});

describe("generateRefactorUnits (#626 slice d1)", () => {
  it("batches confirmed deps into one safe unit owning their manifests", () => {
    const units = generateRefactorUnits([
      vf({ kind: "unused-dep", path: "package.json", symbol: "lodash" }),
      vf({ kind: "unused-dep", path: "package.json", symbol: "moment" }),
      vf({ kind: "unused-dep", path: "src-tauri/Cargo.toml", symbol: "serde" }),
    ]);
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ id: "deps", tier: "safe" });
    expect(units[0].owns).toEqual(["package.json", "src-tauri/Cargo.toml"]);
    expect(units[0].findings).toHaveLength(3);
  });

  it("groups code findings into one risky unit per file", () => {
    const units = generateRefactorUnits([
      vf({ path: "src/a.ts", symbol: "Foo" }),
      vf({ path: "src/a.ts", symbol: "Bar" }),
      vf({ path: "src/b.ts", symbol: "Baz" }),
    ]);
    expect(units.map((u) => u.id).sort()).toEqual(["src/a.ts", "src/b.ts"]);
    const a = units.find((u) => u.id === "src/a.ts")!;
    expect(a.tier).toBe("risky");
    expect(a.owns).toEqual(["src/a.ts"]);
    expect(a.findings).toHaveLength(2);
  });

  it("only confirmed findings become units (uncertain / false-positive excluded)", () => {
    const units = generateRefactorUnits([
      vf({ kind: "unused-dep", symbol: "keep", path: "package.json", verdict: "confirmed" }),
      vf({ kind: "unused-dep", symbol: "skip1", path: "package.json", verdict: "uncertain" }),
      vf({ path: "src/x.ts", verdict: "false-positive" }),
    ]);
    expect(units).toHaveLength(1);
    expect(units[0].findings.map((f) => f.symbol)).toEqual(["keep"]);
  });

  it("returns [] when nothing is confirmed", () => {
    expect(generateRefactorUnits([vf({ verdict: "uncertain" })])).toEqual([]);
  });
});

describe("verify-removal (#626 slice d1)", () => {
  const unit = { id: "src/a.ts", title: "", owns: ["src/a.ts"], tier: "risky" as const, findings: [vf({ symbol: "Foo" }), vf({ symbol: "Bar" })], acceptance: "" };

  it("removalVerified: ok when none of the unit's findings remain", () => {
    expect(removalVerified(unit, []).ok).toBe(true);
    const post: DeadCodeFinding[] = [{ kind: "unused-export", path: "src/a.ts", symbol: "Bar", detail: "", tool: "ts-prune", confidence: "medium" }];
    const r = removalVerified(unit, post);
    expect(r.ok).toBe(false);
    expect(r.remaining.map((f) => f.symbol)).toEqual(["Bar"]);
  });

  it("findingKey is stable across scans", () => {
    expect(findingKey({ kind: "unused-export", path: "src/a.ts", symbol: "Foo" }))
      .toBe(findingKey({ kind: "unused-export", path: "src/a.ts", symbol: "Foo" }));
  });

  it("rescanForRemoval re-runs the scanner and checks (mock invoke)", async () => {
    vi.mocked(invoke).mockReset();
    // ts-prune now reports only Bar (Foo was removed) ⇒ not ok, Bar remains
    vi.mocked(invoke).mockResolvedValue({ tool: "ts-prune", ran: true, stdout: "src/a.ts:9 - Bar", stderr: "", error: null });
    const r = await rescanForRemoval({ repoPath: "/r", unit, stack: "js" });
    expect(r.ok).toBe(false);
    expect(r.remaining.map((f) => f.symbol)).toEqual(["Bar"]);
  });
});
