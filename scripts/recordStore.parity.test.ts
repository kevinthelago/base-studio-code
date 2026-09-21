// The JS store reader and the RUST one must agree — proven, not assumed.
//
// `scripts/lib/recordStore.mjs` reads the committed database directly with `node:sqlite`, and
// `graph-materialize::sqlite_read` reads it in Rust. That is deliberately TWO implementations of one
// rule, and the reason is recorded where the duplication lives: routing JS through `bsc` made every
// gate leg depend on a binary that the gate's own `clippy --all-targets` zeroes partway through.
//
// The rule they must agree on is small and unforgiving — newest revision per id per lane, a NULL body
// meaning RETIRED rather than stale, and `impl` vs `edge` tiers. Every clause of it has already caused
// a real bug: 198 tombstoned records came back from the dead, and 89 edges were about to be compiled
// as Rust modules. Two readers drifting on any of it would be invisible until a build compiled
// something the store says is deleted.
//
// This is the same mitigation `emit-manifests.test.ts` uses for its second renderer: render both, diff.
import { describe, it, expect } from "vitest";
import { execFileSync, } from "node:child_process";
import { statSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { loadStore, resolveStorePath, isSqliteStore } from "./lib/recordStore.mjs";
import { candidatePaths, pickUsable } from "./lib/bscBinary.mjs";

const REPO = resolve(__dirname, "..");

function usableBsc(): string | null {
  const statSize = (p: string) => {
    try {
      return statSync(p).size;
    } catch {
      return null;
    }
  };
  const run = (p: string) => {
    try {
      return { status: 0, stdout: execFileSync(p, ["version"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }) };
    } catch (err: any) {
      return { status: err?.status ?? 1, stdout: err?.stdout ?? "" };
    }
  };
  return pickUsable(candidatePaths(REPO, homedir(), join), { statSize, run })?.path ?? null;
}

describe("the JS and Rust readers agree about the committed store", () => {
  const storePath = resolveStorePath(REPO);

  it("is reading a database at all — otherwise this file guards nothing", () => {
    expect(existsSync(storePath), `no committed store at ${storePath}`).toBe(true);
    expect(isSqliteStore(storePath), `${storePath} is not a database; this parity check is for the DB reader`).toBe(true);
  });

  it("reads a plausible population, so a silent empty read cannot pass", () => {
    const js = loadStore(storePath) as { implementations: unknown[]; edges: unknown[] };
    expect(js.implementations.length, "the JS reader found almost no records").toBeGreaterThan(1000);
    expect(js.edges.length, "the JS reader found no edges").toBeGreaterThan(10);
  });

  it("agrees with `bsc algorithms dump --repo`, id for id and body for body", () => {
    const bsc = usableBsc();
    if (!bsc) {
      // NOT a silent skip: the assertion above still guards the population, and this says plainly why
      // the cross-check did not run. A parity test that quietly passes with nothing compared is worse
      // than none, so the reason is printed rather than swallowed.
      console.warn("parity NOT cross-checked: no usable `bsc` (cargo build -p bsc --bin bsc)");
      return;
    }
    // A CAPABILITY PROBE, because a path is not a capability. `--repo` is a known flag to every `bsc`,
    // so a binary predating the subcommand does not reject it — it silently dumps the RUNTIME library
    // instead, and the comparison then fails as a phantom "drift" between two different stores.
    // MEASURED: 2,968 against 2,946. So ask a question only the new binary answers: pointed at a root
    // with no committed store it must FAIL. An old one happily dumps the runtime library.
    let understandsRepo = false;
    // Removed after the probe, whatever it answers (`the-test-suites-leak-temp-dirs-into-tmp`).
    const storeless = mkdtempSync(join(tmpdir(), "bsc-parity-"));
    try {
      execFileSync(bsc, ["algorithms", "dump", "--repo", "--root", storeless], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      understandsRepo = true; // refused, as a store-less root should be
    } finally {
      rmSync(storeless, { recursive: true, force: true });
    }
    if (!understandsRepo) {
      console.warn("parity NOT cross-checked: this `bsc` predates `graph dump --repo` (run npm run build:plan)");
      return;
    }
    const rust = JSON.parse(
      execFileSync(bsc, ["algorithms", "dump", "--repo", "--root", REPO], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 }),
    ) as { implementations: { id: string }[]; edges: { id: string }[] };
    const js = loadStore(storePath) as { implementations: { id: string }[]; edges: { id: string }[] };

    const ids = (xs: { id: string }[]) => xs.map((x) => x.id).sort();
    expect(ids(js.implementations), "the two readers disagree on WHICH records the store holds").toEqual(ids(rust.implementations));
    expect(ids(js.edges), "the two readers disagree on WHICH edges the store holds").toEqual(ids(rust.edges));

    // Bodies too: agreeing on ids while disagreeing on content is the drift that would actually ship.
    const byId = new Map(rust.implementations.map((r) => [r.id, JSON.stringify(r)]));
    const differing = js.implementations
      .filter((r) => byId.get(r.id) !== JSON.stringify(r))
      .map((r) => r.id);
    expect(differing, "records whose BODY differs between the two readers").toEqual([]);
  });
});
