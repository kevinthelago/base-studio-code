// THE SWEEP, as a test rather than a claim (`the-launch-and-proxy-choose-their-own-github-token`).
//
// The renderer used to resolve a GitHub credential and hand the VALUE to `github_request`,
// `github_graphql`, `gist_create`, `gist_update` and `preflight`. Rust then recorded a credential
// choice it had not made and could not check — the same shape the role gate's derivation moved for.
// Rust chooses now, and this asserts the renderer cannot drift back to passing one.
//
// IT READS THE COMMITTED STORE, NOT `src/`. Most of this frontend is records, and a recursive grep
// over `src/` silently skips `.bsc-records`, so a sweep that looked there would pass while a record
// still carried the old call. `loadStore` is the same reader the other store-wide guards use.
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadStore, resolveStorePath } from "../../../../scripts/lib/recordStore.mjs";

const ROOT = resolve(__dirname, "../../../..");
/** The algorithm store, through its marker — never a hard-coded name (`graph/store.toml` names it). */
const ALGORITHM_STORE = resolveStorePath(ROOT);
/**
 * The COMPONENT store, opened BY NAME because nothing names it for us: `graph/store.toml` resolves the
 * algorithm store only, and `resolveStorePath` returns exactly that. Reading components out of it is
 * the bug this line fixes — the first draft asked the algorithm store for a `components` key it has
 * never had, got `undefined`, swept zero component records, and reported the flip complete.
 *
 * Its existence is ASSERTED rather than assumed: `loadStore` on a missing SQLite path MINTS an empty
 * database, so a wrong path here would once again make this guard pass by reading nothing at all.
 */
const COMPONENT_STORE = resolve(ROOT, "graph/components.db");

/** The commands that resolve their own credential in Rust now. */
const RESOLVING_COMMANDS = ["github_request", "github_graphql", "gist_create", "gist_update", "preflight"] as const;

/**
 * The ONE record that may still send a credential, and why: `useGithubConnect` validates a PAT the
 * user has just typed, before anything is saved, so there is nothing for Rust to resolve yet.
 * Named here so retiring it later (`frontend-state-5b…`) means deleting a line, not discovering a gap.
 */
const ALLOWED = new Map<string, string>([
  ["use-github-connect.ts", "validates a typed PAT that is not a stored credential yet"],
]);

interface Impl { id?: string; tech?: string; code?: string; srcText?: string }

/**
 * Every TypeScript record in the app, from BOTH STORES and both fields that can hold source.
 *
 * A COMPONENT record lives in a DIFFERENT DATABASE and keeps its source in `srcText`, not `code` —
 * which is exactly how three of them (`kitsharemodal`, `settings-demostatecard`,
 * `settings-studiocard`) went on handing a credential to the gist helpers while a sweep of the
 * algorithm store reported the flip complete. Sweeping one store, or one field, and calling that a
 * sweep is the failure this guard exists to prevent.
 */
function typescriptImpls(): Impl[] {
  // Implementations are filtered by TECH — a Rust record may legitimately NAME the deleted module in
  // prose (`repo_credentials/mod.rs` explains that the TypeScript is gone), and flagging that would
  // make this guard unactionable.
  const algorithms = ((loadStore(ALGORITHM_STORE) as { implementations?: Impl[] }).implementations ?? []).filter(
    (i) => i.tech === "typescript",
  );
  // Components are TSX by construction and carry no `tech`, so every one of them is in scope.
  expect(existsSync(COMPONENT_STORE), `${COMPONENT_STORE} is missing — this guard would sweep no components`).toBe(true);
  const components = (loadStore(COMPONENT_STORE) as { implementations?: Impl[] }).implementations ?? [];
  expect(components.length, "the component store read back empty — a guard that sweeps nothing passes").toBeGreaterThan(0);
  return [...algorithms, ...components];
}

/** The source a record carries, whichever field holds it. */
function sourceOf(impl: Impl): string {
  return `${impl.code ?? ""}\n${impl.srcText ?? ""}`;
}

describe("the proxy chooses its own credential", () => {
  it("no record hands a credential to a command that resolves one in Rust", () => {
    const offenders: string[] = [];
    for (const impl of typescriptImpls()) {
      const id = impl.id ?? "";
      if (ALLOWED.has(id)) continue;
      for (const cmd of RESOLVING_COMMANDS) {
        // The ARGUMENT OBJECT of `invoke("<cmd>", { … })`, not the whole file: a record may well
        // mention a token for some other reason, and flagging that would make this unactionable.
        const call = new RegExp(String.raw`invoke\s*(?:<[^>]*>)?\s*\(\s*["'\`]${cmd}["'\`]\s*,\s*\{([^}]*)\}`, "gs");
        for (const m of sourceOf(impl).matchAll(call)) {
          if (/(^|[\s,{])token\b/.test(m[1])) offenders.push(`${id} → ${cmd}`);
        }
      }
    }
    expect(offenders, `these hand a credential to Rust instead of letting it choose:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("the renderer's copy of the credential rule is gone, leaving one copy in Rust", () => {
    const impls = typescriptImpls();
    expect(impls.map((i) => i.id)).not.toContain("repo-credentials.ts");

    for (const impl of impls) {
      const code = sourceOf(impl);
      expect(code, `${impl.id} imports the deleted module`).not.toMatch(/github\/repoCredentials/);
      for (const gone of ["resolveGithubToken", "tokenForRepo", "repoFromGitHubPath"]) {
        expect(code, `${impl.id} still calls ${gone}, which only Rust has now`).not.toContain(`${gone}(`);
      }
    }
  });

  it("no FILE on disk imports or registers the deleted module either", () => {
    // THE GAP THIS CLOSES, found the hard way. The sweep above reads RECORDS, and
    // `src/app/runtime/appModules.ts` is a tracked FILE that registers every module by specifier.
    // Deleting the record left its `import * as RepoCredentials` behind, and the whole module
    // registry then failed to resolve — every collection in the suite, not just this one.
    // A records-only sweep structurally cannot see that, so the files are walked too.
    const roots = ["src", "scripts", "e2e"].map((d) => resolve(ROOT, d)).filter((d) => existsSync(d));
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.(ts|tsx|mjs|js)$/.test(entry.name)) continue;
        if (full === __filename) continue; // this guard names the module on purpose
        const text = readFileSync(full, "utf8");
        if (/["'`]@\/shared\/lib\/github\/repoCredentials["'`]/.test(text)) {
          offenders.push(full.slice(ROOT.length + 1));
        }
      }
    };
    roots.forEach(walk);
    expect(offenders, `these still name the deleted module:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("keeps the frozen corpus the Rust port is proved against", () => {
    // The TypeScript that GENERATED this fixture is gone with the record, so it is now a frozen
    // record of what that code answered — and the Rust parity test resolves it BY FILENAME.
    // Deleting it would leave that port proved against nothing, silently.
    const doc = JSON.parse(readFileSync(resolve(ROOT, "src/shared/lib/github/repoCredentials.fixtures.json"), "utf8")) as {
      paths?: unknown[]; tokenForRepo?: unknown[]; resolve?: unknown[];
    };
    expect(doc.paths?.length ?? 0).toBeGreaterThan(0);
    expect(doc.tokenForRepo?.length ?? 0).toBeGreaterThan(0);
    expect(doc.resolve?.length ?? 0).toBeGreaterThan(0);
  });
});
