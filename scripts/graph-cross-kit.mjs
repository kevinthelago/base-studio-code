#!/usr/bin/env node
/**
 * `node scripts/graph-cross-kit.mjs` — do the language kits AGREE about a concept they both claim?
 *
 * The algorithms library is organised around the idea that a concept IS its implementation, with one
 * implementation per language kit. Nothing has ever checked that the two implementations of a shared
 * concept compute the same thing. They are separate code, written at different times, joined only by a
 * name — which is the weakest possible link, and this repo has already been bitten by exactly that
 * shape (a record and a file agreeing in name while diverging in content).
 *
 * So: one shared vector, both kits run against it, results compared to the contract AND to each other.
 * The vector lives in `src/features/algorithms/lib/crossKit.fixtures.json` — add cases there, not here.
 *
 * # What this found on the first run, and why the vector is output-level
 *
 * `quick-sort.rs` and `quick-sort.ts` are DIFFERENT ALGORITHMS: Rust partitions functionally around
 * `xs[0]` and returns a new Vec; TypeScript does an in-place Lomuto partition around the last element.
 * Their step counts and traces differ and always will. An output-level vector is therefore the right
 * instrument — it contracts what the concept MEANS, not how either kit gets there. A trace-level
 * comparison would fail forever for a pair that is behaving perfectly.
 *
 * Two shared concepts are deliberately NOT covered, and the fixture says why: the five graph algorithms
 * take incompatible inputs, and `rotate` is a false name-collision between a 3-D vector rotation and a
 * matrix rotation.
 *
 * # How each side is run
 *
 * TypeScript is transpiled with the `typescript` package (already a dependency — `tsc` is the gate's
 * typecheck) and evaluated. Rust is materialized through the SAME flat-closure convention the sweep
 * uses, wrapped in a tiny generated `main` that takes argv and prints a line, and compiled with
 * `rustc`. No serde, no Cargo, no dependency on the workspace: the glue is comma-separated integers,
 * because a serialization dependency here would be a third thing that can disagree.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { loadGateSources, materialize } from "./graph-rust-compile.mjs";

const ROOT = join(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..");
const FIXTURE = join(ROOT, "src", "features", "algorithms", "lib", "crossKit.fixtures.json");

/** The Rust `main` that exercises one node — one per input shape the fixture declares. */
export function rustHarness(kind, fnName) {
  const parseList =
    'let a: Vec<i64> = std::env::args().nth(1).unwrap_or_default().split(\',\')' +
    '.filter(|s| !s.is_empty()).map(|s| s.parse().unwrap()).collect();';
  switch (kind) {
    case "sort":
      return `fn main() { ${parseList} let r = ${fnName}(&a); println!("{}", r.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(",")); }`;
    case "search":
      // Option::None maps to -1 — the fixture DECLARES that convention rather than the runner inventing it.
      return `fn main() { ${parseList} let t: i64 = std::env::args().nth(2).unwrap().parse().unwrap(); let r = ${fnName}(&a, &t); println!("{}", r.map(|i| i as i64).unwrap_or(-1)); }`;
    case "scalar":
      return `fn main() { let n: u64 = std::env::args().nth(1).unwrap().parse().unwrap(); println!("{}", ${fnName}(n)); }`;
    default:
      throw new Error(`unknown fixture kind '${kind}'`);
  }
}

/** How a case is passed to the compiled binary, per kind. */
export function rustArgs(kind, c) {
  switch (kind) {
    case "sort":
      return [c.input.join(",")];
    case "search":
      return [c.input.join(","), String(c.target)];
    case "scalar":
      return [String(c.input)];
    default:
      throw new Error(`unknown fixture kind '${kind}'`);
  }
}

/** Parse one line of the binary's output back into the value the fixture contracts. */
export function parseRustOut(kind, line) {
  const t = line.trim();
  if (kind === "sort") return t === "" ? [] : t.split(",").map(Number);
  return Number(t);
}

/** Call an evaluated TypeScript export with the arguments its kind implies. */
export function callTs(kind, fn, c) {
  if (kind === "sort") return fn(c.input);
  if (kind === "search") return fn(c.input, c.target);
  return fn(c.input);
}

/** Deep equality over the shapes a fixture case can hold (number, or an array of them). */
export function sameResult(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);
  }
  return a === b;
}

