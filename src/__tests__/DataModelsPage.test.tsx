import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DataModelsPage } from "../screens/projects/DataModelsPage";
import { seedDataModels } from "../screens/projects/dataModel";
import { useAppStore } from "../store";

describe("DataModelsPage (#780)", () => {
  beforeEach(() => {
    useAppStore.setState({ dataModels: seedDataModels(), activeDataModelId: "dm-crm" });
  });

  it("renders the library + editor for the active model", () => {
    render(<DataModelsPage />);
    // library entry + editor name field
    expect(screen.getByText("CRM Core")).toBeInTheDocument();
    expect((screen.getByLabelText("Model name") as HTMLInputElement).value).toBe("CRM Core");
    // the seeded entities show as editable keys
    const keys = screen.getAllByLabelText("Entity key").map((i) => (i as HTMLInputElement).value);
    expect(keys).toEqual(expect.arrayContaining(["account", "contact"]));
  });

  it("adds an entity through the store", () => {
    render(<DataModelsPage />);
    fireEvent.click(screen.getByText(/Add entity/i));
    const model = useAppStore.getState().dataModels.find((m) => m.id === "dm-crm")!;
    expect(model.entities).toHaveLength(3);
    expect(model.entities[2].key).toBe("entity3");
  });

  it("creates a new model via the library", () => {
    const before = useAppStore.getState().dataModels.length;
    render(<DataModelsPage />);
    fireEvent.click(screen.getByText(/New model/i));
    expect(useAppStore.getState().dataModels.length).toBe(before + 1);
  });

  it("offers a Load CSV action per entity, enabled for a valid model", () => {
    render(<DataModelsPage />);
    const loadButtons = screen.getAllByText("Load CSV") as HTMLButtonElement[];
    expect(loadButtons).toHaveLength(2); // account + contact
    expect(loadButtons.every((b) => !b.disabled)).toBe(true);
  });

  it("disables Load CSV when the model has validation problems", () => {
    // a model with an unsafe entity key can't be loaded (the store rejects the identifier)
    useAppStore.setState({
      dataModels: [{ id: "bad", name: "Bad", version: 1, entities: [{ key: "bad-key", label: "", identity: [], fields: [{ key: "id", type: "string" }] }] }],
      activeDataModelId: "bad",
    });
    render(<DataModelsPage />);
    expect((screen.getByText("Load CSV") as HTMLButtonElement).disabled).toBe(true);
  });
});
