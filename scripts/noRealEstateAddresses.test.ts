/**
 * This repo is PUBLIC, and this machine's real network must not be in it.
 *
 * The addresses of the live estate — the MGMT roster, the sensor, the NAS — were scrubbed out of
 * 11 tracked files and 31 records by `the-real-network-estate-belongs-in-the-hub-not-the-repo`.
 * The captured traffic and the roster itself now live in the hub
 * (`~/.base-studio-code/projects/lan/`), and the two attestation tests resolve them from there.
 *
 * This guard is what stops them coming back. It is deliberately a SHAPE, not a list of the six
 * addresses: naming them here would put them back in the repo.
 *
 * WHAT IT CANNOT SEE, stated so nobody reads a pass as more than it is:
 *   1. `record_history` keeps superseded revisions as gzipped REVERSE deltas, so scrubbing a
 *      record CREATES a history row holding the old value. 39 such deltas on `main` still
 *      recover the roster, and no verb drops them — `bsc request` 415.
 *   2. Git history. Every earlier commit of a scrubbed file, and of `graph/*.db`, still has the
 *      addresses in full. Only a history rewrite removes that.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadStore, resolveComponentStorePath, resolveStorePath } from "@scripts/lib/recordStore.mjs";

/** `192.168.<2-8>.<host>` — the live estate's /24s. A bare prefix with no host octet is NOT
 *  matched on purpose: `--segment 10.99.2.` in help text is the example users actually need. */
const ESTATE = /192\.168\.[2-8]\.\d+/;

/** Binary and generated paths a text scan cannot read meaningfully. */
const SKIP = /\.(db|png|jpg|jpeg|gif|ico|woff2?|ttf|otf|pdf|zip|gz|zst|wasm|mp[34]|wav)$/i;

/** A tiny non-cryptographic digest, FNV-1a. Its ONLY job is to let this file name a known
 *  offender WITHOUT writing a live address into the repo the guard exists to keep clean. It is
 *  not a security property and does not need to be. */
function digest(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function tracked(): string[] {
  return execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter(Boolean);
}

describe("the real network estate is not in this repo", () => {
  it("no tracked text file carries a live estate address", () => {
    const files = tracked().filter((f) => !SKIP.test(f));
    // POPULATION FIRST: a scan that examined nothing looks exactly like a clean one.
    expect(files.length).toBeGreaterThan(1000);

    const offenders: string[] = [];
    for (const f of files) {
      if (!existsSync(f)) continue; // a path staged for deletion
      let text: string;
      try {
        text = readFileSync(f, "utf8");
      } catch {
        continue;
      }
      if (text.includes("\u0000")) continue; // actually binary despite its name
      const m = text.match(ESTATE);
      if (m) offenders.push(`${f}: ${m[0]}`);
    }
    expect(offenders, `a live estate address is back in the repo:\n${offenders.join("\n")}`).toEqual([]);
  });

  for (const [label, resolve] of [
    ["algorithms", resolveStorePath],
    ["components", resolveComponentStorePath],
  ] as const) {
    it(`no ${label} record carries a live estate address`, () => {
      const storePath = resolve(".");
      if (!storePath || !existsSync(storePath)) return;
      // `loadStore` is the supported reader and resolves the checkout's LANE CHAIN, so this sees
      // exactly the bodies the build compiles. It is also why this does not open `node:sqlite`
      // directly — vite cannot bundle that builtin from a test.
      const store = loadStore(storePath) as {
        implementations?: unknown[];
        edges?: unknown[];
      };
      const records = [...(store.implementations ?? []), ...(store.edges ?? [])];
      // POPULATION FIRST: 2 of 3212 records once read green (#181).
      expect(records.length).toBeGreaterThan(50);

      const offenders: string[] = [];
      for (const rec of records) {
        const json = JSON.stringify(rec);
        const m = json.match(ESTATE);
        if (!m) continue;
        const id = String((rec as { id?: unknown; path?: unknown })?.id ?? (rec as { path?: unknown })?.path);
        offenders.push(`${id}: ${digest(m[0])} x${json.match(new RegExp(ESTATE, "g"))?.length ?? 0}`);
      }
      // ONE known exception, stated exactly rather than as a name: the generated react-ui kit is a
      // SEED record in the committed store, and NOTHING can update it — `store export` refuses a
      // populated store, `components set` has no `--repo`, `refresh-seed` reads the live store.
      // `bsc request` 416. The gitignored FILE the record mirrors is clean — it is regenerated from
      // the records, which are clean. Only this committed copy lags, and nothing can write it.
      //
      // That gap is UNSATISFIABLE, not an oversight: `reactUiKit` requires file == records and
      // `bsc-util`'s `seed_for_seed` requires file == store, so one of the two is red until 416
      // lands. Chosen deliberately: keep `reactUiKit` green so the red lands in the nextest leg,
      // where the by-name audit still sees it, instead of hiding inside the already-known-red
      // vitest leg (`a-known-red-can-absorb-new-instances-invisibly`).
      //
      // Pinned to the exact string so it cannot absorb a NEW instance: a second address in that
      // record, or any other record, still fails (`a-known-red-can-absorb-new-instances-invisibly`).
      // Pinned by DIGEST, not by the address. Writing the literal here made this file itself the
      // thing the tracked-file scan found — a guard that published exactly what it exists to remove
      // (`a-source-asserting-test-is-part-of-the-source-it-asserts`). A different address, or a
      // second one in the same record, changes the digest and still fails.
      const KNOWN = label === "components" ? ["components/react-ui.json: a180ae86 x1"] : [];
      expect(
        offenders,
        `a live estate address is back in the ${label} store:\n${offenders.join("\n")}`,
      ).toEqual(KNOWN);
    });
  }
});