const show = (v) => (Array.isArray(v) ? `[${v.join(",")}]` : String(v));

if (process.argv[1]?.endsWith("graph-cross-kit.mjs")) {
  const require = createRequire(import.meta.url);
  const ts = require("typescript");
  const { byId } = loadGateSources(ROOT);
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));

  const work = join(tmpdir(), "bsc-cross-kit");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  // Removed on the way out, whatever the way out is — `process.exit` below, a normal end, or a throw.
  // The gate's temp-leaks leg caught this directory surviving every run
  // (`the-test-suites-still-leak-temp-entries-per-gate`).
  process.on("exit", () => rmSync(work, { recursive: true, force: true }));

  let checked = 0;
  const failures = [];
  const skipped = [];

  for (const spec of fixture.concepts) {
    const rustRec = byId.get(spec.rust);
    const tsRec = byId.get(spec.typescript);
    // A missing record is REPORTED, never quietly passed: an agreement check that silently covers
    // nothing is worse than no check, and this store is edited constantly.
    if (!rustRec || !tsRec) {
      skipped.push(`${spec.concept}: missing ${!rustRec ? spec.rust : spec.typescript} in the committed stores`);
      continue;
    }

    // ── TypeScript: transpile the record's own code and evaluate it.
    const js = ts.transpileModule(tsRec.code, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const mod = { exports: {} };
    new Function("exports", "module", js)(mod.exports, mod);
    const tsFn = mod.exports[tsRec.name] ?? Object.values(mod.exports).find((v) => typeof v === "function");
    if (typeof tsFn !== "function") {
      failures.push({ concept: spec.concept, why: `the TypeScript record exports no callable named ${tsRec.name}` });
      continue;
    }

    // ── Rust: the same flat-closure materialization the sweep uses, plus a generated main.
    const crateName = spec.rust.replace(/\.rs$/, "").replace(/[^\w]/g, "_");
    const src = join(work, `${crateName}.rs`);
    writeFileSync(src, `${materialize(spec.rust, byId)}\n${rustHarness(spec.kind, rustRec.name)}\n`, "utf8");
    try {
      execFileSync("rustc", ["--edition", "2021", "--out-dir", work, src], { stdio: ["ignore", "ignore", "pipe"] });
    } catch (err) {
      const stderr = String(err.stderr ?? "");
      failures.push({
        concept: spec.concept,
        why: `the Rust node did not compile with its harness: ${stderr.split("\n").find((l) => l.startsWith("error")) ?? "unknown"}`,
      });
      continue;
    }
    const bin = join(work, `${crateName}${process.platform === "win32" ? ".exe" : ""}`);

    for (const c of spec.cases) {
      checked++;
      const tsGot = callTs(spec.kind, tsFn, c);
      const rsGot = parseRustOut(spec.kind, execFileSync(bin, rustArgs(spec.kind, c), { encoding: "utf8" }));
      const input = spec.kind === "search" ? `${show(c.input)} target=${c.target}` : show(c.input);
      // BOTH must match the contract, and they must match each other. Checking only "ts === rs" would
      // pass two kits that agree on the same wrong answer.
      if (!sameResult(tsGot, c.expected)) {
        failures.push({ concept: spec.concept, why: `typescript ${input} -> ${show(tsGot)}, contract says ${show(c.expected)}` });
      }
      if (!sameResult(rsGot, c.expected)) {
        failures.push({ concept: spec.concept, why: `rust ${input} -> ${show(rsGot)}, contract says ${show(c.expected)}` });
      }
      if (!sameResult(tsGot, rsGot)) {
        failures.push({ concept: spec.concept, why: `the kits DISAGREE on ${input}: ts ${show(tsGot)} vs rust ${show(rsGot)}` });
      }
    }
  }

  process.stdout.write(
    `\ncross-kit: ${fixture.concepts.length} concept(s), ${checked} case(s) run against BOTH kits — ${failures.length} failure(s)\n`,
  );
  for (const s of skipped) process.stdout.write(`  SKIPPED ${s}\n`);
  for (const f of failures) process.stdout.write(`  ✗ ${f.concept}: ${f.why}\n`);
  // A skipped concept is not a pass. If the store lost a record the fixture names, that is a real
  // regression in coverage and the gate should say so.
  process.exit(failures.length || skipped.length ? 1 : 0);
}
