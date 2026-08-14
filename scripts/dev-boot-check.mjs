// Boot the dev server and DRIVE it — the check the gate structurally cannot make for itself.
//
// WHY THIS IS NOT REDUNDANT WITH THE GATE. `.bsc-records/` is generated in the Vite plugin's `buildStart`,
// so `typecheck`, `test` and `build` each regenerate it as their first step. Every one of them therefore
// runs against a tree it just repaired, and none can observe the state a developer actually hits. That is
// not hypothetical: generation used to live in the npm scripts, `npm run dev` was not one of them, and the
// dev server booted with a retired module unresolvable — `Failed to fetch dynamically imported module:
// /src/app/runtime/appModules.ts` — which killed the whole boot chain while the gate stayed green.
//
// So this deletes the generated tree first, boots on its own port, and drives the result in a real browser.
// A file retirement is not verified until this passes: the module resolution it exercises is the exact
// thing retiring a file changes.
//
// Tauri IPC errors are EXPECTED and ignored. A plain browser has no `window.__TAURI_INTERNALS__`, so every
// `invoke` throws `Cannot read properties of undefined (reading 'transformCallback')`. Failing on those
// would make the check permanently red and therefore worthless; what it asserts instead is that the app
// MOUNTED — real DOM under `#root` — and that nothing failed to RESOLVE.
//
//   node scripts/dev-boot-check.mjs [--port 1428] [--keep-records]
//
// Needs Playwright's chromium (`npx playwright install chromium`), like `e2e/`, and is opt-in for the same
// reason: a checkout that has not installed a browser must not fail the default gate.
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const portArg = process.argv.indexOf("--port");
const PORT = portArg > -1 ? Number(process.argv[portArg + 1]) : 1428;
const URL_ = `http://127.0.0.1:${PORT}/`;

/** The failures that mean a module could not be found — the class retiring a file can introduce. A
 *  substring match on purpose: Vite words these several ways and a missed variant reads as a pass. */
const RESOLUTION_FAILURE = [
  "Failed to fetch dynamically imported module",
  "Failed to resolve import",
  "Failed to load url",
  "does not provide an export named",
  "Cannot find module",
];

if (!process.argv.includes("--keep-records")) {
  // The point of the check: the boot has to build its own preconditions, exactly as a developer's does.
  rmSync(join(REPO, ".bsc-records"), { recursive: true, force: true });
  console.log("dev-boot-check: wiped .bsc-records — the boot must regenerate it");
}

const server = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], {
  cwd: REPO, shell: true, stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => { serverLog += d; });
server.stderr.on("data", (d) => { serverLog += d; });

const stop = () => { try { server.kill(); } catch { /* already gone */ } };
process.on("exit", stop);

/** Wait for the port to answer rather than sleeping a guessed interval — a fixed sleep is either slow or
 *  flaky, and on a cold dep-optimize it is both. */
async function waitForServer(timeoutMs = 90_000) {
  const started = Date.now();
  for (;;) {
    try {
      await fetch(URL_);
      return;
    } catch {
      if (Date.now() - started > timeoutMs) throw new Error(`dev server never answered on ${PORT}:\n${serverLog}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

let failed = false;
try {
  await waitForServer();
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const problems = [];
  const note = (s) => { if (RESOLUTION_FAILURE.some((f) => s.includes(f))) problems.push(s.slice(0, 240)); };
  page.on("pageerror", (e) => note(String(e)));
  page.on("console", (m) => { if (m.type() === "error") note(m.text()); });

  await page.goto(URL_, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForTimeout(3000); // lazy workspaces + the graph loader's first compile
  // This callback is serialized and run in the BROWSER, where `document` exists; the lint config for
  // `scripts/` declares Node globals only. The directive has to sit on the line directly above the code —
  // put a second comment line between them and `disable-next-line` silences that comment instead.
  // eslint-disable-next-line no-undef
  const nodes = await page.evaluate(() => document.getElementById("root")?.querySelectorAll("*").length ?? 0);
  await browser.close();

  // Vite reports a resolution failure to the SERVER log too, and for a module the entry graph never
  // reaches that is the only place it appears.
  for (const line of serverLog.split("\n")) note(line);

  console.log(`dev-boot-check: mounted ${nodes} element(s) under #root`);
  if (problems.length) {
    console.error(`dev-boot-check: ${problems.length} module-resolution failure(s):`);
    for (const p of [...new Set(problems)].slice(0, 10)) console.error("   ", p);
    failed = true;
  }
  if (!nodes) {
    console.error("dev-boot-check: the app rendered NOTHING — it booted but did not mount");
    failed = true;
  }
  if (!failed) console.log("dev-boot-check: OK — the app boots and mounts, and every module resolved");
} catch (e) {
  console.error("dev-boot-check:", String(e).slice(0, 500));
  failed = true;
} finally {
  stop();
}
process.exit(failed ? 1 : 0);
