import { describe, it, expect } from "vitest";
import { reconcileSeed } from "@/features/designs/lib/seedRefresh";

type Rec = { id: string; name?: string; srcText?: string; builtin?: boolean; seedHash?: string };

const seed = (id: string, srcText: string): Rec => ({ id, name: id, srcText, builtin: true });

describe("an EMPTY store copy is not a competing edit", () => {
  /**
   * THE BUG. Eight packaged components sat in the store with a zero-length `srcText` while their seed
   * carried real source — `dropdown` (7,846 bytes), `activityfeed` (3,940), `windowcontrols`,
   * `backbutton`, `cardlistrow`, `inlineerror`, `skillsdigesttoggle`, `settingssubheader`. They had
   * also lost their `builtin`/`seedHash` stamp to a pre-#4197 partial write, so the reconcile
   * classified them as user-authored and never touched them: the app rendered an empty component and
   * the seed's version could never arrive.
   *
   * #4216 deliberately left unstamped records alone because "which side is right" is a per-record
   * judgement. That caution is about a store copy holding DIFFERENT work. A copy holding NOTHING is
   * not a competing edit — it is a record that lost its content, and there is nothing to weigh.
   */
  it("restores an unstamped, EMPTY record from the seed", () => {
    const loaded: Rec[] = [{ id: "dropdown", name: "Dropdown", srcText: "" }];
    const out = reconcileSeed(loaded, [seed("dropdown", "export function Dropdown() {}")], "component");
    expect(out.records[0].srcText, "the seed's source is what renders now").toContain("Dropdown");
    expect(out.pushes.map((p) => p.id), "and it is written back, so it stops being empty").toEqual(["dropdown"]);
    expect(out.notices.some((n) => n.kind === "refreshed" && n.id === "dropdown")).toBe(true);
  });

  it("still leaves an unstamped record that has REAL content alone", () => {
    // The #4216 caution stands wherever there is something to lose: the drift runs both ways, and a
    // reconcile that silently replaced a page someone had authored would be the worse bug.
    const loaded: Rec[] = [{ id: "guidecard", name: "GuideCard", srcText: "the user's own work" }];
    const out = reconcileSeed(loaded, [seed("guidecard", "the shipped version")], "component");
    expect(out.records[0].srcText).toBe("the user's own work");
    expect(out.pushes).toEqual([]);
    expect(out.notices.some((n) => n.kind === "unstamped")).toBe(true);
  });

  it("does not invent content when the SEED is the empty one", () => {
    // Narrow on purpose. An empty seed record is a real (if odd) state; replacing a store copy with
    // nothing would be this bug pointed the other way.
    const loaded: Rec[] = [{ id: "x", name: "X", srcText: "" }];
    const out = reconcileSeed(loaded, [seed("x", "   ")], "component");
    expect(out.pushes).toEqual([]);
  });

  it("leaves a genuinely user-authored record untouched — it has no seed at all", () => {
    const loaded: Rec[] = [{ id: "mine", name: "Mine", srcText: "" }];
    const out = reconcileSeed(loaded, [], "component");
    expect(out.records.map((r) => r.id)).toEqual(["mine"]);
    expect(out.pushes).toEqual([]);
  });
});
