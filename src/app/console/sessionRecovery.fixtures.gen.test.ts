// Recovery RECONCILE, captured from the live TypeScript so Rust can be proved to match it.
//
// Rust already discovers the sessions (`console/discovery.rs`, `discover_sessions`) and hands the list
// to the renderer, which decides which of them are LOST. This fixture is what lets that decision move
// to the side that found them.
//
// ## The trap this corpus exists to catch
//
// `cellCount` here is NOT `paneCountForLayout` from `paneStatus.ts`, and a port that reused the one for
// the other would silently change which panes count as open. Three differences, all covered below:
//   * it prefers `paneIds.length` over the layout entirely;
//   * its regex accepts an ASCII `x` and surrounding spaces, which the other does not;
//   * `2×0` is ZERO cells here (the regex matches and multiplies) and TWO there (`(c || 1) * (r || 1)`
//     reads the zero as falsy).
//
//     UPDATE_FIXTURES=1 npx vitest run src/app/console/sessionRecovery.fixtures.gen.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { openPaneIds, reconcileSessions, type DiscoveredSession, type ReconcileTab } from "@/app/console/lib/sessionRecovery";

const FIXTURE = join(process.cwd(), "src/app/console/sessionRecovery.fixtures.json");

const TABS: { label: string; tabs: ReconcileTab[] }[] = [
  { label: "no tabs", tabs: [] },
  { label: "legacy positional 2×1", tabs: [{ layout: "2×1" }] },
  { label: "manual tab with a stable id", tabs: [{ id: "tab_abc", layout: "2×2" }] },
  { label: "minted fleet ids win over layout", tabs: [{ kind: "build", id: "tab_f", layout: "3×3", paneIds: ["studio-code:director", "studio-code:api"] }] },
  // ASCII x and spaces — accepted here, not by paneCountForLayout.
  // A HOLE in paneIds. `cellCount` reads paneIds.LENGTH, so a hole still counts as a cell — and that
  // cell resolves through the manual rule. A port that compacts the holes opens one pane instead of
  // two and quietly reports the other as lost. (The same gap appeared in the pane-status corpus; it is
  // a checklist item, not a one-off.)
  { label: "sparse mints keep their cell count", tabs: [{ id: "tab_h", layout: "1×1", paneIds: [undefined as unknown as string, "studio-code:api"] }] },
  { label: "ascii x layout", tabs: [{ id: "tab_x", layout: "2x2" }] },
  { label: "spaced layout", tabs: [{ id: "tab_s", layout: "2 × 1" }] },
  // ZERO cells: the regex matches and 2*0 is 0. paneCountForLayout would say 2.
  { label: "zero-dimension layout is zero cells here", tabs: [{ id: "tab_z", layout: "2×0" }] },
  { label: "malformed layout falls back to one", tabs: [{ id: "tab_bad", layout: "nope" }] },
  { label: "two tabs, indices matter", tabs: [{ layout: "1×1" }, { id: "tab_two", layout: "2×1" }] },
];

const D = (paneId: string, status = "stale", extra: Partial<DiscoveredSession> = {}): DiscoveredSession => ({
  paneId, sources: ["ledger"], status, livePid: undefined, projectKey: undefined, repo: undefined, cwd: undefined, ...extra,
});

const CASES: { label: string; discovered: DiscoveredSession[]; tabsLabel: string }[] = [
  { label: "nothing discovered", discovered: [], tabsLabel: "legacy positional 2×1" },
  { label: "an open pane is not lost", discovered: [D("t0p0"), D("t0p1")], tabsLabel: "legacy positional 2×1" },
  { label: "a pane outside the grid IS lost", discovered: [D("t0p5")], tabsLabel: "legacy positional 2×1" },
  { label: "the planner is dropped entirely", discovered: [D("planning_studio-code")], tabsLabel: "no tabs" },
  // Two shapes: a TEMPLATED studio id (designer-<tech>) and a FIXED one. The first is the one a
  // port is likely to miss, since it is generated per technology rather than listed.
  { label: "a studio session is dropped entirely", discovered: [D("design-studio:designer-react"), D("teams-studio:architect")], tabsLabel: "no tabs" },
  // …and a NEARBY id that is NOT a studio session must survive: membership, not a prefix test.
  { label: "a debug request pane is not a studio session", discovered: [D("debug-studio:req-4212")], tabsLabel: "no tabs" },
  { label: "a manual shell is reap-only", discovered: [D("man:gone:p0")], tabsLabel: "no tabs" },
  { label: "an orphaned worker is reap-only", discovered: [D("studio-code:api", "orphaned")], tabsLabel: "no tabs" },
  { label: "a stale worker is restorable", discovered: [D("studio-code:api", "stale")], tabsLabel: "no tabs" },
  { label: "a minted open pane is not lost", discovered: [D("studio-code:api"), D("alpha:web")], tabsLabel: "minted fleet ids win over layout" },
  { label: "every field survives the map", discovered: [D("studio-code:api", "stale", { livePid: 4242, projectKey: "studio-code", repo: "owner/name", cwd: "/tmp/x", sources: ["ledger", "fleet"] })], tabsLabel: "no tabs" },
  { label: "zero-cell tab opens nothing, so its pane is lost", discovered: [D("man:tab_z:p0")], tabsLabel: "zero-dimension layout is zero cells here" },
  { label: "ascii x tab opens its cells", discovered: [D("man:tab_x:p0"), D("man:tab_x:p3")], tabsLabel: "ascii x layout" },
  { label: "the hole's cell is open via the manual rule", discovered: [D("man:tab_h:p0"), D("studio-code:api"), D("man:tab_h:p1")], tabsLabel: "sparse mints keep their cell count" },
];

