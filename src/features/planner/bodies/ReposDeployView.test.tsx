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
      repos={repos} deploy={cfg} onDeployChange={setCfg} onLinkRepo={() => {}}
    />
  );
}

describe("FocusedReposDeployBody — no in-body header (#1430)", () => {
  it("renders no in-body header — the focused pane's phase header titles the stage", () => {
    render(<Harness repos={[repo("acme/web"), repo("acme/api")]} />);
    expect(screen.queryByText("Repositories & Deployment")).not.toBeInTheDocument(); // duplicate header removed
    expect(screen.queryByText(/repos deploy-ready/)).not.toBeInTheDocument();        // counter removed with it
    // the cards still render
    expect(screen.getByText("acme/web")).toBeInTheDocument();
    expect(screen.getByText("acme/api")).toBeInTheDocument();
  });

  it("renders the per-repo empty state with no repos", () => {
    render(<Harness repos={[]} />);
    expect(screen.getByText("No repositories linked")).toBeInTheDocument();
    expect(screen.getByText(/configured per repository/)).toBeInTheDocument();
    expect(screen.queryByText("CI / CD pipeline")).not.toBeInTheDocument();
  });
});

describe("FocusedReposDeployBody — per-repo cards (#1421)", () => {
  it("renders one per-repo card (with git identity) + the project-wide dependency tail, no global visibility toggle", () => {
    render(<Harness repos={[repo("acme/web", { primary: true, lang: "TypeScript" })]} />);
    expect(screen.getByText("acme/web")).toBeInTheDocument();
    expect(screen.getByText("primary")).toBeInTheDocument();
    expect(screen.getByText("TypeScript")).toBeInTheDocument();   // git identity folded into the card row
    expect(screen.getByText("set target →")).toBeInTheDocument(); // untargeted repo's collapsed-row chip
    // the per-repo deploy sections (CI/CD pipeline etc.) live INSIDE each card now (#1421) — absent
    // until the card is expanded with a target set.
    expect(screen.queryByText("CI / CD pipeline")).not.toBeInTheDocument();
    // dependencies were removed from the deployment pane (#1429)
    expect(screen.queryByText("DEPENDENCIES")).not.toBeInTheDocument();
    expect(screen.queryByText("Dependencies")).not.toBeInTheDocument();
    expect(screen.queryByText("A · HOW IT SHIPS")).not.toBeInTheDocument();
    // the "N/X defined" readiness banner is gone (#1403)
    expect(screen.queryByText(/\d+\/\d+ defined/)).not.toBeInTheDocument();
    // the per-repo visibility lock/globe toggle was removed from the deploy card headers (#1432)
    expect(screen.queryByRole("button", { name: /Make acme\/web (public|private)/ })).not.toBeInTheDocument();
  });

  it("starts with every repo collapsed, and a click toggles its target editor open then closed", () => {
    render(<Harness repos={[repo("acme/web"), repo("acme/api")]} />);
    // nothing expanded initially — no target editor anywhere
    expect(screen.queryByText("Select a platform…")).not.toBeInTheDocument();
    expect(screen.queryByText((_, el) => el?.textContent === "⎇ acme/web/.")).not.toBeInTheDocument();
    // click the repo → its editor expands
    fireEvent.click(screen.getByText("acme/web"));
    expect(screen.getByText((_, el) => el?.textContent === "⎇ acme/web/.")).toBeTruthy();
    expect(screen.getByText("Select a platform…")).toBeInTheDocument();
    // click it again → collapses (toggleable off)
    fireEvent.click(screen.getByText("acme/web"));
    expect(screen.queryByText("Select a platform…")).not.toBeInTheDocument();
  });

  it("opening a different repo moves the expanded editor to it", () => {
    render(<Harness repos={[repo("acme/web"), repo("acme/api")]} />);
    fireEvent.click(screen.getByText("acme/web"));
    expect(screen.getByText((_, el) => el?.textContent === "⎇ acme/web/.")).toBeTruthy();
    // opening api collapses web and expands api (only one open at a time)
    fireEvent.click(screen.getByText("acme/api"));
    expect(screen.getByText((_, el) => el?.textContent === "⎇ acme/api/.")).toBeTruthy();
    expect(screen.queryByText((_, el) => el?.textContent === "⎇ acme/web/.")).not.toBeInTheDocument();
  });
});
