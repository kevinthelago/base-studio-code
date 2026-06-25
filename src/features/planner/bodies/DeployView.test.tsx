import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { FocusedDeployBody } from "./DeployView";
import { defaultDeployConfig } from "../shared/deployConfig";
import type { PlanDependency, DependencyRegistry } from "../issues/dependencies";

describe("FocusedDeployBody — dependencies, grouped by source (#1167 redesign)", () => {
  const deploy = defaultDeployConfig(["acme/web"]);

  it("groups locked deps by SOURCE — public ecosystem defaults + the private registry", () => {
    const deps: PlanDependency[] = [
      { repo: "acme/web", ecosystem: "npm", name: "zod", version: "^3.23" },          // npm public default
      { repo: "acme/web", ecosystem: "npm", name: "@acme/ui", version: "^2", source: "internal" }, // private
      { ecosystem: "cargo", name: "serde", version: "1" },                            // crates.io public default
    ];
    const registries: Record<string, DependencyRegistry> = {
      internal: { url: "https://npm.internal/", scope: "@acme", auth: "INTERNAL_NPM_TOKEN" },
    };
    render(<FocusedDeployBody deploy={deploy} dependencies={deps} registries={registries} />);

    expect(screen.getByText("Dependencies")).toBeInTheDocument();
    // one group per source: the two public ecosystem defaults + the private registry
    expect(screen.getByText("npm registry")).toBeInTheDocument();
    expect(screen.getAllByText("crates.io").length).toBeGreaterThan(0); // group name + url (same for crates.io)
    expect(screen.getByText("internal")).toBeInTheDocument();
    // private registry meta surfaces url · scope · secret
    expect(screen.getByText("https://npm.internal/")).toBeInTheDocument();
    expect(screen.getByText("scope @acme")).toBeInTheDocument();
    expect(screen.getByText("secret INTERNAL_NPM_TOKEN")).toBeInTheDocument();
    // a dep renders name@version (split across spans, so match the name span's textContent)
    expect(screen.getByText((_, el) => el?.textContent === "zod@^3.23")).toBeTruthy();
    expect(screen.getByText((_, el) => el?.textContent === "@acme/ui@^2")).toBeTruthy();
  });

  it("shows an empty state and flags dependencies as missing in the readiness banner when none are locked", () => {
    render(<FocusedDeployBody deploy={deploy} dependencies={[]} />);
    expect(screen.getByText(/No dependencies locked yet/)).toBeInTheDocument();
    expect(screen.getByText(/missing:.*dependencies/)).toBeInTheDocument();
  });
});

describe("FocusedDeployBody — structure", () => {
  it("renders the four group dividers", () => {
    render(<FocusedDeployBody deploy={defaultDeployConfig(["acme/web"])} dependencies={[]} />);
    expect(screen.getByText("A · HOW IT SHIPS")).toBeInTheDocument();
    expect(screen.getByText("B · WHAT IT DEPENDS ON")).toBeInTheDocument();
    expect(screen.getByText("C · RELEASE & HEALTH")).toBeInTheDocument();
    expect(screen.getByText("D · READINESS")).toBeInTheDocument();
  });
});
