import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { FocusedSourceBody } from "../screens/planner/bodies/FocusedSourceBody";

// setup.ts already provides a global invoke mock (mockResolvedValue(null));
// override per-test with mockResolvedValueOnce.

const MOCK_INVENTORY = [{ name: "accounts", columns: ["id", "name", "revenue"] }];
const MOCK_MODEL = {
  name: "test-project",
  version: 1,
  entities: [
    {
      key: "accounts",
      label: "accounts",
      identity: ["id"],
      fields: [
        { key: "id",      label: "id",      type: "string", required: false, enum_values: [] },
        { key: "name",    label: "name",    type: "string", required: false, enum_values: [] },
        { key: "revenue", label: "revenue", type: "money",  required: false, enum_values: [] },
      ],
    },
  ],
};

describe("FocusedSourceBody — render", () => {
  it("renders the connector picker and skip button by default", () => {
    render(<FocusedSourceBody projectId="proj-1" />);
    expect(screen.getByTestId("pick-csv-btn")).toBeTruthy();
    expect(screen.getByTestId("skip-source-btn")).toBeTruthy();
  });

  it("shows the skipped state when Skip is clicked", async () => {
    render(<FocusedSourceBody projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("skip-source-btn"));
    await waitFor(() => expect(screen.getByTestId("source-skipped")).toBeTruthy());
  });

  it("allows re-connecting after skipping", async () => {
    render(<FocusedSourceBody projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("skip-source-btn"));
    await waitFor(() => screen.getByTestId("source-skipped"));
    fireEvent.click(screen.getByText("Connect a source"));
    await waitFor(() => expect(screen.getByTestId("pick-csv-btn")).toBeTruthy());
  });
});

describe("FocusedSourceBody — CSV flow", () => {
  beforeEach(() => {
    vi.mocked(invoke)
      // pick_csv_file
      .mockResolvedValueOnce("/tmp/accounts.csv")
      // data_source_inventory
      .mockResolvedValueOnce(MOCK_INVENTORY)
      // data_infer_model
      .mockResolvedValueOnce(MOCK_MODEL);
  });

  it("loads and displays inferred model after picking a CSV", async () => {
    render(<FocusedSourceBody projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("pick-csv-btn"));

    // Wait until all three field rows are visible (model is rendered)
    await waitFor(() => expect(screen.getByTestId("field-row-accounts-id")).toBeTruthy());
    expect(screen.getByTestId("field-row-accounts-name")).toBeTruthy();
    expect(screen.getByTestId("field-row-accounts-revenue")).toBeTruthy();
    // Confirm button should be available
    expect(screen.getByTestId("confirm-model-btn")).toBeTruthy();
  });
});

describe("FocusedSourceBody — refine interaction", () => {
  beforeEach(() => {
    vi.mocked(invoke)
      .mockResolvedValueOnce("/tmp/accounts.csv") // pick_csv_file
      .mockResolvedValueOnce(MOCK_INVENTORY)       // data_source_inventory
      .mockResolvedValueOnce(MOCK_MODEL);           // data_infer_model
  });

  it("persists the model as refined when Confirm is clicked", async () => {
    // After loading, data_persist_model call:
    vi.mocked(invoke).mockResolvedValueOnce(undefined);

    render(<FocusedSourceBody projectId="proj-1" />);
    fireEvent.click(screen.getByTestId("pick-csv-btn"));

    await waitFor(() => screen.getByTestId("confirm-model-btn"));
    fireEvent.click(screen.getByTestId("confirm-model-btn"));

    await waitFor(() => expect(screen.getByTestId("saved-msg")).toBeTruthy());

    // Verify data_persist_model was called with refined=true
    const calls = vi.mocked(invoke).mock.calls;
    const persistCall = calls.find((c) => c[0] === "data_persist_model");
    expect(persistCall).toBeTruthy();
    expect((persistCall![1] as Record<string, unknown>).refined).toBe(true);
    expect((persistCall![1] as Record<string, unknown>).projectKey).toBe("proj-1");
  });
});