function tabsFor(label: string): ReconcileTab[] {
  const t = TABS.find((x) => x.label === label);
  if (!t) throw new Error(`unknown tabs label ${label}`);
  return t.tabs;
}

function build() {
  return {
    note: "GENERATED from the live TypeScript — see sessionRecovery.fixtures.gen.test.ts",
    openIds: TABS.map(({ label, tabs }) => ({ label, tabs, open: [...openPaneIds(tabs)].sort() })),
    reconcile: CASES.map(({ label, discovered, tabsLabel }) => ({
      label,
      tabsLabel,
      discovered,
      // WHOLE RECORDS in order, with EVERY field written out explicitly — a port that keeps the right
      // sessions but drops a field passes any count or id-only comparison. The `?? null` matters:
      // JSON.stringify erases an `undefined`, so without it the contract would silently stop
      // mentioning the optional fields and a Rust struct missing one would still match.
      recoverable: reconcileSessions(discovered, tabsFor(tabsLabel)).map((r) => ({
        paneId: r.paneId,
        sources: r.sources,
        livePid: r.livePid ?? null,
        status: r.status,
        projectKey: r.projectKey ?? null,
        repo: r.repo ?? null,
        cwd: r.cwd ?? null,
        kind: r.kind,
        reapOnly: r.reapOnly,
      })),
    })),
  };
}

describe("the recovery reconcile is captured for Rust to match", () => {
  it("matches the committed fixture (UPDATE_FIXTURES=1 to regenerate)", () => {
    const text = JSON.stringify(build(), null, 2) + "\n";
    if (process.env.UPDATE_FIXTURES === "1") writeFileSync(FIXTURE, text);
    expect(existsSync(FIXTURE), `${FIXTURE} is missing — run with UPDATE_FIXTURES=1`).toBe(true);
    expect(readFileSync(FIXTURE, "utf8")).toBe(text);
  });

  /** Each of the four exclusions must actually fire somewhere, or the port can skip one and pass. */
  it("exercises every reason a discovered session is excluded or flagged", () => {
    const b = build();
    const byLabel = (l: string) => b.reconcile.find((c) => c.label === l)!;
    expect(byLabel("an open pane is not lost").recoverable).toHaveLength(0);
    expect(byLabel("the planner is dropped entirely").recoverable).toHaveLength(0);
    expect(byLabel("a studio session is dropped entirely").recoverable).toHaveLength(0);
    expect(byLabel("a manual shell is reap-only").recoverable[0].reapOnly).toBe(true);
    expect(byLabel("an orphaned worker is reap-only").recoverable[0].reapOnly).toBe(true);
    expect(byLabel("a stale worker is restorable").recoverable[0].reapOnly).toBe(false);
  });

  /** `cellCount` differs from `paneCountForLayout`, and the corpus must show it. */
  it("pins the cell-count rules that differ from the status rollup's", () => {
    const b = build();
    const open = (l: string) => b.openIds.find((o) => o.label === l)!.open;
    expect(open("zero-dimension layout is zero cells here")).toEqual([]); // paneCountForLayout would say 2
    expect(open("ascii x layout")).toHaveLength(4); // the other regex would not match at all
    expect(open("spaced layout")).toHaveLength(2);
    expect(open("minted fleet ids win over layout")).toEqual(["studio-code:api", "studio-code:director"]);
  });

  /** Every field must appear non-empty at least once, or a dropped one is invisible. */
  it("carries a session with every optional field populated", () => {
    const c = build().reconcile.find((x) => x.label === "every field survives the map")!.recoverable[0];
    expect(c.livePid).toBe(4242);
    expect(c.projectKey).toBe("studio-code");
    expect(c.repo).toBe("owner/name");
    expect(c.cwd).toBe("/tmp/x");
    expect(c.sources).toEqual(["ledger", "fleet"]);
    expect(c.kind).toBe("worker");
  });
});
