#!/usr/bin/env node
// scripts/release.mjs — cut a release in one go (see CLAUDE.md § "Cutting a release").
//
// Bumps the app version in BOTH package.json and src-tauri/tauri.conf.json, stamps the CHANGELOG
// [Unreleased] section as the new version, commits, tags `vX.Y.Z`, and pushes --follow-tags so the
// tag-triggered release.yml builds the installers + cuts the GitHub Release.
//
// Usage:
//   npm run release                 # patch bump — the 1.0.4n cadence (1.0.41 -> 1.0.42)
//   npm run release -- 1.0.5        # an explicit version (a themed step, or 2.0.0)
//   npm run release -- minor        # semver minor bump (major | minor | patch) — used from v2 on
//   npm run release -- 1.0.42 --no-push   # do everything except push (review before it builds)
//
// Run from an up-to-date `develop` with a clean working tree. Cargo.toml keeps its crate version.

import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"); // win path fix
const PKG = `${ROOT}package.json`;
const TAURI = `${ROOT}src-tauri/tauri.conf.json`;
const CHANGELOG = `${ROOT}CHANGELOG.md`;

const args = process.argv.slice(2);
const noPush = args.includes("--no-push");
const spec = args.find((a) => !a.startsWith("--")); // version | bump keyword | undefined

const die = (m) => { console.error(`release: ${m}`); process.exit(1); };
const sh = (cmd) => execSync(cmd, { cwd: ROOT, stdio: "pipe" }).toString().trim();

// ── guards ──────────────────────────────────────────────────────────────────
if (sh("git status --porcelain")) die("working tree is dirty — commit or stash first.");
const branch = sh("git rev-parse --abbrev-ref HEAD");
if (branch !== "develop") console.warn(`release: on '${branch}', not 'develop' — continuing anyway.`);

// ── compute the next version ─────────────────────────────────────────────────
const cur = JSON.parse(readFileSync(PKG, "utf8")).version;
function bump(v, idx) { const p = v.split(".").map(Number); p[idx]++; for (let i = idx + 1; i < 3; i++) p[i] = 0; return p.join("."); }
let next;
if (!spec || spec === "patch") next = bump(cur, 2);
else if (spec === "minor") next = bump(cur, 1);
else if (spec === "major") next = bump(cur, 0);
else if (/^\d+\.\d+\.\d+([-+].+)?$/.test(spec)) next = spec;
else die(`bad version/bump arg: '${spec}' (use x.y.z | major | minor | patch)`);
if (next === cur) die(`next version equals current (${cur}).`);

console.log(`release: ${cur} → ${next}`);

// ── bump both version files (regex-replace to preserve formatting) ───────────
function setVersion(file) {
  const src = readFileSync(file, "utf8");
  const out = src.replace(/("version"\s*:\s*")[^"]+(")/, `$1${next}$2`);
  if (out === src) die(`could not find a version field in ${file}`);
  writeFileSync(file, out);
}
setVersion(PKG);
setVersion(TAURI);

// ── stamp the CHANGELOG: keep an empty [Unreleased], add the dated version ────
const date = new Date().toISOString().slice(0, 10);
const cl = readFileSync(CHANGELOG, "utf8");
if (!/^## \[Unreleased\]/m.test(cl)) die("CHANGELOG.md has no '## [Unreleased]' section to stamp.");
writeFileSync(CHANGELOG, cl.replace(/^## \[Unreleased\]/m, `## [Unreleased]\n\n## [${next}] — ${date}`));

// ── commit · tag · push ──────────────────────────────────────────────────────
sh(`git add package.json src-tauri/tauri.conf.json CHANGELOG.md`);
sh(`git commit -m "chore(release): v${next}"`);
sh(`git tag v${next}`);
console.log(`release: committed + tagged v${next}`);

if (noPush) {
  console.log(`release: --no-push set. To ship: git push --follow-tags`);
} else {
  sh(`git push --follow-tags`);
  console.log(`release: pushed v${next} — release.yml will build the installers + cut the GitHub Release.`);
}
