// Tests for the general node model + the manifest-derived validator (#3485).
//
// The point of this sub-slice is that the validator's guarantees are REAL and its gaps are STATED, so
// these tests assert both halves: what it catches, and — explicitly — what it does not, so the second
// set fails loudly if anyone later assumes coverage that was never there.
import { describe, it, expect } from "vitest";
import {
  validateGeneralNode,
  PRIMITIVE_NAMES,
  VALIDATION_COVERAGE,
  type GeneralNode,
} from "./generalNode";
import { UI_KIT } from "../manifest";

describe("the vocabulary is derived from the manifest (#3485)", () => {
  it("covers every primitive, so adding one to the manifest needs no edit here", () => {
    expect(PRIMITIVE_NAMES.length).toBe(UI_KIT.length);
    // Spot-check across groups rather than pinning the whole list (which would just restate the manifest).
    for (const name of ["Card", "Row", "Stack", "Text", "Button"]) {
      expect(PRIMITIVE_NAMES).toContain(name);
    }
  });

  it("rejects a type that is not a primitive, naming it", () => {
    const errs = validateGeneralNode({ type: "NotAThing" });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('unknown primitive "NotAThing"');
  });

  it("rejects a non-object, and a node with no type", () => {
    expect(validateGeneralNode("nope")[0]).toContain("expected a node object");
    expect(validateGeneralNode({})[0]).toContain('missing string "type"');
  });
});

// `Text` is a good subject: it carries an enum (`tone`), a boolean (`mono`), a number (`weight`) and a
// string (`as`) — four distinct PropTypes on one primitive. It also REQUIRES `children` (its content),
// so every fixture supplies it: omitting it is a genuine error the validator should and does report.
const text = (props: Record<string, unknown> = {}): GeneralNode => ({ type: "Text", children: "x", props });

describe("prop enforcement (#3485)", () => {
  it("rejects an unknown prop, naming the prop and the primitive", () => {
    // Deliberately NOT `Text` — it declares `passthrough: true`, so unknown props are legitimate there
    // (that is the very next test). Pick a primitive that does not, so the check is actually exercised.
    const strict = UI_KIT.find((p) => !p.passthrough && p.props.length > 0);
    expect(strict, "the manifest should have at least one non-passthrough primitive").toBeTruthy();
    const required = Object.fromEntries(
      strict!.props.filter((p) => p.required).map((p) => [p.name, p.type === "node" ? "x" : "x"]),
    );
    const errs = validateGeneralNode({ type: strict!.name, props: { ...required, nonsense: 1 } });
    expect(errs.some((e) => e.includes("nonsense") && e.includes(strict!.name))).toBe(true);
  });

  it("rejects an out-of-union enum value and lists the allowed set", () => {
    const errs = validateGeneralNode(text({ tone: "chartreuse" }));
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("chartreuse");
    expect(errs[0]).toContain("dim"); // the allowed values are reported, not just "invalid"
  });

  it("accepts an in-union enum value", () => {
    expect(validateGeneralNode(text({ tone: "accent" }))).toEqual([]);
  });

  it("rejects scalar type mismatches", () => {
    expect(validateGeneralNode(text({ mono: "yes" }))[0]).toContain("expected a boolean");
    expect(validateGeneralNode(text({ weight: "600" }))[0]).toContain("expected a number");
  });

  it("treats an absent optional prop as fine — the component's default applies", () => {
    expect(validateGeneralNode(text())).toEqual([]);
    expect(validateGeneralNode({ type: "Text", children: "x" })).toEqual([]);
  });

  it("reports a genuinely missing REQUIRED prop", () => {
    // The counterpart to the above: `children` is required on Text, so omitting it is an error —
    // this is what caught several of this file's own first-draft fixtures.
    const errs = validateGeneralNode({ type: "Text" });
    expect(errs.some((e) => e.includes("missing required prop") && e.includes("children"))).toBe(true);
  });

  it("requires a handler to be an ACTION NAME, never an inline function", () => {
    // Stricter than a type check, and the more meaningful rule: a tree carrying a function has
    // stopped being data. Find a primitive with a function prop rather than hardcoding one.
    const withFn = UI_KIT.find((p) => p.props.some((x) => x.type === "function"));
    expect(withFn, "the manifest should have at least one function prop").toBeTruthy();
    const fnProp = withFn!.props.find((x) => x.type === "function")!;

    const bad = validateGeneralNode({ type: withFn!.name, props: { [fnProp.name]: () => {} } });
    expect(bad.some((e) => e.includes("action NAME"))).toBe(true);

    const good = validateGeneralNode({ type: withFn!.name, props: { [fnProp.name]: "openWorker" } });
    expect(good.filter((e) => e.includes(fnProp.name))).toEqual([]);
  });

  it("does not flag unknown props on a passthrough primitive", () => {
    // A passthrough primitive forwards arbitrary DOM props to its root BY DESIGN, so flagging them
    // would be a false positive — and a validator that cries wolf gets ignored.
    const pass = UI_KIT.find((p) => p.passthrough);
    expect(pass, "the manifest should have at least one passthrough primitive").toBeTruthy();
    const errs = validateGeneralNode({ type: pass!.name, props: { "data-testid": "x", className: "y" } });
    expect(errs.filter((e) => e.includes("unknown prop"))).toEqual([]);
  });
});

