// The LINK VERIFIER for graph records (epic #3604) — "would this record actually load?", answered with
// the runtime's own mechanism instead of a guess.
//
// Two existing checks look like they cover this and do not:
//   - `componentScan` builds and RUNS each component, but through the PREVIEW bundler, which
//     deliberately ISOLATES — it stubs React and forbids `@/` first-party imports. It cannot see whether
//     a record's imports resolve against the APP.
//   - `platformBoundary.test.ts` does ask the right question, but with a REGEX over the source. A static
//     check more permissive than the runtime is exactly the defect #4188 and #4224 each removed:
//     `zustand/react/shallow` sailed past that guard and failed in the browser.
//
// The linker made the exact answer available. `scanRequires` over COMPILED output is what the runtime
// requires — type-only imports have already erased, re-exports have already become requires, and there
// is no second parser to drift.
//
// IT DOES NOT EVALUATE, deliberately. Evaluating runs a record's module-init side effects against the
// live app, and a verification pass must not have side effects — a Studio that verified on every
// keystroke would be re-running registries as you typed. The consequence is a stated limit: "exports a
// component" is only knowable by evaluating, so it stays the mounting host's job (`pickComponent`, and
// the last-good render gate behind it).

import { linkGraphModules, scanRequires, type CompileFn, type SourceResolver } from "./graphModules";

/** One record's verdict. `ok` is the whole judgement; the arrays say why, so a caller can render a
 *  useful message rather than a boolean. */
export interface LinkVerdict {
  ok: boolean;
  /** A compile failure — the record does not parse. Mutually exclusive with `unresolved` having meaning:
   *  nothing can be resolved if nothing compiled. */
  compileError?: string;
  /** Specifiers that are neither a graph record nor a registered platform module. These are what throw
   *  the loader's named error at mount time. */
  unresolved: string[];
  /** Every runtime specifier reached, across the record and its transitively linked records — useful for
   *  a report, and the non-vacuity check for a sweep (zero imports usually means nothing was scanned). */
  imports: string[];
  /** How many records the entry linked, INCLUDING itself. */
  linkedCount: number;
}

/** Is this specifier backed by a live registered app module? Injected so the verifier is testable and
 *  usable from a harness that registers its own platform. */
export type RegistryProbe = (specifier: string) => boolean;

/**
 * Verify that `source` would LINK: it compiles, and every specifier it (transitively) requires resolves
 * to either another graph record or a registered platform module.
 *
 * `resolveSource` is the same resolver the loader uses, so graph-first `provides` overrides (#3660) and
 * `@/components/<id>` siblings both count as resolved — a record that provides a platform specifier is a
 * legitimate answer, not a miss.
 *
 * A BARE npm specifier is checked like any other (#4224). It used to feel like the import map's concern,
 * but the import map belongs to the preview; the loader's `require` demands every specifier be
 * registered, first-party or not.
 */
export async function verifyGraphRecord(
  source: string,
  opts: { resolveSource?: SourceResolver; isRegistered: RegistryProbe; compile: CompileFn },
): Promise<LinkVerdict> {
  const { resolveSource, isRegistered, compile } = opts;
  let linked;
  // Declared without an initializer: the try below assigns BOTH halves, and the catch returns, so an
  // initial value would only ever be dead.
  let linkFailures: { specifier: string; error: string }[];
  try {
    ({ linked, failures: linkFailures } = await linkGraphModules(source, resolveSource, compile));
  } catch (e) {
    // A record that does not parse is a compile failure, not a link failure. Reported rather than
    // thrown: a sweep over hundreds of records must not stop at the first bad one.
    return { ok: false, compileError: String(e instanceof Error ? e.message : e), unresolved: [], imports: [], linkedCount: 0 };
  }

  const imports = new Set<string>();
  for (const mod of linked.values()) for (const spec of scanRequires(mod.cjs)) imports.add(spec);

  // A specifier is resolved when the linker took it (it is a record) or the registry answers it. Order
  // does not matter here — this is a membership question, not the graph-first PRECEDENCE question the
  // require chain answers at mount.
  const unresolved = [...imports].filter((spec) => !linked.has(spec) && !isRegistered(spec)).sort();

  // A closure member that would not COMPILE is declined at RUNTIME (the registry answers instead), but for
  // VERIFICATION it is exactly the thing worth naming — the sweep exists to find records that are inert.
  const compileError =
    linkFailures.length > 0
      ? `override "${linkFailures[0].specifier}" does not compile: ${linkFailures[0].error}`
      : undefined;

  return {
    ok: unresolved.length === 0 && !compileError,
    compileError,
    unresolved,
    imports: [...imports].sort(),
    linkedCount: linked.size,
  };
}

/** A one-line human summary of a verdict — what a Studio would show, and what a sweep prints per row. */
export function describeVerdict(id: string, v: LinkVerdict): string {
  if (v.compileError) return `${id}: does not compile — ${v.compileError}`;
  if (!v.ok) return `${id}: ${v.unresolved.length} unresolved import(s) — ${v.unresolved.join(", ")}`;
  return `${id}: ok (${v.linkedCount} module(s), ${v.imports.length} import(s))`;
}
