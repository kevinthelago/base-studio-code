// Director-owned commons (#851) — the repo-root shared files that EVERY stream depends on and
// that feature-decomposition can't carve apart: the ignore file, the dependency manifest +
// lockfile, the TS/build config, CI workflows, the env template, and formatter/linter config.
//
// Worktrees isolate the working *directory*, not the *merge*: each worker that appends to one of
// these on its own branch collides at integration. The fix is a single owner + dependency-gating,
// with the **director** as that owner (it lives at the project root, sees every worktree, and is
// the integrator — and these commons are integration concerns). This module is the pure source of
// truth for the commons set: which paths they are (derived from the stack), the owns-exclusion that
// keeps every feature stream OUT of them, and the union-merge subset. Free of React / Tauri imports
// so it's unit-testable in isolation (matches sessionRoles.ts).

/** A stack tag describing the project's tech (lowercased identifiers like `react`, `rust`, `node`). */
export type StackTag = string;

/**
 * Repo-root commons present in EVERY project regardless of stack — the ignore file, CI workflows,
 * the env template, and the common formatter/linter configs. These are the director's lane and are
 * excluded from every feature stream's `owns`.
 */
const BASE_COMMONS: string[] = [
  ".gitignore",
  ".gitattributes",
  ".github/workflows/**",
  ".env.example",
  // Formatter / linter config (cross-stack — present for JS, Rust, Python projects alike).
  ".editorconfig",
  ".prettierrc",
  ".prettierrc.*",
  "prettier.config.*",
  ".eslintrc",
  ".eslintrc.*",
  "eslint.config.*",
];

/**
 * Stack-specific commons keyed by a tag substring. Each entry's globs are added when ANY of the
 * project's stack tags contains the key (case-insensitive) — so `react`/`node`/`typescript`/`vite`
 * all pull in the JS/TS manifest + tsconfig, and `rust`/`cargo` pull in the Cargo manifest.
 */
const STACK_COMMONS: Array<{ match: string[]; globs: string[] }> = [
  {
    // JS/TS ecosystems: the package manifest + every lockfile flavor, and the TS/build config.
    match: ["node", "npm", "pnpm", "yarn", "react", "vue", "svelte", "next", "vite", "typescript", "ts", "javascript", "js", "tauri"],
    globs: [
      "package.json",
      "package-lock.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      "tsconfig.json",
      "tsconfig.*.json",
    ],
  },
  {
    // Rust: the Cargo manifest + lockfile (workspace root).
    match: ["rust", "cargo", "tauri"],
    globs: ["Cargo.toml", "Cargo.lock"],
  },
  {
    // Python: the project manifests + common lockfiles.
    match: ["python", "py", "poetry", "pip"],
    globs: ["pyproject.toml", "setup.py", "setup.cfg", "requirements*.txt", "poetry.lock", "Pipfile", "Pipfile.lock"],
  },
  {
    // Go: the module manifest + checksum file.
    match: ["go", "golang"],
    globs: ["go.mod", "go.sum"],
  },
];

/**
 * The line-additive commons whose merges should use git's `merge=union` driver: files that streams
 * only ever APPEND lines to (ignore entries, env keys), so concatenating both sides on merge is the
 * correct resolution and any residual race auto-resolves without a conflict. (NOT the structured
 * files — package.json/tsconfig/Cargo.toml — where a blind union would produce invalid JSON/TOML.)
 */
export const UNION_MERGE_COMMONS: string[] = [".gitignore", ".env.example"];

/**
 * Pull candidate stack tags out of the free-text `stack.md` section the planner writes (#851). The
 * stack section is prose, not a tag list, so we tokenize it into lowercase words and let {@link
 * commonsGlobsForStack}'s substring match recognize the technologies (`react`, `rust`, `node`, …).
 * Cheap and order-independent; unrecognized words simply don't match any stack entry.
 */
export function stackTagsFromSection(stackSection: string): StackTag[] {
  if (!stackSection) return [];
  const seen = new Set<string>();
  for (const tok of stackSection.toLowerCase().match(/[a-z][a-z0-9+.#-]*/g) ?? []) {
    if (tok.length >= 2) seen.add(tok);
  }
  return [...seen];
}

/**
 * Derive the repo-root commons set from the project's stack tags. Always includes {@link
 * BASE_COMMONS}; adds each stack entry whose `match` key is a substring of any tag. Deduped and
 * stable-ordered (base first, then stack additions in declaration order). With no recognized tag the
 * caller still gets the universal base commons.
 */
export function commonsGlobsForStack(stack: StackTag[]): string[] {
  const tags = stack.map((t) => t.toLowerCase().trim()).filter(Boolean);
  const out = [...BASE_COMMONS];
  for (const entry of STACK_COMMONS) {
    if (entry.match.some((m) => tags.some((t) => t.includes(m)))) {
      for (const g of entry.globs) if (!out.includes(g)) out.push(g);
    }
  }
  return out;
}

/** True when `path` is one of the commons globs in `commons` (uses the same glob matcher the role
 *  gate uses; imported lazily to avoid a cycle isn't needed — sessionRoles has no commons import). */
function pathInCommons(path: string, commons: string[], match: (glob: string, p: string) => boolean): boolean {
  return commons.some((g) => g === path || match(g, path));
}

/**
 * Strip any commons path from a feature stream's `owns` (the owns-exclusion, #851 step 1): the
 * director owns the commons, so no feature stream may list one. A stream that owned `.gitignore` or
 * `package.json` would re-introduce the parallel-append collision; this enforces the single-owner
 * rule by construction. `match` is the glob matcher (injected to avoid importing the heavier
 * sessionRoles here for a one-liner).
 */
export function excludeCommonsFromOwns(owns: string[], commons: string[], match: (glob: string, p: string) => boolean): string[] {
  return owns.filter((o) => {
    // Drop an exact commons glob the stream declared, and any concrete path that falls inside one.
    if (commons.includes(o)) return false;
    return !pathInCommons(o, commons, match);
  });
}
