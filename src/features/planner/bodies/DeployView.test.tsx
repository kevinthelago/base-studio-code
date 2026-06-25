import { describe, it, expect } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { FocusedDeployBody } from "./DeployView";
import { defaultDeployConfig, type DeployConfig } from "../shared/deployConfig";
import type { PlanDependency, DependencyRegistry } from "../issues/dependencies";

/** A controlled host so toggling the mode/kind actually re-renders with the new config. */
function Harness({ initial }: { initial: DeployConfig }) {
  const [cfg, setCfg] = useState(initial);
  return <FocusedDeployBody deploy={cfg} onChange={setCfg} dependencies={[]} />;
}

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

describe("FocusedDeployBody — Target & hosting Cloud · Local modes (#1192)", () => {
  it("defaults to cloud mode — the platform dropdown is shown, no Kind toggle", () => {
    render(<FocusedDeployBody deploy={defaultDeployConfig(["acme/web"])} dependencies={[]} />);
    expect(screen.getByText("Select a platform…")).toBeInTheDocument();
    // mode toggle present
    expect(screen.getByRole("button", { name: "cloud" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "local" })).toBeInTheDocument();
    // local-only controls absent in cloud mode
    expect(screen.queryByRole("button", { name: "library" })).not.toBeInTheDocument();
  });

  it("switching to Local swaps the body — Kind toggle replaces the platform dropdown", () => {
    render(<Harness initial={defaultDeployConfig(["acme/web"])} />);
    fireEvent.click(screen.getByRole("button", { name: "local" }));
    // cloud platform dropdown gone; local Kind toggle present
    expect(screen.queryByText("Select a platform…")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "library" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "application" })).toBeInTheDocument();
  });

  it("Local → Library shows the publish registry + package name fields (no host/runtime)", () => {
    render(<Harness initial={defaultDeployConfig(["acme/web"])} />);
    fireEvent.click(screen.getByRole("button", { name: "local" }));
    fireEvent.click(screen.getByRole("button", { name: "library" }));
    expect(screen.getByText("publish registry")).toBeInTheDocument();
    expect(screen.getByText("package name")).toBeInTheDocument();
    expect(screen.getByText("publish trigger")).toBeInTheDocument();
    // no region / output-dir fields from the cloud body
    expect(screen.queryByText("region")).not.toBeInTheDocument();
    // and no port-forwarding (library only, that's app-only)
    expect(screen.queryByText("Port forwarding")).not.toBeInTheDocument();
  });

  it("Local → Application shows build targets/artifact/run + an optional port forward (cloudflared default)", () => {
    render(<Harness initial={defaultDeployConfig(["acme/web"])} />);
    fireEvent.click(screen.getByRole("button", { name: "local" }));
    // application is the default kind in local mode
    expect(screen.getByText("build target(s)")).toBeInTheDocument();
    expect(screen.getByText("output artifact")).toBeInTheDocument();
    expect(screen.getByText("run command")).toBeInTheDocument();
    // port forwarding toggle present, collapsed by default
    expect(screen.getByText("Port forwarding")).toBeInTheDocument();
    expect(screen.getByText("expose this app remotely")).toBeInTheDocument();
    expect(screen.queryByText("method")).not.toBeInTheDocument();
    // expand it → port + method fields, defaulting to cloudflared. The switch is the first child
    // of the toggle row (the "Port forwarding" label's previous sibling carries the onClick).
    fireEvent.click(screen.getByText("Port forwarding").parentElement!.firstChild as Element);
    expect(screen.getByText("port")).toBeInTheDocument();
    expect(screen.getByText("method")).toBeInTheDocument();
    expect((screen.getByText("method").parentElement!.querySelector("select") as HTMLSelectElement).value).toBe("cloudflared");
  });

  it("a local library satisfies the `target` readiness check without a cloud platform", () => {
    render(<Harness initial={defaultDeployConfig(["acme/sdk"])} />);
    fireEvent.click(screen.getByRole("button", { name: "local" }));
    fireEvent.click(screen.getByRole("button", { name: "library" }));
    // pick npm + a package name
    const regSel = screen.getByText("publish registry").parentElement!.querySelector("select") as HTMLSelectElement;
    fireEvent.change(regSel, { target: { value: "npm" } });
    const pkg = screen.getByText("package name").parentElement!.querySelector("input") as HTMLInputElement;
    fireEvent.change(pkg, { target: { value: "@acme/sdk" } });
    // the target readiness row flips to satisfied
    const row = screen.getByText("Deploy target per service").closest("div")!;
    expect(row.textContent).toContain("1/1 services");
  });
});
