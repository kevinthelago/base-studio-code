// Build-plan resolution (#2632) — from a project's package.json, the web build + serve plan the
// verify-build (#2623) runs to produce a `PreviewSource`. Kept PURE + separate from the Rust exec so
// the stack→commands decision is unit-testable independent of the process that runs it. Web-first
// (npm/vite/framework); wasm + native are separate build strategies handled later in the epic.

/** The package.json fields the resolver reads. */
export interface PkgManifest {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** A resolved WEB build + serve plan. `build` runs in the repo; `serve` starts a preview server whose
 *  stdout carries the local URL the iframe loads (captured by the Rust `verify_build`). */
export interface BuildPlan {
  build: string[];
  serve: string;
  kind: "web";
}

/**
 * Resolve the web build/serve plan from a package.json, or `null` when it isn't a buildable web app here
 * (no `build` script — e.g. a native/wasm project, handled by a different strategy). Install then build,
 * then serve: prefer the framework's own `preview` server (real routing + hashed assets), else a static
 * file server of the build output. Pure.
 */
export function resolveBuildPlan(pkg: PkgManifest | null): BuildPlan | null {
  const scripts = pkg?.scripts ?? {};
  if (!scripts.build) return null;
  const build = ["npm ci || npm install", "npm run build"];
  // A framework `preview` script (Vite/Astro/…) serves the real build; otherwise static-serve the output
  // dir (vite→dist, most SPA templates→dist; the Rust exec falls back to `build/` if `dist/` is absent).
  const serve = scripts.preview ? "npm run preview" : "npx --yes serve -s dist";
  return { build, serve, kind: "web" };
}
