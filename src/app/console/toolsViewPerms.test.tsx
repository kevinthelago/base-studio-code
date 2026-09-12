// ToolsView renders the capability the GATE resolved — never another role's row
// (`toolsview-shows-triage-permissions-for-fifteen-of-nineteen-roles`).
//
// The component used to vendor a four-role `ROLE_DEFAULTS` table and `?? ROLE_DEFAULTS.triage` for
// everything else, so fifteen of the gate's nineteen roles rendered a posture that was not theirs.
// Measured before the fix: all FOUR hardcoded rows disagreed with the gate too, and the four roles that
// happened to render correctly (juror, operator, reviewer, tester) were coincidences of the fallback —
// and the fallback row was not even triage's real capability (the gate resolves triage as github WRITE
// / git none, the table said github read / git read).
//
// THE EXPECTATIONS ARE DERIVED, NOT RETYPED. Every assertion below reads
// `roleCapabilityBaseline.fixtures.json` — the frozen table `bsc-perms` itself resolves against, proven
// equal to the live `bsc session perms all` answer across all 19 roles by the role-gate lane's parity
// diff. A hand-written expectation table here would be a third copy of the very thing this slice exists
// to stop copying.
//
// The DOM hooks are `data-axis` / `data-tier` / `data-glob` / `data-unresolved` rather than prose,
// so a copy edit cannot silently turn these assertions vacuous.
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ToolsView } from "@/app/console/panes/views/ToolsView";
import type { PermsCapability, PermsTier } from "@/shared/lib/session/rolePermsRead";
import baseline from "@/shared/lib/session/roleCapabilityBaseline.fixtures.json";

interface BaselineRow {
  role: string;
  github: string; git: string; code: string; net: string; ui: string; graph: string;
  writeGlobs?: string[];
  allow?: string[];
  harvestRoots?: string[];
}

const ROLES = (baseline as unknown as { roles: Record<string, BaselineRow> }).roles;

/** One role's capability, in the shape `bsc session perms` hands back, built FROM the frozen baseline.
 *
 *  The single cast is on the tier strings: the fixture is JSON so they widen to `string`, while
 *  `PermsTier` is the three-value union. Nothing else is invented here. */
const capOf = (role: string): PermsCapability => {
  const r = ROLES[role];
  return {
    role,
    github: r.github as PermsTier, git: r.git as PermsTier, code: r.code as PermsTier,
    net: r.net as PermsTier, ui: r.ui as PermsTier, graph: r.graph as PermsTier,
    writeGlobs: r.writeGlobs ?? [],
    allow: r.allow ?? [],
    surfaces: null,
    harvestRoots: r.harvestRoots ?? [],
  };
};

const tierOf = (el: HTMLElement, axis: string): string | null =>
  el.querySelector(`[data-axis="${axis}"]`)?.getAttribute("data-tier") ?? null;

const globsOf = (el: HTMLElement): string[] =>
  [...el.querySelectorAll("[data-glob]")].map((n) => n.getAttribute("data-glob") ?? "");

describe("the baseline this test derives from is really there", () => {
  it("carries all nineteen roles — a shrunken fixture would make every case below vacuous", () => {
    expect(Object.keys(ROLES)).toHaveLength(19);
    // The four the component used to hardcode, and one it never did — named so a fixture that lost a
    // role fails HERE, with a legible reason, rather than silently narrowing the sweep below.
    for (const r of ["planner", "worker", "director", "triage", "designer"]) {
      expect(ROLES[r], `${r} missing from the frozen baseline`).toBeTruthy();
    }
  });
});

