// Smoke tests for the Deploy stage section modules extracted in #1636 — ServiceTargetEditor
// (deployTargetSection) and ServiceDeploySections (deployShipSections). These render the split
// modules in isolation so a regression in either is caught even though FocusedDeployBody composes
// them (covered in DeployView.test.tsx). Behavior is unchanged from the pre-split single file.

import { describe, it, expect } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { ServiceTargetEditor } from "./deployTargetSection";
import { ServiceDeploySections } from "./deployShipSections";
import { defaultDeployConfig, type DeployService } from "../lib/deployConfig";

function svc0() {
  return defaultDeployConfig(["acme/web"]).services[0];
}

/** Controlled host so a patch re-renders the editor with the next service. */
function TargetHarness({ initial }: { initial: DeployService }) {
  const [s, setS] = useState(initial);
  return <ServiceTargetEditor svc={s} setSvc={(p) => setS({ ...s, ...p })} />;
}

describe("ServiceTargetEditor (deployTargetSection, #1636)", () => {
  it("renders the cloud platform dropdown + the cloud·local mode toggle", () => {
    render(<TargetHarness initial={svc0()} />);
    expect(screen.getByText("Select a platform…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "cloud" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "local" })).toBeInTheDocument();
  });

  it("switching to Local swaps in the kind toggle (library / application)", () => {
    render(<TargetHarness initial={svc0()} />);
    fireEvent.click(screen.getByRole("button", { name: "local" }));
    expect(screen.queryByText("Select a platform…")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "library" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "application" })).toBeInTheDocument();
  });
});

describe("ServiceDeploySections (deployShipSections, #1636)", () => {
  it("renders the pipeline / environments / config & secrets cards", () => {
    const s = svc0();
    render(<ServiceDeploySections svc={s} setSvc={() => {}} />);
    expect(screen.getByText("CI / CD pipeline")).toBeInTheDocument();
    expect(screen.getByText("Environments")).toBeInTheDocument();
    expect(screen.getByText("Config & secrets")).toBeInTheDocument();
    expect(screen.getByText("rollout")).toBeInTheDocument();
    expect(screen.getByText("auto-rollback")).toBeInTheDocument();
  });
});
