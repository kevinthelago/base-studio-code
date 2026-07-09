import { describe, it, expect } from "vitest";
import { BUILTIN_ORGS, type Team } from "./team";
import { positionDisplay, positionComms, tierChips, formArrow, formColor } from "./orgView";
import { formById } from "./team";
import type { Persona } from "@/features/personas";

const personas: Persona[] = [
  { id: "persona-director", name: "Director", blurb: "Coordinates.", role: "director", startPrompt: "", skills: [] },
  { id: "persona-worker", name: "Worker", blurb: "Builds.", role: "worker", startPrompt: "", skills: [] },
];

describe("positionDisplay (#2193)", () => {
  it("reads an agent's name/role/dept through its persona, honoring a node label override", () => {
    const pos = { nodeId: "worker-a", kind: "agent" as const, personaId: "persona-worker", label: "Engineer A" };
    const d = positionDisplay(pos, personas);
    expect(d.name).toBe("Engineer A");       // label override wins
    expect(d.role).toBe("worker");
    expect(d.dept).toBe("Engineering");
  });

  it("gives resource/external nodes their own dept + glyph, no role", () => {
    const ext = positionDisplay({ nodeId: "c", kind: "external", label: "Customer" }, personas);
    expect(ext.name).toBe("Customer");
    expect(ext.dept).toBe("External");
    expect(ext.glyph).toBe("◍");   // its own kind glyph, not a role glyph
    expect(ext.role).toBeUndefined(); // non-agent nodes carry no role tag
    expect(positionDisplay({ nodeId: "r", kind: "resource", label: "Commons" }, personas).dept).toBe("Resource");
  });
});

describe("tierChips (#2193)", () => {
  it("lists a role's non-none capabilities + net on/off", () => {
    const labels = tierChips("director").map((t) => t.label);
    expect(labels).toContain("git·write");
    expect(labels.some((l) => l.startsWith("net·"))).toBe(true);
    // A read-only role shows no write tier.
    expect(tierChips("reviewer").every((t) => t.tier !== "write")).toBe(true);
  });
});

describe("positionComms (#2193)", () => {
  const fleet = BUILTIN_ORGS.find((o) => o.id === "org-default-fleet")!;

  it("groups a position's derived forms into one summary per relationship", () => {
    const comms = positionComms(fleet, fleet.positions.find((p) => p.nodeId === "director")!, personas);
    // The director has one summary per edge it's on, each with a counterpart + form lanes.
    expect(comms.length).toBeGreaterThan(0);
    const toWorkerA = comms.find((c) => c.counterpartNode === "worker-a");
    expect(toWorkerA?.archetype).toBe("manages");
    expect(toWorkerA?.sends.map((f) => f.id)).toContain("directive"); // manager sends directives down
  });
});

describe("form presentation helpers (#2193)", () => {
  it("formArrow reflects direction; the review gate is its own glyph", () => {
    expect(formArrow(formById("directive")!)).toBe("↓");
    expect(formArrow(formById("escalation")!)).toBe("↑");
    expect(formArrow(formById("review")!)).toBe("⊘");
  });
  it("formColor is neutral for a plain report, non-neutral for an authoritative directive", () => {
    expect(formColor(formById("report")!)).toBe("var(--fg-dim)");
    expect(formColor(formById("directive")!)).not.toBe("var(--fg-dim)");
  });
});

// A hand-built org with an unplaced/labelless node still renders without throwing.
describe("positionDisplay resilience", () => {
  it("falls back to the nodeId when a persona is missing", () => {
    const org: Team = { id: "x", name: "x", positions: [{ nodeId: "ghost", kind: "agent", personaId: "nope" }], relationships: [] };
    expect(positionDisplay(org.positions[0], personas).name).toBe("ghost");
  });
});
