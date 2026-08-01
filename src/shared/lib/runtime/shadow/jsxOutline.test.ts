// The JSX outline scanner (#4169) — it is a LEXICAL approximation, so what it must get right is pinned
// here: the shapes real page sources are written in, and the shapes that look like JSX and are not.
import { describe, it, expect } from "vitest";
import { outlineJsx, outlinePaths, countNodes } from "./jsxOutline";

describe("outlineJsx", () => {
  it("builds the nesting, not just a tag list", () => {
    const tree = outlineJsx(`export function P() { return <Screen><TabBar /><Body><Chip /></Body></Screen>; }`);
    expect(outlinePaths(tree)).toEqual(["Screen", "Screen>TabBar", "Screen>Body", "Screen>Body>Chip"]);
    expect(countNodes(tree)).toBe(4);
  });

  it("counts a fragment as a node — dropping a wrapper changes the tree", () => {
    expect(outlinePaths(outlineJsx(`const a = <><Row /></>;`))).toEqual(["Fragment", "Fragment>Row"]);
  });

  it("handles intrinsics, dotted tags and multi-line attributes", () => {
    const tree = outlineJsx(`
      const el = (
        <div
          className="wrap"
          onClick={() => setOpen(true)}
        >
          <Icon.Chevron size={12} />
        </div>
      );
    `);
    expect(outlinePaths(tree)).toEqual(["div", "div>Icon.Chevron"]);
  });

  it("does NOT read a comparison, a generic call or a type argument as an element", () => {
    // The whole reason the scanner consults the preceding token outside an element.
    const src = `
      const bigger = a < b && c > d;
      const [x, setX] = useState<Foo>(null);
      const m = new Map<string, Row>();
      function f(): Array<Item> { return []; }
    `;
    expect(outlineJsx(src)).toEqual([]);
  });

  it("ignores JSX written inside comments and strings", () => {
    const src = `
      // <FakeInComment />
      /* <AlsoFake /> */
      const label = "<NotATag />";
      const tpl = \`<AlsoNot />\`;
      const real = <Real />;
    `;
    expect(outlinePaths(outlineJsx(src))).toEqual(["Real"]);
  });

  it("finds JSX inside an attribute expression and attaches it to the owning element", () => {
    // Render props are where a tab body's real content often lives — drift there must not be invisible.
    const tree = outlineJsx(`const el = <Table renderRow={(r) => <Row key={r.id}><Cell /></Row>} />;`);
    expect(outlinePaths(tree)).toEqual(["Table", "Table>Row", "Table>Row>Cell"]);
  });

  it("reads JSX after an arrow, a return, a ternary and a logical guard", () => {
    const src = `
      const a = () => <A />;
      function b() { return <B />; }
      const c = cond ? <C /> : <D />;
      const e = <Wrap>{ok && <E />}</Wrap>;
    `;
    expect(outlinePaths(outlineJsx(src)).sort()).toEqual(["A", "B", "C", "D", "Wrap", "Wrap>E"]);
  });

  it("keeps siblings flat when an element self-closes", () => {
    const tree = outlineJsx(`const el = <Row><A /><B /><C /></Row>;`);
    expect(outlinePaths(tree)).toEqual(["Row", "Row>A", "Row>B", "Row>C"]);
  });
});
