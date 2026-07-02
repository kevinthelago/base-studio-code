import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TargetSelector } from "./TargetSelector";

const repos = [
  { full_name: "octo/one", local_path: "/base/one" },
  { full_name: "octo/two", local_path: "/base/two" },
];

describe("TargetSelector", () => {
  it("renders the global chip plus a chip per repo", () => {
    render(<TargetSelector allRepos={repos} target="global" setTarget={() => {}} />);
    expect(screen.getByText("global (~/.claude/)")).toBeInTheDocument();
    expect(screen.getByText("octo/one")).toBeInTheDocument();
    expect(screen.getByText("octo/two")).toBeInTheDocument();
  });

  it("shows the empty hint when there are no repos", () => {
    render(<TargetSelector allRepos={[]} target="global" setTarget={() => {}} />);
    expect(screen.getByText(/Resolve repositories on the Projects board/)).toBeInTheDocument();
  });

  it("calls setTarget with the repo's local_path when a chip is clicked", () => {
    const setTarget = vi.fn();
    render(<TargetSelector allRepos={repos} target="global" setTarget={setTarget} />);
    fireEvent.click(screen.getByText("octo/two"));
    expect(setTarget).toHaveBeenCalledWith("/base/two");
  });
});
