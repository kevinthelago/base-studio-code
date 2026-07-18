// TeamsCanvas — the agent node card (#3335). A persona `blurb` of ANY length must stay inside the
// fixed NODE_SIZE.agent box; before the fix a ~160-char blurb (the librarian's) spilled out of it.
//
// The clamp is CSS (a 4-line `-webkit-box`) and jsdom does no layout, so what these tests pin is the
// MECHANISM rather than a measured pixel height: the node box is a fixed size a long blurb cannot
// grow, the blurb element carries the line-clamp + `overflow:hidden` that bounds it, and the box is
// arithmetically tall enough for the header plus every clamped line. The full text stays in the DOM
// (and in the inspector's PersonaEditor) — the truncation is purely visual, by design.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TeamsCanvas } from "./TeamsCanvas";
import { NODE_SIZE } from "./lib/orgLayout";
import type { Team } from "./lib/team";
import type { Persona } from "@/features/personas";

const SHORT = "Coordinates the fleet.";
// The real librarian blurb (155 chars) — the overflow the issue reported.
const LONG =
  "Stores and curates the algorithms library from the Algorithms tab — the per-language implementations, their kinds, and their visualizations, via bsc graph.";

const persona = (blurb: string): Persona => ({
  id: "p1", name: "Librarian", blurb, role: "worker", startPrompt: "", skills: [],
});

const team = (): Team => ({
  id: "t1",
  name: "T",
  positions: [{ nodeId: "n1", kind: "agent", personaId: "p1", x: 40, y: 60 }],
  relationships: [],
});

/** Render one agent node carrying `blurb`; returns the blurb element + its [data-node] card. */
function renderAgent(blurb: string) {
  render(
    <TeamsCanvas
      org={team()}
      personas={[persona(blurb)]}
      sel={{ type: "node", id: "" }}
      scale={1}
      connecting={false}
      dragMoved={{ current: false }}
      onSelectNode={() => {}}
      onSelectEdge={() => {}}
      onMoveNode={() => {}}
    />,
  );
  const el = screen.getByText(blurb);
  return { el, node: el.closest("[data-node]") as HTMLElement };
}

describe("AgentFace blurb clamp (#3335)", () => {
  it("a long blurb never grows the node box past NODE_SIZE.agent", () => {
    const { node } = renderAgent(LONG);
    expect(node.style.width).toBe(`${NODE_SIZE.agent.w}px`);
    expect(node.style.height).toBe(`${NODE_SIZE.agent.h}px`);
  });

  it("a long blurb is clamped to 4 lines and cannot overflow the card", () => {
    const { el } = renderAgent(LONG);
    expect(el.style.display).toBe("-webkit-box");
    expect(el.style.getPropertyValue("-webkit-line-clamp")).toBe("4");
    expect(el.style.getPropertyValue("-webkit-box-orient")).toBe("vertical");
    expect(el.style.overflow).toBe("hidden"); // the ellipsis + the hard bound
  });

  it("keeps the FULL blurb text in the DOM — the clamp is visual, the inspector still shows it all", () => {
    const { el } = renderAgent(LONG);
    expect(el.textContent).toBe(LONG); // never JS-truncated
  });

  it("a short blurb is untouched — same box, same text, no injected ellipsis", () => {
    const { el, node } = renderAgent(SHORT);
    expect(el.textContent).toBe(SHORT);
    expect(el.textContent).not.toContain("…");
    expect(node.style.width).toBe(`${NODE_SIZE.agent.w}px`);
    expect(node.style.height).toBe(`${NODE_SIZE.agent.h}px`);
  });

  // The vertical budget, from AgentFace's own numbers — so shrinking NODE_SIZE.agent.h (or raising
  // the clamp) without re-checking the other trips this rather than silently re-opening the overflow.
  it("the agent box is tall enough for the header + every clamped blurb line", () => {
    const cardPaddingY = 10 * 2;      // AgentFace padding "10px 12px"
    const nameRowH = 20;              // the role Chip: 9.5px text + 3px padding + 1px border, per side
    const blurbMarginTop = 2;
    const blurbLineH = 10.5 * 1.3;    // blurb font-size × line-height
    const needed = cardPaddingY + nameRowH + blurbMarginTop + 4 * blurbLineH;
    expect(NODE_SIZE.agent.h).toBeGreaterThanOrEqual(needed);
  });
});
