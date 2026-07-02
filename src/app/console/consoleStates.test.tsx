// #2128 — render smoke + interaction tests for the console pane placeholder states extracted from
// console/index.tsx. Each renders its message and fires its single action callback.
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DisabledConsole, EndedConsole, DormantConsole } from "./consoleStates";

describe("console pane placeholder states (#2128)", () => {
  it("DisabledConsole shows the stopped message and enables on click", () => {
    const onEnable = vi.fn();
    render(<DisabledConsole onEnable={onEnable} />);
    expect(screen.getByText(/console disabled/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /enable/i }));
    expect(onEnable).toHaveBeenCalledOnce();
  });

  it("DormantConsole shows the reaped message and resumes on click", () => {
    const onResume = vi.fn();
    render(<DormantConsole onResume={onResume} />);
    expect(screen.getByText(/session dormant/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /resume/i }));
    expect(onResume).toHaveBeenCalledOnce();
  });

  it("EndedConsole renders the state label + summary and reopens on click", () => {
    const onReopen = vi.fn();
    render(<EndedConsole info={{ state: "done", summary: "shipped the thing", streamId: "s1", at: 0 }} onReopen={onReopen} />);
    expect(screen.getByText(/finished/i)).toBeInTheDocument();
    expect(screen.getByText("shipped the thing")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /reopen/i }));
    expect(onReopen).toHaveBeenCalledOnce();
  });

  it("EndedConsole reflects the blocked state", () => {
    render(<EndedConsole info={{ state: "blocked", summary: "tests failing", streamId: "s1", at: 0 }} onReopen={() => {}} />);
    expect(screen.getByText(/blocked \/ failed/i)).toBeInTheDocument();
  });
});
