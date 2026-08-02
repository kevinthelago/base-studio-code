import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { PullIntoPlanControl } from "./PullIntoPlanControl";
import type { PlanFeature } from "@/features/planner/issues/featureList";

const mockInvoke = vi.mocked(invoke);

const feat = (slug: string, name: string, requires: string[] = []): PlanFeature =>
  ({ slug, name, requires } as PlanFeature);

beforeEach(() => {
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue("");
});

describe("PullIntoPlanControl (#4267)", () => {
  it("records the edge on the chosen feature", async () => {
    render(
      <PullIntoPlanControl
        projectKey="proj"
        features={[feat("geometry-kernel", "Geometry kernel"), feat("sketcher", "Sketcher")]}
        artifactId="merge.rs"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Sketcher/ }));
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("bsc", {
        projectKey: "proj",
        args: ["plan", "feature", "add"],
        stdin: JSON.stringify({ slug: "sketcher", requires: ["merge.rs"] }),
      }),
    );
  });

  it("shows what the plan already draws on, and won't re-write it", () => {
    render(
      <PullIntoPlanControl
        projectKey="proj"
        features={[feat("geometry-kernel", "Geometry kernel", ["merge.rs"])]}
        artifactId="merge.rs"
      />,
    );
    const btn = screen.getByRole("button", { name: /Geometry kernel/ });
    expect(btn).toBeDisabled();
    expect(btn.textContent).toContain("✓");
    fireEvent.click(btn);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("reads as required immediately after a pull, without waiting for the next plan poll", async () => {
    render(
      <PullIntoPlanControl projectKey="proj" features={[feat("sketcher", "Sketcher")]} artifactId="bfs.rs" />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Sketcher/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Sketcher/ })).toBeDisabled());
    expect(screen.getByRole("button", { name: /Sketcher/ }).textContent).toContain("✓");
  });

  it("SAYS SO when the write fails — never a success message over a failed write", async () => {
    // The whole point of #4267: the button it replaces flashed "added to the plan" and wrote nothing.
    mockInvoke.mockRejectedValueOnce(new Error("plan store unreachable"));
    render(
      <PullIntoPlanControl projectKey="proj" features={[feat("sketcher", "Sketcher")]} artifactId="bfs.rs" />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Sketcher/ }));
    expect(await screen.findByText(/Couldn't record it/)).toBeInTheDocument();
    // …and it stays pullable, rather than falsely reading as done.
    expect(screen.getByRole("button", { name: /Sketcher/ })).not.toBeDisabled();
  });

  it("explains itself when the plan has no features to attach to", () => {
    render(<PullIntoPlanControl projectKey="proj" features={[]} artifactId="bfs.rs" />);
    expect(screen.getByText(/No features yet/)).toBeInTheDocument();
  });
});
