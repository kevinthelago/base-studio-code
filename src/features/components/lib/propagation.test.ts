import { describe, it, expect } from "vitest";
import {
  classifyChange, makeChange, changeId, planPropagation, dedupeDispatches, dispatchKey,
  type KitConsumer,
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

    it("breaking + auto → assign (live) or issue (dormant); un-opted-in → notify", () => {
      const byProj = Object.fromEntries(planPropagation(breaking, consumers).map((d) => [d.projectKey, d.kind]));
      expect(byProj).toEqual({ a: "assign", b: "issue", c: "notify" });
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
});
