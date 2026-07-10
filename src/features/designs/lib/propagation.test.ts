import { describe, it, expect } from "vitest";
import {
  classifyChange, makeChange, changeId, planPropagation, dedupeDispatches, dispatchKey,
  planKitDrain, deliveryKey, kitDispatchPrompt,
  type KitConsumer, type Dispatch, type KitChange, type ChangeClass,
} from "./propagation";
import { SEED_COMPONENTS } from "./seed";
import type { ComponentRecord } from "./model";

const button = SEED_COMPONENTS.find((c) => c.name === "Button")!;
const clone = (over: Partial<ComponentRecord>): ComponentRecord => ({ ...button, ...over });

describe("kit-change propagation (#2277)", () => {
  describe("classifyChange", () => {
    it("breaking: a prop removed / became required / changed type, or a variant removed", () => {
      expect(classifyChange(button, clone({ props: button.props.filter((p) => p.name !== "size") }))).toBe("breaking");
      expect(classifyChange(button, clone({ props: button.props.map((p) => (p.name === "size" ? { ...p, req: true } : p)) }))).toBe("breaking");
      expect(classifyChange(button, clone({ props: button.props.map((p) => (p.name === "size" ? { ...p, type: "number" } : p)) }))).toBe("breaking");
      expect(classifyChange(button, clone({ variants: button.variants.filter((v) => v !== "sm") }))).toBe("breaking");
    });

    it("additive: a new prop or variant; fix: no shape change", () => {
      expect(classifyChange(button, clone({ props: [...button.props, { name: "tone", type: "string", req: false, desc: "" }] }))).toBe("additive");
      expect(classifyChange(button, clone({ variants: [...button.variants, "loading"] }))).toBe("additive");
      expect(classifyChange(button, clone({ version: "2.3.1" }))).toBe("fix");
    });
  });

  it("makeChange derives id + class from the diff; an explicit class overrides", () => {
    const after = clone({ version: "2.4.0", variants: [...button.variants, "loading"] });
    const ch = makeChange(after, button);
    expect(ch.class).toBe("additive");
    expect(ch.id).toBe(changeId("react-ui", "Button", "2.4.0", "additive"));
    expect(ch.from).toBe("2.3.0");
    expect(ch.to).toBe("2.4.0");
    // Author-declared class wins.
    expect(makeChange(after, button, { class: "fix" }).class).toBe("fix");
  });

  describe("planPropagation", () => {
    const consumers: KitConsumer[] = [
      { projectKey: "a", kitId: "react-ui", auto: true, live: true },
      { projectKey: "b", kitId: "react-ui", auto: true, live: false },
      { projectKey: "c", kitId: "react-ui" }, // not opted in
      { projectKey: "d", kitId: "other-kit", auto: true, live: true }, // different kit
    ];
    const breaking = makeChange(button, button, { class: "breaking" });

    it("only fans out to consumers of the changed kit", () => {
      expect(planPropagation(breaking, consumers).map((x) => x.projectKey)).toEqual(["a", "b", "c"]);
    });

    it("breaking + auto → assign (live OR dormant — liveness gates delivery, not the kind); un-opted-in → notify", () => {
      const byProj = Object.fromEntries(planPropagation(breaking, consumers).map((d) => [d.projectKey, d.kind]));
      expect(byProj).toEqual({ a: "assign", b: "assign", c: "notify" });
    });

    it("additive/fix are notify-only even when opted in (no wide blast of issues)", () => {
      const additive = makeChange(clone({ version: "2.4.0", variants: [...button.variants, "loading"] }), button);
      expect(planPropagation(additive, consumers).every((d) => d.kind === "notify")).toBe(true);
    });
  });

  it("dedupeDispatches drops already-delivered (projectKey, change.id) pairs", () => {
    const change = makeChange(button, button, { class: "breaking" });
    const all = planPropagation(change, [
      { projectKey: "a", kitId: "react-ui", auto: true, live: true },
      { projectKey: "b", kitId: "react-ui", auto: true, live: true },
    ]);
    const seen = new Set([dispatchKey(all[0])]);
    expect(dedupeDispatches(all, seen).map((d) => d.projectKey)).toEqual(["b"]);
  });

  describe("planKitDrain (delivery gate/dedup/rate-limit)", () => {
    const chg = (cls: ChangeClass, to = "2.4.0"): KitChange => makeChange(clone({ version: to }), button, { class: cls });
    const disp = (projectKey: string, change: KitChange): Dispatch => ({ projectKey, kind: "notify", change, reason: "" });
    const breaking = chg("breaking");

    it("GATE: the toggle off delivers nothing (surface-only)", () => {
      expect(planKitDrain([disp("a", breaking)], [], { enabled: false, live: true, maxPerCycle: 3 }).deliver).toEqual([]);
    });

    it("assign-only rail: a live consumer delivers assign; a dormant one HOLDS (delivers nothing), no issue", () => {
      const live = planKitDrain([disp("a", breaking)], [], { enabled: true, live: true, maxPerCycle: 3 });
      expect(live.deliver[0].rail).toBe("assign");
      // No live fleet ⇒ nothing delivered and nothing marked delivered — the queue carries forward.
      const dormant = planKitDrain([disp("a", breaking)], [], { enabled: true, live: false, maxPerCycle: 3 });
      expect(dormant.deliver).toEqual([]);
      expect(dormant.nextDelivered).toEqual([]);
    });

    it("only BREAKING changes auto-fire; additive/fix stay surface-only", () => {
      const ds = [disp("a", chg("additive", "2.5.0")), disp("a", chg("fix", "2.4.1")), disp("a", breaking)];
      const plan = planKitDrain(ds, [], { enabled: true, live: true, maxPerCycle: 9 });
      expect(plan.deliver.map((d) => d.change.class)).toEqual(["breaking"]);
    });

    it("DEDUP: an already-delivered (consumer, change) never re-fires", () => {
      const already = [deliveryKey("a", breaking.id)];
      expect(planKitDrain([disp("a", breaking)], already, { enabled: true, live: true, maxPerCycle: 3 }).deliver).toEqual([]);
    });

    it("RATE-LIMIT: at most maxPerCycle deliveries per cycle, and records them in nextDelivered", () => {
      const ds = [chg("breaking", "2.4.0"), chg("breaking", "2.5.0"), chg("breaking", "2.6.0")].map((c) => disp("a", c));
      const plan = planKitDrain(ds, [], { enabled: true, live: true, maxPerCycle: 2 });
      expect(plan.deliver).toHaveLength(2);
      expect(plan.nextDelivered).toHaveLength(2);
    });
  });

  it("kitDispatchPrompt routes to bsc-assign + the run-the-command instruction, with the migration note", () => {
    const ch = makeChange(clone({ version: "2.4.0" }), button, {
      class: "breaking", summary: "Button variant renamed", migration: "rename `type` → `variant`",
    });
    const prompt = kitDispatchPrompt(ch);
    expect(prompt).toContain("bsc-assign");
    expect(prompt).toContain("bsc ui emit sync"); // adoption = re-run the command, not hand-edit
    expect(prompt).toContain("rename `type`"); // the migration note rides along
    expect(prompt).toContain("call sites"); // breaking ⇒ reconcile call sites too
    // A non-breaking change omits the call-site reconciliation line.
    const additive = kitDispatchPrompt(makeChange(clone({ version: "2.4.0", variants: [...button.variants, "loading"] }), button));
    expect(additive).toContain("bsc ui emit sync");
    expect(additive).not.toContain("call sites");
  });
});
