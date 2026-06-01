import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, fireEvent, within } from "@testing-library/react";
import { PipelinesLane } from "../screens/projects/PipelinesLane";
import { useAppStore } from "../store";
import { PIPELINE_PRESETS } from "../lib/pipeline";
import type { PipelineRun } from "../lib/conductor";

/**
 * #370 — the Pipelines lane is the per-item observability board: it shows which stage each
 * in-flight run is in, the full stage sequence with attempt counts, status, and any
 * escalation, and lets you start/clear runs. Runs come from the store; here we drive both
 * the render (seeded runs) and the interactions (start via button/Enter, clear).
 */
const PRESET = "implement-test-review-integrate";

/** A run parked mid-pipeline with `build-test` retried once (attempts ×2). */
function midRun(item: string): PipelineRun {
  return {
    pipeline: PIPELINE_PRESETS[PRESET],
    state: {
      item,
      stage: "build-test",
      status: "active",
      attempts: { implement: 1, "build-test": 2 },
      history: [{ stage: "implement", outcome: "success" }],
    },
  };
}

describe("PipelinesLane (#370)", () => {
  beforeEach(() => {
    useAppStore.setState({
      tabs: [{ name: "w", layout: "1×1", state: "idle" as const }],
      activeTabIdx: 0,
      pipelineRuns: {},
      activeProjectName: "",
    });
  });
  afterEach(() => {
    useAppStore.setState({ pipelineRuns: {} });
  });

  it("renders the empty-state hint and disables Start until a work item is typed", () => {
    const { getByText, getByPlaceholderText, getByRole } = render(<PipelinesLane />);
    expect(getByText(/No pipeline runs/i)).toBeTruthy();
    const start = getByRole("button", { name: "Start" }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    fireEvent.change(getByPlaceholderText(/work item/i), { target: { value: "#42" } });
    expect(start.disabled).toBe(false);
  });

  it("shows each run's stage sequence with the current stage flagged and attempt counts", () => {
    useAppStore.setState({ pipelineRuns: { "#42": midRun("#42") } });
    const { getByText, container } = render(<PipelinesLane />);
    // the run id + its status surface
    expect(getByText("#42")).toBeTruthy();
    expect(getByText(/● active/)).toBeTruthy();
    expect(getByText("1 active")).toBeTruthy();
    // every stage of the preset is rendered, in order
    const board = container.textContent ?? "";
    for (const name of ["implement", "build-test", "review", "integrate"]) {
      expect(board).toContain(name);
    }
    // the retried current stage shows its ×2 attempt count
    expect(getByText(/×2/)).toBeTruthy();
  });

  it("surfaces the escalation reason when a run has escalated", () => {
    useAppStore.setState({
      pipelineRuns: {
        "#7": {
          pipeline: PIPELINE_PRESETS[PRESET],
          state: { item: "#7", stage: null, status: "escalated", attempts: {}, history: [], escalation: "build-test exceeded retryLimit (3)" },
        },
      },
    });
    const { getByText } = render(<PipelinesLane />);
    expect(getByText(/● escalated/)).toBeTruthy();
    expect(getByText(/exceeded retryLimit/)).toBeTruthy();
  });

  it("starts a run from the chosen preset when Start is clicked, then clears it", () => {
    const { getByPlaceholderText, getByRole, queryByText, container } = render(<PipelinesLane />);
    fireEvent.change(getByPlaceholderText(/work item/i), { target: { value: "#99" } });
    fireEvent.click(getByRole("button", { name: "Start" }));

    expect(useAppStore.getState().pipelineRuns["#99"]).toBeTruthy();
    const card = within(container).getByText("#99").closest(".card") as HTMLElement;
    // the freshly-started run sits at the pipeline's first stage
    expect(useAppStore.getState().pipelineRuns["#99"].state.stage).toBe(PIPELINE_PRESETS[PRESET].start);

    fireEvent.click(within(card).getByText("clear"));
    expect(useAppStore.getState().pipelineRuns["#99"]).toBeUndefined();
    expect(queryByText("#99")).toBeNull();
  });

  it("starts a run on Enter in the work-item field", () => {
    const { getByPlaceholderText } = render(<PipelinesLane />);
    const input = getByPlaceholderText(/work item/i);
    fireEvent.change(input, { target: { value: "#5" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useAppStore.getState().pipelineRuns["#5"]).toBeTruthy();
  });
});
