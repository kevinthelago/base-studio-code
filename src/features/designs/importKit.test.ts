import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "@/store";
import { SEED_COMPONENTS, SEED_KITS } from "./lib/seed";
import type { ComponentRecord, Kit } from "./lib/model";

beforeEach(() => useAppStore.setState({ components: SEED_COMPONENTS, kits: SEED_KITS }));

// A kit whose id + a component id collide with a packaged built-in — the import must not clobber them.
const kit: Kit = { id: "react-ui", name: "Imported Kit", stack: "x", dot: "var(--accent)" };
const comps: ComponentRecord[] = [
  { id: "button", name: "Button", kitId: "react-ui", role: "primitive", version: "1", used: 0, tags: [], variants: ["default"], composes: [], props: [], whenUse: [], whenNot: [], src: "", srcText: "" },
];

describe("importKit (#2305 slice 1c)", () => {
  it("lands an imported kit collision-safe — fresh ids, never a built-in", () => {
    const added = useAppStore.getState().importKit(kit, comps);
    expect(added.id).not.toBe("react-ui");   // collided with the built-in kit → fresh id
    expect(added.builtin).toBe(false);

    const st = useAppStore.getState();
    expect(st.kits.find((k) => k.id === added.id)).toBeTruthy();
    const imported = st.components.filter((c) => c.kitId === added.id);
    expect(imported).toHaveLength(1);
    expect(imported[0].id).not.toBe("button"); // collided with the built-in component → fresh id
    expect(imported[0].builtin).toBe(false);
    // The packaged react-ui kit is untouched.
    expect(st.kits.find((k) => k.id === "react-ui")?.name).toBe("react-ui");
  });
});
