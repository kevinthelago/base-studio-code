import { describe, expect, it } from "vitest";
import { entriesImportingStatically } from "./lib/recordSource.mjs";

// A module the app ENTRY imports statically must stay a file, however good its record is: the dev
// server's pre-transform pass resolves the `@/…` alias to `/src/…` before the records plugin is
// installed, so retiring one makes the app fail to boot — with tsc, lint, vitest and `vite build` all
// green, because only a real boot observes it.
//
// This exists as ONE definition because the tool that DELETES and the census that GRADES disagreed:
// the census offered `useAppBoot`, `ConsoleGraphHost`, `TerminalHost` and `features/sounds/index` as
// retirable, and `bsc components retire` refused every one of them for this rule.
const FILES: Record<string, string> = {
  "/repo/src/app/App.tsx": [
    `import { ConsoleGraphHost } from "@/app/console/ConsoleGraphHost";`,
    `import { useAppBoot } from "@/app/useAppBoot";`,
    `import { lazy } from "react";`,
    `const Late = lazy(() => import("@/features/late/Late"));`,
  ].join("\n"),
  "/repo/src/app/main.tsx": `import "@/styles/tokens.css";\nimport { boot } from "@/app/boot";`,
};
const read = (p: string) => FILES[p] ?? "";
const exists = (p: string) => p in FILES;

describe("entriesImportingStatically", () => {
  it("finds a named static import from App.tsx", () => {
    expect(entriesImportingStatically("/repo", "app/useAppBoot", read, exists)).toEqual(["app/App.tsx"]);
  });

  it("finds one from main.tsx too", () => {
    expect(entriesImportingStatically("/repo", "app/boot", read, exists)).toEqual(["app/main.tsx"]);
  });

  it("returns empty for a module no entry imports", () => {
    expect(entriesImportingStatically("/repo", "features/other/Thing", read, exists)).toEqual([]);
  });

  it("does NOT flag a LAZY import — that one resolves through the plugin and is retirable", () => {
    // The whole distinction: `lazy(() => import("@/x"))` is not a static import, so the records plugin
    // gets its chance. Treating it as static would refuse retirements that are perfectly safe.
    expect(entriesImportingStatically("/repo", "features/late/Late", read, exists)).toEqual([]);
  });

  it("skips an entry that does not exist rather than throwing", () => {
    const onlyApp = (p: string) => p === "/repo/src/app/App.tsx";
    expect(entriesImportingStatically("/repo", "app/useAppBoot", read, onlyApp)).toEqual(["app/App.tsx"]);
  });
});
