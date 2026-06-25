import { describe, it, expect } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { FocusedReposDeployBody } from "./ReposDeployView";
import { defaultDeployConfig, type DeployConfig } from "../shared/deployConfig";
import type { Repo } from "../pane/projectPane.types";

const repo = (id: string, over: Partial<Repo> = {}): Repo => ({
  id, branch: "main", ahead: 0, behind: 0, agents: [], primary: false, branches: [], cloned: true, ...over,
});

/** Controlled host so toggling ship / selecting a repo re-renders with the new config. */
function Harness({ repos, initial }: { repos?: Repo[]; initial?: DeployConfig }) {
  const [cfg, setCfg] = useState(initial ?? defaultDeployConfig((repos ?? []).map((r) => r.id)));
  return (
    <FocusedReposDeployBody
      repos={repos} deploy={cfg} onDeployChange={setCfg} dependencies={[]}
      onLinkRepo={() => {}} reposPublic={false} onSetReposPublic={() => {}}
      repoOverrides={{}} onSetRepoPublic={() => {}}
    />
  );
}

describe("FocusedReposDeployBody — header + gate", () => {
  it("flags the gate as blocked with no repos and shows the empty state", () => {
    render(<Harness repos={[]} />);
    expect(screen.getByText("Repositories & Deployment")).toBeInTheDocument();
    expect(screen.getByText(/gate blocked/)).toBeInTheDocument();
    expect(screen.getByText("No repositories linked yet")).toBeInTheDocument();
    // deploy flow is locked until a repo is linked
    expect(screen.getByText(/Deployment unlocks once/)).toBeInTheDocument();
    expect(screen.queryByText("CI / CD pipeline")).not.toBeInTheDocument();
  });

  it("shows the linked count once repos are present", () => {
    render(<Harness repos={[repo("acme/web"), repo("acme/api")]} />);
    expect(screen.getByText("✓ 2 repos linked")).toBeInTheDocument();
  });
});

describe("FocusedReposDeployBody — ship flow (phase.ship)", () => {
  it("ships by default — renders card 01 + the reused deploy tail (pipeline · dividers)", () => {
    render(<Harness repos={[repo("acme/web", { primary: true })]} />);
    // card 01 repositories with its repo row
    expect(screen.getByText("Repositories")).toBeInTheDocument();
    expect(screen.getByText("acme/web")).toBeInTheDocument();
    expect(screen.getByText("primary")).toBeInTheDocument();
    // the tail reused from FocusedDeployBody
    expect(screen.getByText("A · HOW IT SHIPS")).toBeInTheDocument();
    expect(screen.getByText("CI / CD pipeline")).toBeInTheDocument();
    expect(screen.getByText("D · READINESS")).toBeInTheDocument();
  });

  it("expands the selected repo's target editor inline, and switches on click", () => {
    render(<Harness repos={[repo("acme/web"), repo("acme/api")]} />);
    // first service is selected by default → its target editor (meta chip + platform dropdown) shows
    expect(screen.getByText((_, el) => el?.textContent === "⎇ acme/web/.")).toBeTruthy();
    expect(screen.getByText("Select a platform…")).toBeInTheDocument();
    // click the second repo row → selection (and the inline editor) moves to it
    fireEvent.click(screen.getByText("acme/api"));
    expect(screen.getByText((_, el) => el?.textContent === "⎇ acme/api/.")).toBeTruthy();
  });

  it("turning ship off collapses the deploy half to repos-only", () => {
    render(<Harness repos={[repo("acme/web")]} />);
    expect(screen.getByText("CI / CD pipeline")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "ships" }));
    expect(screen.getByText("Shipping is off for this project.")).toBeInTheDocument();
    expect(screen.queryByText("CI / CD pipeline")).not.toBeInTheDocument();
    // the repo is still listed
    expect(screen.getByText("acme/web")).toBeInTheDocument();
  });
});
