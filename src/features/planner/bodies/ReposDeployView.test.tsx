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
      onLinkRepo={() => {}} reposPublic={false}
      repoOverrides={{}} onSetRepoPublic={() => {}}
    />
  );
}

describe("FocusedReposDeployBody — header (cleaned up, #1403)", () => {
  it("shows just the icon + title — no gate pill, no ship toggle", () => {
    render(<Harness repos={[repo("acme/web"), repo("acme/api")]} />);
    expect(screen.getByText("Repositories & Deployment")).toBeInTheDocument();
    // the two header pills are gone
    expect(screen.queryByText(/gate blocked/)).not.toBeInTheDocument();
    expect(screen.queryByText(/repos? linked/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "ships" })).not.toBeInTheDocument();
  });

  it("renders the empty state with no repos (no gate pill)", () => {
    render(<Harness repos={[]} />);
    expect(screen.getByText("No repositories linked yet")).toBeInTheDocument();
    expect(screen.getByText(/Deployment unlocks once/)).toBeInTheDocument();
    expect(screen.queryByText("CI / CD pipeline")).not.toBeInTheDocument();
  });
});

describe("FocusedReposDeployBody — ship flow", () => {
  it("renders card 01 + the reused deploy tail, with no readiness banner or global visibility toggle", () => {
    render(<Harness repos={[repo("acme/web", { primary: true })]} />);
    // card 01 repositories with its repo row
    expect(screen.getByText("Repositories")).toBeInTheDocument();
    expect(screen.getByText("acme/web")).toBeInTheDocument();
    expect(screen.getByText("primary")).toBeInTheDocument();
    // the tail reused from FocusedDeployBody
    expect(screen.getByText("A · HOW IT SHIPS")).toBeInTheDocument();
    expect(screen.getByText("CI / CD pipeline")).toBeInTheDocument();
    expect(screen.getByText("D · READINESS")).toBeInTheDocument();
    // the "N/X defined" readiness banner is gone (#1403)
    expect(screen.queryByText(/\d+\/\d+ defined/)).not.toBeInTheDocument();
    // the global default Private/Public toggle is gone (#1403); per-repo toggles remain
    expect(screen.queryByRole("button", { name: /Private/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Make acme/web public" })).toBeInTheDocument();
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
});
