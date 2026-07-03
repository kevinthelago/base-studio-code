// StreamSharedDeps (#2191) — the focused stream's slice of the shared-dependency picture, shown in
// its inspector: which repo it shares (with whom), its own declared deps + version-locks, or a
// single-owner note.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StreamSharedDeps } from "./SharedDependencies";
import type { Agent } from "../pane/projectPane.types";
import type { PlanDependency, DependencyRegistry } from "../issues/dependencies";

// Reads only id/name/repo/color off each agent.
const agent = (id: string, repo: string, color = "#7c93ff"): Agent =>
  ({ id, name: id, repo, color, role: "worker" } as unknown as Agent);

const agents = [agent("api", "acme/web"), agent("ui", "acme/web", "#58a6ff"), agent("director", "acme/web", "#a78bfa"), agent("infra", "acme/cli", "#e3b341")];
const registries: Record<string, DependencyRegistry> = { acme: { url: "npm.acme.internal", scope: "@acme", auth: "ACME_NPM_TOKEN" } };
const deps: PlanDependency[] = [
  { repo: "acme/web", ecosystem: "npm", name: "zod", version: "3.23.8", stream: "api", why: "validators" },
  { repo: "acme/web", ecosystem: "npm", name: "zod", version: "3.23.8", stream: "ui" },            // shared with api
  { repo: "acme/web", ecosystem: "npm", name: "@acme/ui-kit", source: "acme", stream: "ui" },      // private
  { repo: "acme/cli", ecosystem: "cargo", name: "clap", stream: "infra" },                          // single-owner
];

describe("StreamSharedDeps (#2191) — the focused stream's shared-dep slice", () => {
  it("shows the shared repo, who it's shared with, and this stream's own deps + version-lock", () => {
    render(<StreamSharedDeps a={agents[0]} agents={agents} dependencies={deps} registries={registries} />);
    expect(screen.getByText("acme/web")).toBeInTheDocument();
    expect(screen.getByText(/shared with ui, director/)).toBeInTheDocument();
    expect(screen.getByText("zod")).toBeInTheDocument();               // only api's own zod
    expect(screen.getByText("↔ shared · ui")).toBeInTheDocument();     // api's zod shares with ui
  });

  it("notes an orchestrator — a stream on the shared repo with no build deps of its own", () => {
    render(<StreamSharedDeps a={agents[2]} agents={agents} dependencies={deps} registries={registries} />);
    expect(screen.getByText(/No build deps of your own/)).toBeInTheDocument();
  });

  it("notes a single-owner repo as agent-managed", () => {
    render(<StreamSharedDeps a={agents[3]} agents={agents} dependencies={deps} registries={registries} />);
    expect(screen.getByText(/acme\/cli is yours alone — its deps stay agent-managed/)).toBeInTheDocument();
  });
});
