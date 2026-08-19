// A record may claim its FILE's specifier only if it IS that file.
//
// THE RULE. `provides` is a GLOBAL override — `resolveGraphSource` is consulted BEFORE the platform
// registry — so a record whose `provides` names the specifier its own `src` implies replaces that module
// for every consumer. When the record is a faithful lift, that is the migration working. When it is a
// PREVIEW-SHAPED derivative (`bsc ui harvest` inlines what it cannot reach so the thing mounts standalone
// in the Design Studio), the same claim silently swaps the real module for the derivative at runtime.
//
// That is not hypothetical: it is how Glance broke on 2026-08-18. A batch set `provides` on
// `glance-canvas`, `glance-chat-dock` and `glance-stream-morph` from their `src`, and those records are
// preview derivatives — the page declined its whole chain and rendered "Glance page unavailable" while
// every static gate stayed green. A later pass nearly repeated it: five records were one `--apply` away
// from claiming files they are not.
//
// This is the standing check. It is deliberately narrow: it says nothing about a record that provides a
// specifier unrelated to its `src` (a minted name, a module record beside per-component ones) — only that
// a record pointing at a file and claiming that file's name must actually be it.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { seedMatchesFile, fileAsRecordSource } from "../../../scripts/lib/recordSource.mjs";

const SEED = import.meta.glob("@data/components/app/**/*.json", { eager: true }) as Record<
  string,
  { default: { id?: string; src?: string; srcText?: string; provides?: string } }
>;

/** The repo root. `process.cwd()` is where vitest was invoked, which is the root in every gate path. */
const REPO = process.cwd();

/**
 * Records allowed to claim their file's specifier while differing from it. **EMPTY, and that is the
 * finished state** — the six this guard found have all been adjudicated.
 *
 * Every one turned out the same way: a STALE SEED, with the store already equal to the file. The three
 * overlay records (`ui-dialog`, `ui-modal-card`, `ui-modal-scrim`) were the pre-a11y copies — the files
 * carry #2725's `role="dialog"`, `aria-modal`, the `useId` title association and the focus trap.
 * `plan-body-streams` still inlined a `CollapsibleCard` the file had extracted; `plan-pane-bodies`
 * predated #4265's library pane; `treeexplorerpage` was an older, longer version. None had an export its
 * file lacked, so refreshing each from its file deleted nothing.
 *
 * Adding an entry means shipping a module whose code differs from the module it claims to be, for every
 * consumer, with no other gate observing it. It needs a reason at least as specific as the ones above.
 */
const KNOWN_DIVERGED = new Set<string>([]);

const specOf = (src: string) =>
  "@/" + src.split("\\").join("/").replace(/^src\//, "").replace(/\.tsx?$/, "").replace(/\/index$/, "");

describe("a record claiming its file's specifier IS that file", () => {
  /** Records that name a `src` still on disk AND provide exactly that file's specifier. */
  const claims = Object.values(SEED)
    .map((m) => m.default)
    .filter((r): r is { id: string; src: string; srcText: string; provides: string } => {
      if (!r?.id || typeof r.src !== "string" || typeof r.srcText !== "string") return false;
      if (typeof r.provides !== "string") return false;
      return r.provides === specOf(r.src) && existsSync(join(REPO, r.src.split("\\").join("/")));
    });

  it("finds claims to check — a glob that matched nothing would pass vacuously", () => {
    // Zero is a legitimate state (every such file may be retired), so this reports rather than fails.
    expect(Array.isArray(claims)).toBe(true);
  });

  it("every such record's source is the file's source", () => {
    const wrong: string[] = [];
    for (const r of claims) {
      const srcPath = r.src.split("\\").join("/");
      const rel = srcPath.replace(/^src\//, "");
      // The record is a PROJECTION of the file — preamble, absolutized specifiers, CSS import stripped —
      // so the file has to be projected before the two are comparable. Comparing raw text calls every
      // correctly-migrated record a mismatch.
      const fileSrc = fileAsRecordSource(join(REPO, srcPath), rel);
      if (!seedMatchesFile({ seedSrcText: r.srcText, fileSrc }).ok && !KNOWN_DIVERGED.has(r.id)) {
        wrong.push(`${r.id} provides ${r.provides} but its source is not ${rel}`);
      }
    }
    expect(
      wrong,
      "these records would REPLACE the module they name with different code, for every consumer, at " +
        "runtime — and no static gate observes it:\n  " + wrong.join("\n  "),
    ).toEqual([]);
  });
  it("every KNOWN_DIVERGED entry is still real — a stale exemption hides the next regression", () => {
    // If one is fixed (or its file retired) and the list is not updated, the next record to land in that
    // state inherits a free pass under a name nobody rechecks.
    const stale = [...KNOWN_DIVERGED].filter((id) => !claims.some((c) => c.id === id));
    expect(
      stale,
      `these no longer claim their file's specifier — drop them from KNOWN_DIVERGED:\n  ${stale.join("\n  ")}`,
    ).toEqual([]);
  });
});
