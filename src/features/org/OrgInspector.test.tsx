import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { OrgInspector } from "./OrgInspector";
import { RELATIONSHIP_ARCHETYPES, type Org } from "./lib/org";

const org: Org = {
  id: "o1",
  name: "Test org",
  positions: [
    { nodeId: "n1", kind: "resource", label: "Widget store" },
    { nodeId: "n2", kind: "resource", label: "Ledger" },
  ],
  relationships: [{ id: "r1", archetype: RELATIONSHIP_ARCHETYPES[0].id, from: "n1", to: "n2" }],
};

const baseProps = {
  org, orgs: [org], personas: [],
  onSelectNode: () => {}, onChangeArchetype: () => {}, onChangePersona: () => {}, onChangeLabel: () => {},
};

describe("OrgInspector — manual delete overrides (#2383)", () => {
  it("deletes the selected position via the two-step confirm (cascades to its relationships)", () => {
    const onDeletePosition = vi.fn();
    render(
      <OrgInspector {...baseProps} sel={{ type: "node", id: "n1" }}
        onDeletePosition={onDeletePosition} onDeleteRelationship={() => {}} />,
    );
    const btn = screen.getByRole("button", { name: /Delete position/ });
    fireEvent.click(btn);             // arms
    expect(onDeletePosition).not.toHaveBeenCalled();
    fireEvent.click(btn);             // confirms
    expect(onDeletePosition).toHaveBeenCalledWith("n1");
  });

  it("deletes the selected relationship via the two-step confirm", () => {
    const onDeleteRelationship = vi.fn();
    render(
      <OrgInspector {...baseProps} sel={{ type: "edge", id: "r1" }}
        onDeletePosition={() => {}} onDeleteRelationship={onDeleteRelationship} />,
    );
    const btn = screen.getByRole("button", { name: /Delete relationship/ });
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(onDeleteRelationship).toHaveBeenCalledWith("r1");
  });
});
