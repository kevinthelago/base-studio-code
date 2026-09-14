// THE JS STORE READER READS THE CHECKOUT'S LANE (`the-committed-record-stores-write-into-lanes`).
//
// `scripts/lib/recordStore.mjs` is how every gate leg, script and vitest reads the committed record store.
// Before lanes reached the committed stores it read lane `main` only — which on a feature branch would
// quietly hand the gate yesterday's bodies while the build (graph-materialize, which already stacks the
// branch lane over main) compiled today's. The gate would test different code from the code it gated.
//
// Two halves: the branch→lane RULE, checked against `laneCases.json` (the same table the Rust build and
// `bsc_util::Lane` read, so the three cannot drift), and the OVERLAY, checked against a real store.
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { loadStore, laneFromBranch, laneChain, resolveLane, branchOf } from "./lib/recordStore.mjs";

const CASES = JSON.parse(readFileSync(resolve(__dirname, "lib", "laneCases.json"), "utf8")) as {
  branchToLane: { branch: string | null; lane: string }[];
  chains: { lane: string; chain: string[] }[];
  env: { env: Record<string, string>; branch: string; lane: string }[];
};

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

/** A checkout at a fresh temp dir whose `HEAD` is on `branch`. */
function checkout(branch: string | null): string {
  const root = mkdtempSync(join(tmpdir(), "bsc-lanes-"));
  made.push(root);
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), branch === null ? "0123456789abcdef0123456789abcdef01234567\n" : `ref: refs/heads/${branch}\n`);
  mkdirSync(join(root, "graph"), { recursive: true });
  return root;
}

/** A committed store at `<root>/graph/algorithms.db` holding `rows` (id, lane, rev, json-or-null, tier). */
function store(root: string, rows: [string, string, number, string | null, string][]): string {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const path = join(root, "graph", "algorithms.db");
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE record_revs (id TEXT NOT NULL, lane TEXT NOT NULL DEFAULT 'main', rev INTEGER NOT NULL, " +
      "base_rev INTEGER, json TEXT, tier TEXT NOT NULL DEFAULT 'impl', at INTEGER NOT NULL DEFAULT 0, " +
      "by TEXT NOT NULL DEFAULT '', note TEXT, PRIMARY KEY (id, lane, rev))",
  );
  const put = db.prepare("INSERT INTO record_revs (id, lane, rev, json, tier) VALUES (?, ?, ?, ?, ?)");
  for (const [id, lane, rev, json, tier] of rows) put.run(id, lane, rev, json, tier);
  db.close();
  return path;
}

const body = (id: string, where: string) => JSON.stringify({ id, where });

describe("the branch→lane rule is the table the Rust readers use", () => {
  it("reads a non-trivial table — an empty one would pass every assertion below", () => {
    expect(CASES.branchToLane.length).toBeGreaterThan(5);
    expect(CASES.env.length).toBeGreaterThan(2);
  });

  it("maps every branch to the lane the table says", () => {
    for (const { branch, lane } of CASES.branchToLane) expect(laneFromBranch(branch), `branch ${branch}`).toBe(lane);
  });

  it("walks every lane's chain landed line first", () => {
    for (const { lane, chain } of CASES.chains) expect(laneChain(lane), `lane ${lane}`).toEqual(chain);
  });

  it("lets an explicit lane win, then the legacy name, then the branch — and ignores an unusable one", () => {
    for (const { env, branch, lane } of CASES.env) expect(resolveLane(checkout(branch), env), JSON.stringify(env)).toBe(lane);
  });

  it("reads a LINKED worktree's own HEAD through its .git file", () => {
    const repo = checkout("develop");
    const admin = join(repo, ".git", "worktrees", "wt");
    mkdirSync(admin, { recursive: true });
    writeFileSync(join(admin, "HEAD"), "ref: refs/heads/radio/ui-lan\n");
    const wt = mkdtempSync(join(tmpdir(), "bsc-lanes-wt-"));
    made.push(wt);
    mkdirSync(join(wt, "graph"), { recursive: true });
    writeFileSync(join(wt, ".git"), `gitdir: ${admin}\n`);
    expect(branchOf(join(wt, "graph"))).toBe("radio/ui-lan");
    expect(resolveLane(join(wt, "graph"), {})).toBe("radio/ui-lan");
    expect(resolveLane(repo, {})).toBe("main");
  });
});

describe("loadStore reads the checkout's lane over its ancestors", () => {
  const rows: [string, string, number, string | null, string][] = [
    ["x.rs", "main", 1, body("x.rs", "main"), "impl"],
    ["z.rs", "main", 1, body("z.rs", "main"), "impl"],
    ["dead.rs", "main", 1, body("dead.rs", "main"), "impl"],
    ["dead.rs", "main", 2, null, "impl"],
    ["e1", "main", 1, JSON.stringify({ id: "e1", members: ["x.rs", "z.rs"] }), "edge"],
    ["x.rs", "voice", 1, body("x.rs", "voice"), "impl"],
    ["y.rs", "voice/x", 1, body("y.rs", "voice/x"), "impl"],
    ["z.rs", "voice/x", 1, null, "impl"],
  ];
  const ids = (s: { implementations: { id: string }[] }) => s.implementations.map((r) => r.id);

  it("a worker branch sees its own rows over its project's over main's, and its tombstones hold", () => {
    const root = checkout("voice/x");
    const s = loadStore(store(root, rows)) as { implementations: { id: string; where: string }[]; edges: { id: string }[] };
    expect(ids(s)).toEqual(["x.rs", "y.rs"]);
    expect(s.implementations.find((r) => r.id === "x.rs")?.where, "the project lane's body wins over main's").toBe("voice");
    expect(s.edges.map((e) => e.id), "an untouched edge still reads through").toEqual(["e1"]);
  });

  it("the project's own branch reads its project lane, not its workers'", () => {
    const s = loadStore(store(checkout("voice/develop"), rows)) as { implementations: { id: string; where: string }[] };
    expect(ids(s)).toEqual(["x.rs", "z.rs"]);
    expect(s.implementations.find((r) => r.id === "x.rs")?.where).toBe("voice");
  });

  it("develop reads main, exactly as before lanes reached the store", () => {
    const s = loadStore(store(checkout("develop"), rows)) as { implementations: { id: string; where: string }[] };
    expect(ids(s)).toEqual(["x.rs", "z.rs"]);
    expect(s.implementations.every((r) => r.where === "main")).toBe(true);
  });

  it("an explicit lane overrides the branch", () => {
    const s = loadStore(store(checkout("develop"), rows), { lane: "voice/x" }) as { implementations: { id: string }[] };
    expect(ids(s)).toEqual(["x.rs", "y.rs"]);
  });
});
