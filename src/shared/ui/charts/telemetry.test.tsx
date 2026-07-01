import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TelemetryPanel, ItemBars, SplitBar } from "./telemetry";

describe("telemetry primitives (#1826)", () => {
  it("TelemetryPanel renders the title, hint, right slot, and body", () => {
    render(
      <TelemetryPanel title="Calls per server" hint="per server" right={<span>legend</span>}>
        <span>body</span>
      </TelemetryPanel>,
    );
    expect(screen.getByText("Calls per server")).toBeInTheDocument();
    expect(screen.getByText("per server")).toBeInTheDocument();
    expect(screen.getByText("legend")).toBeInTheDocument();
    expect(screen.getByText("body")).toBeInTheDocument();
  });

  it("ItemBars renders a row per item, and the empty slot when there are none", () => {
    const { rerender } = render(
      <ItemBars rows={[{ key: "a", label: "server-a", meta: "http", value: 12, fraction: 0.5 }]} />,
    );
    expect(screen.getByText("server-a")).toBeInTheDocument();
    expect(screen.getByText("http")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();

    rerender(<ItemBars rows={[]} empty={<span>nothing here</span>} />);
    expect(screen.getByText("nothing here")).toBeInTheDocument();
  });

  it("SplitBar shows the label + both labelled counts", () => {
    render(<SplitBar label="db" a={7} b={2} aLabel="ok" bLabel="err" />);
    expect(screen.getByText("db")).toBeInTheDocument();
    expect(screen.getByText("7 ok")).toBeInTheDocument();
    expect(screen.getByText("2 err")).toBeInTheDocument();
  });
});
