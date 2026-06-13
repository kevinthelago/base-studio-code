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
});
