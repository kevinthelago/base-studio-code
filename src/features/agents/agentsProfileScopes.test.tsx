// #1795 — the Filesystem-scope + Network controls in the profile editor were dead stubs
// (uncontrolled inputs, onClick-less ✕ / + buttons). These tests pin the wiring: every
// control now fires its handler, so a regression back to a display-only stub fails here.
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { ProfilesTab, type ProfilesTabProps } from "./ProfilesTab";
import { type AgentProfile } from "./lib/agentProfiles";

const prof = (over: Partial<AgentProfile> = {}): AgentProfile => ({
  id: "pf_scope", name: "Scoped", color: "#888", category: "user", desc: "Custom role.",
  mode: "ask", commands: [],
  tools: { read: "ask", grep: "ask", glob: "ask", edit: "ask", write: "ask", bash: "ask", web: "ask", task: "ask" },
  paths: { allow: ["src/**"], deny: ["secrets/**"] }, net: { allow: ["api.github.com"] },
  ...over,
});

function renderTab(selected: AgentProfile, editable = true) {
  const spies = {
    onSelect: vi.fn(), setMode: vi.fn(), setTool: vi.fn(), removeCmd: vi.fn(), addCmd: vi.fn(),
    addPath: vi.fn(), editPath: vi.fn(), removePath: vi.fn(), addHost: vi.fn(), removeHost: vi.fn(),
    toggleAssign: vi.fn(), onCreate: vi.fn(), onDelete: vi.fn(),
  };
  const props: ProfilesTabProps = {
    roles: [], profiles: [selected], consoles: [], selected,
    find: (id) => (id === selected.id ? selected : undefined), editable,
    ...spies,
  };
  render(<ProfilesTab {...props} />);
  return spies;
}

describe("Filesystem-scope editing (#1795)", () => {
  it("editing an allow-path input fires editPath('allow', i, value)", () => {
    const s = renderTab(prof());
    fireEvent.change(screen.getByDisplayValue("src/**"), { target: { value: "src/lib/**" } });
    expect(s.editPath).toHaveBeenCalledWith("allow", 0, "src/lib/**");
  });

  it("editing a deny-path input fires editPath('deny', i, value)", () => {
    const s = renderTab(prof());
    fireEvent.change(screen.getByDisplayValue("secrets/**"), { target: { value: ".env" } });
    expect(s.editPath).toHaveBeenCalledWith("deny", 0, ".env");
  });

  it("the ✕ on an allow / deny row fires removePath with its kind + index", () => {
    const s = renderTab(prof());
    const allowRow = screen.getByDisplayValue("src/**").closest(".scope-line")!;
    fireEvent.click(within(allowRow as HTMLElement).getByText("×"));
    expect(s.removePath).toHaveBeenCalledWith("allow", 0);

    const denyRow = screen.getByDisplayValue("secrets/**").closest(".scope-line")!;
    fireEvent.click(within(denyRow as HTMLElement).getByText("×"));
    expect(s.removePath).toHaveBeenCalledWith("deny", 0);
  });

  it("the two add buttons fire addPath('allow') / addPath('deny')", () => {
    const s = renderTab(prof());
    fireEvent.click(screen.getByText("+ allow path"));
    expect(s.addPath).toHaveBeenCalledWith("allow");
    fireEvent.click(screen.getByText("+ deny path"));
    expect(s.addPath).toHaveBeenCalledWith("deny");
  });

  it("the read-only placeholder row (no allow paths) is not editable", () => {
    const s = renderTab(prof({ paths: { allow: [], deny: [] } }));
    const placeholder = screen.getByDisplayValue("(none — read-only)");
    expect(placeholder).toBeDisabled();
    fireEvent.change(placeholder, { target: { value: "x" } });
    expect(s.editPath).not.toHaveBeenCalled();
  });
});

describe("Network allowlist editing (#1795)", () => {
  it("the ✕ on a host chip fires removeHost(host)", () => {
    const s = renderTab(prof());
    const chip = screen.getByText("api.github.com").closest(".cmd-chip")!;
    fireEvent.click(within(chip as HTMLElement).getByText("×"));
    expect(s.removeHost).toHaveBeenCalledWith("api.github.com");
  });

  it("the + add host button fires addHost — including in the empty state", () => {
    const withHosts = renderTab(prof());
    fireEvent.click(screen.getByText("+ add host"));
    expect(withHosts.addHost).toHaveBeenCalled();
  });

  it("an empty net.allow still offers an add-host affordance", () => {
    const s = renderTab(prof({ net: { allow: [] } }));
    fireEvent.click(screen.getByText("+ add host"));
    expect(s.addHost).toHaveBeenCalled();
  });
});
