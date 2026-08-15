// Does an import reach the ALGORITHMS graph? (resolver-reads-the-algorithms-store)
//
// `provides` on an impl is inert until something resolves it, so these assert the resolution itself —
// and, just as importantly, the two things that would make the change worse than not doing it: a
// specifier that resolves NOWHERE must still fail, and a component must still win a contested one.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveGraphSource } from "@/shared/lib/runtime/graphResolver";
import { useAppStore } from "@/store";

const SPEC = "@/app/chrome/locationCrumb";
const MODULE_CODE = 'export function locationCrumb() { return "from the algorithms graph"; }';

const impl = (over: Record<string, unknown> = {}) => ({
  id: "location-crumb.ts",
  tech: "typescript",
  role: "algorithm",
  name: "locationCrumb",
  composes: [],
  code: MODULE_CODE,
  provides: SPEC,
  ...over,
});

const seed = (components: unknown[], algorithmImpls: unknown[]) =>
  useAppStore.setState({ components, algorithmImpls } as never);

describe("resolveGraphSource — the algorithms branch", () => {
  beforeEach(() => seed([], []));
  afterEach(() => seed([], []));

  it("resolves a specifier an impl PROVIDES, vending its code", () => {
    seed([], [impl()]);
    expect(resolveGraphSource(SPEC)).toBe(MODULE_CODE);
  });

  it("still returns null for a specifier NOTHING provides", () => {
    // The control. Without it, the two assertions around it would pass just as well if the resolver
    // had been changed to return the first impl it saw.
    seed([], [impl()]);
    expect(resolveGraphSource("@/features/nowhere/DoesNotExist")).toBeNull();
  });

  it("resolves null when the impl carries no `provides` — a function-granularity impl claims nothing", () => {
    seed([], [impl({ provides: undefined })]);
    expect(resolveGraphSource(SPEC)).toBeNull();
  });

  it("resolves null when the store is empty — a degraded environment does not throw", () => {
    expect(resolveGraphSource(SPEC)).toBeNull();
  });

  it("a COMPONENT wins a contested specifier — an impl may not shadow a rendering record", () => {
    // Two stores can now claim one specifier. A component claiming it means a UI record overriding a
    // registered platform module (#3660); letting an impl win would swap a rendering component for a
    // non-rendering module, which fails at MOUNT rather than at resolution — much later and much less
    // legibly.
    const component = { id: "ui-crumb", provides: SPEC, srcText: "export const fromComponents = 1;" };
    seed([component], [impl()]);
    expect(resolveGraphSource(SPEC)).toBe(component.srcText);
  });

  it("still resolves an `@/components/<id>` sibling — the existing forms are untouched", () => {
    const sibling = { id: "panel", srcText: "export const sibling = 1;" };
    seed([sibling], [impl()]);
    expect(resolveGraphSource("@/components/panel")).toBe(sibling.srcText);
  });
});
