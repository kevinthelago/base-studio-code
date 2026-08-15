// EVERY resolver must know about records — the list, asserted, so the next one added is not found the
// hard way.
//
// A retired module exists only as a packaged seed materialized into `.bsc-records/`, so anything that
// turns a `@/…` specifier into code has to consult that tree. There is no single place to configure it:
// each tool has its own resolver and they were each discovered by a different failure.
//
//   tsconfig.json          `paths` — tsc. `npm run typecheck` reads this and nothing else.
//   vite.config.ts         the `bscRecords` plugin — the dev server and the app bundle.
//   vite.config.ts         `worker.plugins` — a WORKER IS A SEPARATE BUILD WITH A SEPARATE PLUGIN LIST.
//                          `resolve.alias` is config-level so a worker inherits it, but `plugins` is not:
//                          `worker.plugins` defaults to EMPTY, so a worker aliased `@/…` straight to a
//                          path on disk and nothing answered for the record. Only `vite build` can see
//                          it — tsc reads `paths`, vitest never bundles a worker.
//   vitest.config.ts       the same plugin — the default gate.
//   e2e/vite.config.ts     its OWN config, outside the root tsconfig. Retiring `Spacer` broke the whole
//                          Playwright harness because this one was missed.
//   reactUiKit.gen.test.ts the kit generator walks the import graph itself.
//
// This test is deliberately TEXTUAL. Importing each config would run it, and the point is to notice a
// config that has *stopped* mentioning the resolver, which a loaded config cannot report.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(REPO, p), "utf8");

describe("record resolvers (#3604)", () => {
  it("tsc resolves @/… through .bsc-records", () => {
    const tsconfig = read("tsconfig.json");
    expect(tsconfig).toContain(".bsc-records/*");
    // Order matters: `./src/*` first, so a file that still exists always beats its record.
    const paths = tsconfig.slice(tsconfig.indexOf('"@/*"'));
    expect(paths.indexOf("./src/*")).toBeLessThan(paths.indexOf(".bsc-records/*"));
  });

  it.each([
    ["vite.config.ts", "the app bundle + dev server"],
    ["vitest.config.ts", "the default gate"],
    ["e2e/vite.config.ts", "the Playwright harness"],
  ])("%s installs the bscRecords plugin (%s)", (file) => {
    expect(read(file)).toContain("bscRecords(");
  });

  it("the WORKER sub-build installs it too — its plugin list is separate", () => {
    const cfg = read("vite.config.ts");
    // `worker.plugins` is a FUNCTION returning plugins, and it defaults to none of the root ones.
    expect(cfg).toMatch(/worker:\s*\{\s*plugins:\s*\(\)\s*=>\s*\[[^\]]*bscRecords\(/);
  });

  it("the kit generator resolves records as well as files", () => {
    expect(read("src/features/designs/lib/reactUiKit.gen.test.ts")).toContain("bscRecords");
  });
});
