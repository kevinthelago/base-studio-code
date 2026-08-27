// The two filters over the `bsc` command-surface catalog
// (`a-persona-declares-its-command-surfaces`).
//
// These look like presentation helpers and one of them is not. A row that survives
// `deniableSurfaceNames` is a surface the complement will DENY to a persona that did not declare it;
// a row it drops is one the persona keeps. So the `deprecated` decision is a permission decision, and
// getting it wrong does not draw an extra node — it silently hands back the reach the declaration was
// meant to remove.
import { describe, it, expect } from "vitest";
import { deniableSurfaceNames, type SurfaceRow } from "@/shared/lib/session/surfaceCatalog";
import { roleCapability, roleDeniedCommands } from "@/shared/lib/session/sessionRoles";

/** The real shape of the catalog's non-active rows, verbatim from `bsc surface list --json`. */
const CATALOG: SurfaceRow[] = [
  { name: "plan", status: "active" },
  { name: "teams", status: "active" },
  { name: "ui", status: "active" },
  { name: "cad" },                          // no status ⇒ active
  { name: "org", status: "deprecated" },    // "the same store `bsc teams` serves"
  { name: "component", status: "deprecated" }, // "the same store `bsc ui` serves"
  { name: "hook", status: "internal" },
  { name: "serve", status: "internal" },
];

describe("deniableSurfaceNames — what the permission gate may deny", () => {
  it("INCLUDES the deprecated aliases, which is the whole reason it differs from the band's list", () => {
    expect(deniableSurfaceNames(CATALOG)).toContain("org");
    expect(deniableSurfaceNames(CATALOG)).toContain("component");
  });

  it("still excludes INTERNAL rows — denying them would break the deny machinery itself", () => {
    // `bsc hook` IS the PreToolUse hook, and `bsc serve` the warm-serve path. Denying either is a
    // self-inflicted outage rather than a restriction.
    expect(deniableSurfaceNames(CATALOG)).not.toContain("hook");
    expect(deniableSurfaceNames(CATALOG)).not.toContain("serve");
  });

  it("denies an alias even when the persona DECLARES the surface it aliases", () => {
    // The worker declares `ui`, so `bsc ui` is allowed — but `bsc component` is not. The catalog
    // records no alias→target mapping (only prose in `summary`), so honouring one would mean parsing
    // that prose; the safe direction is the tighter one, and the deprecation asks for `bsc ui` anyway.
    const denies = roleDeniedCommands(roleCapability("worker"), deniableSurfaceNames(CATALOG));
    expect(denies).not.toContain("bsc ui");
    expect(denies).toContain("bsc component");
  });

  it("changes nothing for an undeclared role — the whole fleet is still unaffected", () => {
    const before = roleDeniedCommands(roleCapability("triage"));
    const after = roleDeniedCommands(roleCapability("triage"), deniableSurfaceNames(CATALOG));
    expect(after).toEqual(before);
  });
});
