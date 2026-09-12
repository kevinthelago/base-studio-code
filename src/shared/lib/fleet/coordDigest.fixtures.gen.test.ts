// The comparison DIGEST, captured from the live TypeScript so Rust can be proved to match it.
//
// `coordLog.fixtures.json` already proves the two FOLDS agree, field for field, over 26 replayed logs.
// This pins the projection those folds are COMPARED on — `coordStateDigest` here against
// `logs::coord::fold_digest` there. Without it the two folds could agree perfectly while their digests
// disagreed, and the divergence surface would report a permanent disagreement that is really a
// difference between two summarizers.
//
// It reads the existing fixture rather than declaring a second corpus, so the two can never drift onto
// different inputs: every log case there gets a digest here, by name.
//
// Regenerate deliberately:
//
//     UPDATE_FIXTURES=1 npx vitest run src/shared/lib/fleet/coordDigest.fixtures.gen.test.ts
//
// A regeneration that changes the file is a CHANGE OF BEHAVIOUR. Read the diff before committing it.
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { coordStateDigest } from "@/shared/lib/fleet/useCoordLog";

const SOURCE = join(process.cwd(), "src/shared/lib/fleet/coordLog.fixtures.json");
const FIXTURE = join(process.cwd(), "src/shared/lib/fleet/coordDigest.fixtures.json");

interface LogCase {
  name: string;
  lines: string[];
  result: Parameters<typeof coordStateDigest>[0];
}

function build() {
  const source = JSON.parse(readFileSync(SOURCE, "utf8")) as { logs: LogCase[] };
  return {
    note: "GENERATED from the live TypeScript — see coordDigest.fixtures.gen.test.ts",
    digests: source.logs.map((c) => ({ name: c.name, digest: coordStateDigest(c.result) })),
  };
}

describe("the coordination digest is captured for Rust to match", () => {
  it("matches the committed fixture (UPDATE_FIXTURES=1 to regenerate)", () => {
    const text = JSON.stringify(build(), null, 2) + "\n";
    if (process.env.UPDATE_FIXTURES === "1") writeFileSync(FIXTURE, text);
    expect(existsSync(FIXTURE), `${FIXTURE} is missing — run with UPDATE_FIXTURES=1`).toBe(true);
    expect(readFileSync(FIXTURE, "utf8")).toBe(text);
  });

  it("covers every log case the fold fixture replays, by name", () => {
    const source = JSON.parse(readFileSync(SOURCE, "utf8")) as { logs: LogCase[] };
    const built = build();
    expect(built.digests.map((d) => d.name)).toEqual(source.logs.map((c) => c.name));
    expect(built.digests.length).toBeGreaterThanOrEqual(20);
  });

  it("is not vacuous — the corpus produces real tokens across many kinds", () => {
    const all = build().digests.flatMap((d) => d.digest);
    expect(all.length).toBeGreaterThan(20);
    const kinds = new Set(all.map((t) => t.slice(0, t.indexOf(":"))));
    // A digest that only ever emitted one kind would agree with almost anything.
    expect(kinds.size).toBeGreaterThanOrEqual(5);
  });
});