describe("children + slots (#3485)", () => {
  it("recurses into children and reports the failing path", () => {
    const tree: GeneralNode = {
      type: "Stack",
      children: [text({ tone: "nope" })],
    };
    const errs = validateGeneralNode(tree);
    expect(errs).toHaveLength(1);
    // The path points at where the author WROTE it (node-level children), not the normalised form.
    expect(errs[0]).toContain("$.children[0].props.tone");
  });

  it("accepts node-level children as sugar for the children PROP", () => {
    // The manifest models children as a required `node` prop on containers (as React does). Authoring
    // it at the node level must validate identically — otherwise every container would need
    // `props: { children: [...] }` and a bare `children` would read as "missing required prop".
    expect(validateGeneralNode({ type: "Stack", children: [text()] })).toEqual([]);
    expect(validateGeneralNode({ type: "Stack", props: { children: [text()] } })).toEqual([]);
  });

  it("rejects children entries that are neither nodes nor text", () => {
    // A string IS valid (text content), so the check is 'node-like or text', not 'must be an array'.
    expect(validateGeneralNode({ type: "Stack", children: "just text" })).toEqual([]);
    expect(
      validateGeneralNode({ type: "Stack", children: [42, true] }).some((e) => e.includes("expected nodes or text")),
    ).toBe(true);
  });

  it("accepts text or a node in a node-typed slot, and recurses into the node", () => {
    const withNode = UI_KIT.find((p) => p.props.some((x) => x.type === "node"));
    expect(withNode).toBeTruthy();
    const slot = withNode!.props.find((x) => x.type === "node")!;

    // Plain text is a legitimate slot value.
    expect(
      validateGeneralNode({ type: withNode!.name, props: { [slot.name]: "hello" } })
        .filter((e) => e.includes(slot.name)),
    ).toEqual([]);

    // A node in the slot is validated too — the error path points INTO the slot.
    const errs = validateGeneralNode({
      type: withNode!.name,
      props: { [slot.name]: { type: "Text", props: { tone: "bogus" } } },
    });
    expect(errs.some((e) => e.includes(`props.${slot.name}`) && e.includes("bogus"))).toBe(true);
  });
});

describe("stated coverage — the gaps are documented, not hidden (#3485)", () => {
  it("publishes a verdict for every PropType the manifest actually uses", () => {
    const used = new Set(UI_KIT.flatMap((p) => p.props.map((x) => x.type)));
    for (const t of used) {
      expect(VALIDATION_COVERAGE[t], `PropType "${t}" must declare its coverage`).toBeTruthy();
    }
  });

  it("checks the CONTAINER of array/object props but deliberately not their contents", () => {
    // This is the honest gap: the manifest keeps element/field shapes in prose, so there is no schema
    // to check against. Asserting it here means a future change that quietly starts claiming more —
    // or silently checks less — has to confront this test.
    expect(VALIDATION_COVERAGE.array).toBe("container-only");
    expect(VALIDATION_COVERAGE.object).toBe("container-only");
    expect(VALIDATION_COVERAGE.style).toBe("container-only");

    const withArray = UI_KIT.find((p) => p.props.some((x) => x.type === "array"));
    if (withArray) {
      const arrProp = withArray.props.find((x) => x.type === "array")!;
      // Wrong container ⇒ caught.
      expect(
        validateGeneralNode({ type: withArray.name, props: { [arrProp.name]: "not-a-list" } })
          .some((e) => e.includes("expected an array")),
      ).toBe(true);
      // Right container, garbage contents ⇒ NOT caught, and that is the documented limit.
      expect(
        validateGeneralNode({ type: withArray.name, props: { [arrProp.name]: [{ total: "nonsense" }] } })
          .filter((e) => e.includes(arrProp.name)),
      ).toEqual([]);
    }
  });
});
