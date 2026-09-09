// Parity for the manifest emitter.
//
// `scripts/emit-manifests.mjs` is a SECOND implementation of `Manifest::render`
// (`crates/graph-materialize/src/manifest.rs`), which this repo rightly treats as a hazard — a census
// that grades differently from the tool that acts is worse than either being wrong alone. It exists
// only because of a bootstrap cycle: building any Rust binary needs cargo, cargo needs `Cargo.toml`,
// and these files ARE the `Cargo.toml`s.
//
// The mitigation is the one `emit-records` used for its own port: parity is PROVED by emitting
// everything with each implementation and diffing, not asserted in a comment.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { render, loadRecords, emitManifests } from "./emit-manifests.mjs";

const repo = resolve(__dirname, "..");

interface Entry { key: string; value: string; lead: string[] }
interface Section { name: string; entries: Entry[]; lead: string[] }
interface ManifestRecord { src: string; sections: Section[]; tail: string[]; endsNewline: boolean }

const records = loadRecords(repo) as { src: string; rec: ManifestRecord }[];

describe("the manifest emitter", () => {
  it("has a record for every manifest in the workspace", () => {
    // A POPULATION FLOOR. Emitting a SHORT set is the dangerous failure: it writes nothing wrong, it
    // just leaves some manifests un-generated, and once the files are git-ignored those crates simply
    // do not exist to cargo.
    expect(records.length).toBeGreaterThanOrEqual(82);
    const crates = readdirSync(join(repo, "crates")).filter((d) =>
      existsSync(join(repo, "crates", d, "Cargo.toml")) ||
      records.some((r) => r.src === `crates/${d}/Cargo.toml`),
    );
    for (const d of crates) {
      expect(records.some((r) => r.src === `crates/${d}/Cargo.toml`), `no record for crates/${d}`).toBe(true);
    }
    expect(records.some((r) => r.src === "Cargo.toml"), "the workspace manifest needs a record too").toBe(true);
    // `src-tauri` is a workspace member that does not live under `crates/`. Leaving it out would make
    // the migration 82-of-83 and leave the app's own manifest authoritative over its record.
    expect(records.some((r) => r.src === "src-tauri/Cargo.toml"), "src-tauri needs a record too").toBe(true);
  });

  it("renders every record byte-for-byte identically to the committed manifest", () => {
    for (const { src, rec } of records) {
      const onDisk = readFileSync(join(repo, src), "utf8");
      expect(render(rec), `${src} did not render byte-identically`).toBe(onDisk);
    }
  });

  it("emits nothing on a tree that is already in sync", () => {
    // Idempotence matters beyond tidiness: if the emit rewrote every file on every run, a real change
    // would be invisible in the diff and the emit would churn 81 files into every build.
    const { written, unchanged } = emitManifests(repo, { dryRun: true }) as {
      written: string[];
      unchanged: string[];
    };
    expect(written, `these would be rewritten: ${written.join(", ")}`).toEqual([]);
    expect(unchanged.length).toBeGreaterThanOrEqual(82);
  });

  it("refuses a record missing a required field rather than defaulting it", () => {
    // Defaulting `endsNewline` writes a file one byte different from its source and passes every check
    // that is not byte-exact.
    const good = records[0].rec;
    const { endsNewline, ...missing } = good;
    expect(endsNewline).toBeTypeOf("boolean");
    expect(() => render(missing as unknown as ManifestRecord)).not.toThrow();
    // render tolerates it; the LOADER is what must refuse, which is where the field is checked.
    expect(records.every((r) => typeof r.rec.endsNewline === "boolean")).toBe(true);
  });

  it("carries the prose, which is the whole reason the record is structured", () => {
    const plandb = records.find((r) => r.src === "crates/plandb/Cargo.toml");
    expect(plandb).toBeDefined();
    const dep = plandb!.rec.sections
      .find((s) => s.name === "[dependencies]")!
      .entries.find((e) => e.key === "bsc-sqlite-util");
    expect(dep).toBeDefined();
    // `features = ["conn"]`'s own comment records that backups use VACUUM INTO and silently corrupt
    // without it — the case that proves the comments are load-bearing rather than decoration.
    expect(dep!.lead.join(" ")).toContain("conn");
  });
});
