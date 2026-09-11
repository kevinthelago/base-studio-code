// `the-test-suites-leak-temp-dirs-into-tmp`: the gate runs its legs in a per-run temp directory off the
// tmpfs, reports what they leave, and removes it — pass or fail.
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { leakReport, sweepStaleGateTmp, tempEnv, withGateTmp, GATE_TMP_BASE } from "./lib/gateTmp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const made: string[] = [];
const base = () => {
  const d = mkdtempSync(join(tmpdir(), "gatetmp-test-"));
  made.push(d);
  return d;
};
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the gate's temp directory", () => {
  it("is not on the /tmp tmpfs", () => {
    if (process.platform !== "win32") expect(GATE_TMP_BASE.startsWith("/tmp")).toBe(false);
  });

  it("points every temp variable at the run directory while the legs run, and restores them after", async () => {
    const b = base();
    const before = process.env.TMPDIR;
    let seen: Record<string, string | undefined> = {};
    await withGateTmp(async (dir: string) => {
      seen = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP, dir };
    }, { base: b, id: "run-a" });
    expect(seen.TMPDIR).toBe(join(b, "run-a"));
    expect(seen.TMP).toBe(seen.TMPDIR);
    expect(seen.TEMP).toBe(seen.TMPDIR);
    expect(process.env.TMPDIR).toBe(before);
    expect(tempEnv("/x")).toEqual({ TMPDIR: "/x", TMP: "/x", TEMP: "/x" });
  });

  it("reports what the legs left, grouped, then removes the directory", async () => {
    const b = base();
    const reports: { name: string; count: number }[][] = [];
    await withGateTmp(async (dir: string) => {
      for (const n of ["gm-4242-bsc-fin-19", "gm-4242-bsc-fin-20", "promote-check-cli-aB3dE9", "bsc-filelock-test-7-ThreadId(2)"]) {
        mkdirSync(join(dir, n));
      }
    }, { base: b, id: "run-b", report: (l) => reports.push(l) });
    expect(reports).toEqual([[
      { name: "gm-N-bsc-fin-N", count: 2 },
      { name: "bsc-filelock-test-N-ThreadId(N)", count: 1 },
      { name: "promote-check-cli-RAND", count: 1 },
    ]]);
    expect(existsSync(join(b, "run-b"))).toBe(false);
  });

  it("removes the directory when a leg throws, and restores the environment", async () => {
    const b = base();
    const before = process.env.TMPDIR;
    await expect(withGateTmp(async (dir: string) => {
      writeFileSync(join(dir, "left"), "x");
      throw new Error("leg crashed");
    }, { base: b, id: "run-c" })).rejects.toThrow("leg crashed");
    expect(existsSync(join(b, "run-c"))).toBe(false);
    expect(process.env.TMPDIR).toBe(before);
  });

  it("sweeps a run directory a killed gate left, and only a stale one", () => {
    const b = base();
    mkdirSync(join(b, "old"));
    mkdirSync(join(b, "fresh"));
    const past = (Date.now() - 7 * 60 * 60 * 1000) / 1000;
    utimesSync(join(b, "old"), past, past);
    expect(sweepStaleGateTmp(b)).toBe(1);
    expect(existsSync(join(b, "old"))).toBe(false);
    expect(existsSync(join(b, "fresh"))).toBe(true);
    expect(leakReport(join(b, "missing"))).toEqual([]);
  });

  it("gate.mjs runs its legs inside withGateTmp — the wiring, not just the helper", () => {
    const gate = readFileSync(join(HERE, "gate.mjs"), "utf8");
    expect(gate).toMatch(/import \{[^}]*withGateTmp[^}]*\} from "\.\/lib\/gateTmp\.mjs"/);
    const wrap = gate.indexOf("await withGateTmp(");
    const legs = gate.indexOf("gateCommands(plan, base)");
    expect(wrap, "gate.mjs does not wrap its legs").toBeGreaterThan(-1);
    expect(legs).toBeGreaterThan(wrap);
  });
});