describe("ToolsView renders the gate's capability for every role", () => {
  it("renders each of the nineteen roles' own tiers, derived from the frozen baseline", () => {
    for (const role of Object.keys(ROLES)) {
      const cap = capOf(role);
      const { container, unmount } = render(<ToolsView role={role} cap={cap} capRead="ok" />);
      const el = container as unknown as HTMLElement;
      for (const axis of ["github", "git", "code", "net", "ui", "graph"] as const) {
        expect(tierOf(el, axis), `${role}.${axis}`).toBe(cap[axis]);
      }
      expect(globsOf(el), `${role}.writeGlobs`).toEqual(cap.writeGlobs);
      unmount();
    }
  });

  it("a role OUTSIDE the old four gets its own posture, not the triage fallback", () => {
    // `designer` is none/none/none with a `scratch/**` carve-out. The retired fallback would have
    // rendered github read / git read / code none and NO globs — so each assertion below is a
    // statement the old code could not have satisfied.
    const { container } = render(<ToolsView role="designer" cap={capOf("designer")} capRead="ok" />);
    const el = container as unknown as HTMLElement;
    expect(tierOf(el, "github")).toBe("none");
    expect(tierOf(el, "git")).toBe("none");
    expect(tierOf(el, "github")).not.toBe("read");
    expect(tierOf(el, "git")).not.toBe("read");
    expect(globsOf(el)).toEqual(ROLES.designer.writeGlobs ?? []);
    expect(globsOf(el).length).toBeGreaterThan(0);
  });

  it("director renders its commons write carve-out", () => {
    // The vendored row said code:none with globs [.gitignore, package.json]. The gate resolves
    // code:WRITE scoped to the commons globs (*.md, *.json, prompts/*, discovery/*) — #851.
    const { container } = render(<ToolsView role="director" cap={capOf("director")} capRead="ok" />);
    const el = container as unknown as HTMLElement;
    expect(tierOf(el, "code")).toBe("write");
    const globs = globsOf(el);
    expect(globs).toEqual(ROLES.director.writeGlobs ?? []);
    expect(globs).toContain("*.md");
    expect(globs).not.toContain(".gitignore");
    expect(globs).not.toContain("package.json");
  });

  it("triage renders the gate's triage, which the vendored fallback row was not", () => {
    const { container } = render(<ToolsView role="triage" cap={capOf("triage")} capRead="ok" />);
    const el = container as unknown as HTMLElement;
    expect(tierOf(el, "github")).toBe("write");
    expect(tierOf(el, "git")).toBe("none");
  });
});

describe("an unresolvable role SAYS SO and never borrows another role's row", () => {
  it("a read that RAN but has no row for this role reports the role as unknown", () => {
    const { container } = render(<ToolsView role="designer" cap={null} capRead="ok" />);
    const el = container as unknown as HTMLElement;
    expect(el.querySelector("[data-unresolved]")?.getAttribute("data-unresolved")).toBe("unknown-role");
    // The defect being fixed: a complete-looking row reads as a deliberate answer.
    expect(el.querySelectorAll("[data-axis]")).toHaveLength(0);
    expect(globsOf(el)).toEqual([]);
  });

  it("a read that COULD NOT RUN is a different answer from a role the gate does not know", () => {
    const { container } = render(<ToolsView role="designer" cap={null} capRead="unreadable" />);
    const el = container as unknown as HTMLElement;
    expect(el.querySelector("[data-unresolved]")?.getAttribute("data-unresolved")).toBe("unreadable");
    expect(el.querySelectorAll("[data-axis]")).toHaveLength(0);
  });

  it("a read still IN FLIGHT is not reported as a failure", () => {
    // The caller mounts before the read settles. Saying "could not be read" during that window would be
    // a false statement of exactly the kind this slice removes, so absent `capRead` is its own state.
    const { container } = render(<ToolsView role="designer" cap={null} />);
    const el = container as unknown as HTMLElement;
    expect(el.querySelector("[data-unresolved]")?.getAttribute("data-unresolved")).toBe("pending");
    expect(el.querySelectorAll("[data-axis]")).toHaveLength(0);
  });

  it("the props-less preview mount renders no capability at all", () => {
    // A record is mounted with no props in the Design Studio. It must not fabricate a role or a row.
    const { container } = render(<ToolsView />);
    const el = container as unknown as HTMLElement;
    expect(el.querySelectorAll("[data-axis]")).toHaveLength(0);
    expect(globsOf(el)).toEqual([]);
  });

  it("a role given with no capability never renders ANY other role's tiers", () => {
    // The sharpest statement of the defect: whatever the component shows for an unresolved role, it
    // must not coincide with a real role's row — not triage's, and not anyone's.
    const { container } = render(<ToolsView role="librarian" cap={null} capRead="ok" />);
    const el = container as unknown as HTMLElement;
    expect(el.querySelectorAll("[data-axis]")).toHaveLength(0);
  });
});
