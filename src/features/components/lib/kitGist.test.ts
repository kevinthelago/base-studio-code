import { describe, it, expect } from "vitest";
import { kitToManifest, kitFromManifest, kitShareCode, kitFromCode, KIT_KIND } from "./kitGist";
import { validateManifest, type ExtensionManifest } from "@/features/planner/lib/gist/manifest";
import type { ComponentRecord, Kit } from "./model";

const kit: Kit = { id: "my-kit", name: "My Kit", stack: "React", dot: "var(--accent)", builtin: false };
const comps: ComponentRecord[] = [
  {
    id: "btn", name: "Btn", kitId: "my-kit", role: "primitive", version: "1.0.0", used: 3, tags: ["control"],
    variants: ["a"], composes: [], props: [{ name: "x", type: "string", req: true, desc: "d" }],
    whenUse: ["u"], whenNot: ["n"], src: "Btn.tsx", srcText: "code", wraps: "button",
  },
];

describe("component-kit gist envelope (#2305 slice 1c)", () => {
  it("round-trips a kit through the manifest", () => {
    const m = kitToManifest(kit, comps);
    expect(m.kind).toBe(KIT_KIND);
    expect(validateManifest(m).ok).toBe(true);
    const r = kitFromManifest(m);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kit.id).toBe("my-kit");
    expect(r.components.map((c) => c.name)).toEqual(["Btn"]);
    expect(r.components[0].wraps).toBe("button");
  });

  it("round-trips through a no-account share code", () => {
    const r = kitFromCode(kitShareCode(kit, comps));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.kit.name).toBe("My Kit");
  });

  it("rejects a non-kit manifest", () => {
    const bp = { manifest: 1, kind: "blueprint", id: "b", name: "B", version: "1", payload: {} } as unknown as ExtensionManifest;
    expect(kitFromManifest(bp).ok).toBe(false);
  });

  it("forces components into the kit id + drops builtin (never trusts the payload)", () => {
    const evil = kitToManifest({ ...kit, id: "react-ui" }, [{ ...comps[0], kitId: "other", builtin: true }]);
    const r = kitFromManifest(evil);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.components[0].kitId).toBe("react-ui");   // forced into the kit
    expect(r.components[0].builtin).toBeUndefined();  // an imported record is never a built-in
  });

  it("rejects a kit with no valid components", () => {
    expect(kitFromCode(kitShareCode(kit, [])).ok).toBe(false);
  });
});
