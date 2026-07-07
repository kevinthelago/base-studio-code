// TablePage (#2505) — the table-shaped page composition: columnar rows from typed columns × rows,
// selection driving the KeyValueList record detail, empty states, and both selection modes.
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TablePage, type TablePageColumn, type TablePageRow } from "./TablePage";

const COLUMNS: TablePageColumn[] = [
  { key: "name", label: "Session" },
  { key: "state", label: "State", width: "90px" },
];
const ROWS: TablePageRow[] = [
  { id: "a", cells: { name: "planner", state: "run" } },
  { id: "b", cells: { name: "worker-api", state: "idle" } },
];

describe("TablePage — rendering from typed columns × rows", () => {
  it("renders the header labels and one aligned row per record, sharing the column template", () => {
    const { container } = render(<TablePage title="Sessions" columns={COLUMNS} rows={ROWS} />);
    expect(screen.getByText("Session")).toBeInTheDocument();
    expect(screen.getByText("State")).toBeInTheDocument();
    const rows = container.querySelectorAll(".dt-row");
    expect(rows).toHaveLength(2);
    const header = container.querySelector(".dt-header") as HTMLElement;
    expect(header.style.gridTemplateColumns).toBe("1fr 90px");
    expect((rows[0] as HTMLElement).style.gridTemplateColumns).toBe("1fr 90px");
    expect(screen.getByText("worker-api")).toBeInTheDocument();
  });

  it("shows the page title, hint, row count, and the toolbar slot in the header bar", () => {
    render(<TablePage title="Sessions" hint="today" toolbar={<button>filter</button>} columns={COLUMNS} rows={ROWS} />);
    expect(screen.getByText("Sessions")).toBeInTheDocument();
    expect(screen.getByText("today")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "filter" })).toBeInTheDocument();
  });

  it("renders empty states for zero rows and for no selection", () => {
    render(<TablePage title="Sessions" columns={COLUMNS} rows={[]} />);
    expect(screen.getByText("No records")).toBeInTheDocument();
    expect(screen.getByText("No record selected")).toBeInTheDocument();
  });
});

describe("TablePage — selection drives the detail", () => {
  it("uncontrolled: clicking a row selects it and renders its cells as a KeyValueList detail", () => {
    const onSelect = vi.fn();
    const { container } = render(<TablePage title="Sessions" columns={COLUMNS} rows={ROWS} onSelect={onSelect} />);
    fireEvent.click(container.querySelectorAll(".dt-row")[1]);
    expect(onSelect).toHaveBeenCalledWith("b");
    expect(container.querySelectorAll(".dt-row.selected")).toHaveLength(1);
    // The default detail: the first cell as heading + label:value rows from the columns.
    expect(screen.getAllByText("worker-api").length).toBeGreaterThan(1); // cell + detail heading + kv value
    expect(screen.getAllByText("State").length).toBeGreaterThan(1);      // header + kv label
  });

  it("uncontrolled: defaultSelectedId seeds the initial detail", () => {
    render(<TablePage title="Sessions" columns={COLUMNS} rows={ROWS} defaultSelectedId="a" />);
    expect(screen.queryByText("No record selected")).toBeNull();
    expect(screen.getAllByText("planner").length).toBeGreaterThan(1);
  });

  it("controlled: selectedId drives the detail; a click only fires onSelect (no internal takeover)", () => {
    const onSelect = vi.fn();
    const { container } = render(
      <TablePage title="Sessions" columns={COLUMNS} rows={ROWS} selectedId="a" onSelect={onSelect} />,
    );
    fireEvent.click(container.querySelectorAll(".dt-row")[1]);
    expect(onSelect).toHaveBeenCalledWith("b");
    // Still row "a" selected — the parent owns the state.
    expect(container.querySelectorAll(".dt-row")[0].className).toContain("selected");
    expect(container.querySelectorAll(".dt-row")[1].className).not.toContain("selected");
  });

  it("detail render-prop overrides the default KeyValueList", () => {
    render(<TablePage title="Sessions" columns={COLUMNS} rows={ROWS} defaultSelectedId="b"
      detail={(r) => <span>CUSTOM:{r.id}</span>} />);
    expect(screen.getByText("CUSTOM:b")).toBeInTheDocument();
  });
});
