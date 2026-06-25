import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SharedDependenciesSection } from "./SharedDependencies";
import type { Agent } from "../pane/projectPane.types";
import type { PlanDependency, DependencyRegistry } from "../issues/dependencies";

// The section reads only id/name/repo/color off each agent.
const agent = (id: string, repo: string, color = "#7c93ff"): Agent =>
  ({ id, name: id, repo, color, role: "worker" } as unknown as Agent);

const agents = [agent("api", "acme/web"), agent("ui", "acme/web", "#58a6ff"), agent("director", "acme/web", "#a78bfa"), agent("infra", "acme/cli", "#e3b341")];
const registries: Record<string, DependencyRegistry> = { acme: { url: "npm.acme.internal", scope: "@acme", auth: "ACME_NPM_TOKEN" } };
const deps: PlanDependency[] = [
  { repo: "acme/web", ecosystem: "npm", name: "zod", version: "3.23.8", stream: "api", why: "validators" },
  { repo: "acme/web", ecosystem: "npm", name: "zod", version: "3.23.8", stream: "ui" },              // shared
  { repo: "acme/web", ecosystem: "npm", name: "@acme/ui-kit", source: "acme", stream: "ui" },        // private
  { repo: "acme/cli", ecosystem: "cargo", name: "clap", stream: "infra" },                            // single-owner
];

describe("SharedDependenciesSection (#1429)", () => {
  it("shows a per-stream block for a multi-stream repo with the shared version-lock", () => {
    render(<SharedDependenciesSection agents={agents} dependencies={deps} registries={registries} />);
    expect(screen.getByText("Shared dependencies")).toBeInTheDocument();
    expect(screen.getByText("acme/web")).toBeInTheDocument();
    expect(screen.getByText("3 streams")).toBeInTheDocument();
    expect(screen.getAllByText("zod").length).toBe(2);                 // declared by api + ui
    expect(screen.getByText("↔ shared · ui")).toBeInTheDocument();     // api's zod shares with ui
    expect(screen.getByText("↔ shared · api")).toBeInTheDocument();    // ui's zod shares with api
    expect(screen.getByText("@acme/ui-kit")).toBeInTheDocument();
  });

  it("omits single-owner repos and notes them; the director shows as orchestrator", () => {
    render(<SharedDependenciesSection agents={agents} dependencies={deps} registries={registries} />);
    // acme/cli (single owner) is not a repo block, but is noted
    expect(screen.queryByText("acme/cli")).toBeNull();
    expect(screen.getByText(/acme\/cli has a single owner \(infra\)/)).toBeInTheDocument();
    expect(screen.getByText(/orchestrates/)).toBeInTheDocument();      // director, no build deps
  });

  it("shows the empty state when no repo is shared", () => {
    render(<SharedDependenciesSection agents={[agent("infra", "acme/cli")]} dependencies={[]} registries={{}} />);
    expect(screen.getByText(/Every repo has a single owner/)).toBeInTheDocument();
  });
});
