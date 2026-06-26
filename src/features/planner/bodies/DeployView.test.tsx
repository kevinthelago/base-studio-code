import { describe, it, expect } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { FocusedDeployBody } from "./DeployView";
import { defaultDeployConfig, type DeployConfig } from "../lib/deployConfig";

/** A controlled host so toggling the mode/kind actually re-renders with the new config. */
function Harness({ initial }: { initial: DeployConfig }) {
  const [cfg, setCfg] = useState(initial);
  return <FocusedDeployBody deploy={cfg} onChange={setCfg} />;
}

/** Expand a repo's card by clicking its collapsed row (the repo full-name span bubbles to the
 *  row's onClick) — the target editor + ship sections live inside the expanded card (#1421). */
function expandRepo(fullName: string) {
  fireEvent.click(screen.getByText(fullName));
}

describe("FocusedDeployBody — per-repo cards (#1421)", () => {
  it("renders one card per repo — no in-body header (#1430), no deps tail (#1429)", () => {
    render(<FocusedDeployBody deploy={defaultDeployConfig(["acme/web", "acme/api"])} />);
    expect(screen.getByText("acme/web")).toBeInTheDocument();
    expect(screen.getByText("acme/api")).toBeInTheDocument();
    // both start untargeted
    expect(screen.getAllByText("set target →").length).toBe(2);
    // the in-body header was removed — the pane chrome titles the stage (#1430)
    expect(screen.queryByText("Deployment")).not.toBeInTheDocument();
    expect(screen.queryByText(/repos deploy-ready/)).not.toBeInTheDocument();
    // dependencies were removed from the deploy pane (#1429)
    expect(screen.queryByText("DEPENDENCIES")).not.toBeInTheDocument();
    expect(screen.queryByText("Dependencies")).not.toBeInTheDocument();
  });

  it("shows the empty state when no repositories are linked", () => {
    render(<FocusedDeployBody deploy={{ services: [] }} />);
    expect(screen.getByText("No repositories linked")).toBeInTheDocument();
    expect(screen.getByText(/configured per repository/)).toBeInTheDocument();
  });
});

describe("FocusedDeployBody — a repo card's Cloud · Local target (#1192)", () => {
  it("a card is collapsed until clicked, then shows the cloud platform dropdown + mode toggle", () => {
    render(<FocusedDeployBody deploy={defaultDeployConfig(["acme/web"])} />);
    // collapsed: the editor is hidden
    expect(screen.queryByText("Select a platform…")).not.toBeInTheDocument();
    expandRepo("acme/web");
    expect(screen.getByText("Select a platform…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "cloud" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "local" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "library" })).not.toBeInTheDocument();
  });

  it("switching a card to Local swaps the body — Kind toggle replaces the platform dropdown", () => {
    render(<Harness initial={defaultDeployConfig(["acme/web"])} />);
    expandRepo("acme/web");
    fireEvent.click(screen.getByRole("button", { name: "local" }));
    expect(screen.queryByText("Select a platform…")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "library" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "application" })).toBeInTheDocument();
  });

  it("Local → Library shows the publish registry + package name fields (no host/runtime)", () => {
    render(<Harness initial={defaultDeployConfig(["acme/web"])} />);
    expandRepo("acme/web");
    fireEvent.click(screen.getByRole("button", { name: "local" }));
    fireEvent.click(screen.getByRole("button", { name: "library" }));
    expect(screen.getByText("publish registry")).toBeInTheDocument();
    expect(screen.getByText("package name")).toBeInTheDocument();
    expect(screen.getByText("publish trigger")).toBeInTheDocument();
    expect(screen.queryByText("region")).not.toBeInTheDocument();
    expect(screen.queryByText("Port forwarding")).not.toBeInTheDocument();
  });

  it("Local → Application shows build targets/artifact/run + an optional port forward (cloudflared default)", () => {
    render(<Harness initial={defaultDeployConfig(["acme/web"])} />);
    expandRepo("acme/web");
    fireEvent.click(screen.getByRole("button", { name: "local" }));
    expect(screen.getByText("build target(s)")).toBeInTheDocument();
    expect(screen.getByText("output artifact")).toBeInTheDocument();
    expect(screen.getByText("run command")).toBeInTheDocument();
    expect(screen.getByText("Port forwarding")).toBeInTheDocument();
    expect(screen.getByText("expose this app remotely")).toBeInTheDocument();
    expect(screen.queryByText("method")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Port forwarding").parentElement!.firstChild as Element);
    expect(screen.getByText("port")).toBeInTheDocument();
    expect(screen.getByText("method")).toBeInTheDocument();
    expect((screen.getByText("method").parentElement!.querySelector("select") as HTMLSelectElement).value).toBe("cloudflared");
  });

  it("a local library clears the card's `set target →` once its publish fields are filled", () => {
    render(<Harness initial={defaultDeployConfig(["acme/sdk"])} />);
    expandRepo("acme/sdk");
    fireEvent.click(screen.getByRole("button", { name: "local" }));
    fireEvent.click(screen.getByRole("button", { name: "library" }));
    expect(screen.getByText("set target →")).toBeInTheDocument();
    const regSel = screen.getByText("publish registry").parentElement!.querySelector("select") as HTMLSelectElement;
    fireEvent.change(regSel, { target: { value: "npm" } });
    const pkg = screen.getByText("package name").parentElement!.querySelector("input") as HTMLInputElement;
    fireEvent.change(pkg, { target: { value: "@acme/sdk" } });
    // target now defined → the collapsed row's "set target →" is replaced by the library chip
    expect(screen.queryByText("set target →")).not.toBeInTheDocument();
    expect(screen.getByText("⬢ library")).toBeInTheDocument();
  });
});
