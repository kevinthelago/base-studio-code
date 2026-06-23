import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { FocusedDeployBody } from "./DeployView";
import { defaultDeployConfig } from "../shared/deployConfig";
import type { PlanDependency, DependencyRegistry } from "../issues/dependencies";

describe("FocusedDeployBody — dependencies section (#1133)", () => {
  const deploy = defaultDeployConfig(["acme/web"]);

  it("surfaces the locked deps grouped by repo, with dev/source badges and the registries", () => {
    const deps: PlanDependency[] = [
      { repo: "acme/web", ecosystem: "npm", name: "zod", version: "^3.23" },
      { repo: "acme/web", ecosystem: "npm", name: "@acme/ui", version: "^2", source: "internal" },
      { ecosystem: "cargo", name: "serde", version: "1" }, // unscoped ⇒ "· all repos"
    ];
    const registries: Record<string, DependencyRegistry> = {
      internal: { url: "https://npm.internal/", scope: "@acme", auth: "INTERNAL_NPM_TOKEN" },
    };
    render(<FocusedDeployBody deploy={deploy} dependencies={deps} registries={registries} />);

    expect(screen.getByText("dependencies")).toBeInTheDocument();
    expect(screen.getByText("zod@^3.23")).toBeInTheDocument();
    expect(screen.getByText("@acme/ui@^2")).toBeInTheDocument();
    expect(screen.getByText("⛁ internal")).toBeInTheDocument();          // source badge
    expect(screen.getByText("· all repos")).toBeInTheDocument();          // unscoped group
    expect(screen.getByText("https://npm.internal/")).toBeInTheDocument();// registry url
    expect(screen.getByText(/INTERNAL_NPM_TOKEN/)).toBeInTheDocument();   // auth secret name
  });

  it("shows an empty state and flags dependencies as missing in the readiness banner when none are locked", () => {
    render(<FocusedDeployBody deploy={deploy} dependencies={[]} />);
    expect(screen.getByText(/No dependencies locked yet/)).toBeInTheDocument();
    expect(screen.getByText(/missing:.*dependencies/)).toBeInTheDocument();
  });
});
