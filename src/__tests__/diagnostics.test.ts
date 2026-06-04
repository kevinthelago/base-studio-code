import { describe, it, expect, beforeEach } from "vitest";
import {
  interpretDiagnostics,
  coerceShellKind,
  loadShellKind,
  saveShellKind,
  loadReport,
  saveReport,
  DEFAULT_SHELL,
  type PrereqStatus,
} from "../lib/diagnostics";

const prereq = (p: Partial<PrereqStatus> & { name: string }): PrereqStatus => ({
  found: true,
  version: null,
  path: null,
  hint: "",
  ...p,
});

describe("interpretDiagnostics", () => {
  it("reports allOk with a clean headline when every prerequisite is found", () => {
    const r = interpretDiagnostics([
      prereq({ name: "Git Bash", path: "C:/Git/bin/bash.exe" }),
      prereq({ name: "claude", version: "claude 1.2.3", path: "/usr/bin/claude" }),
      prereq({ name: "git", version: "git version 2.43.0", path: "/usr/bin/git" }),
      prereq({ name: "gh", version: "gh version 2.40.0", path: "/usr/bin/gh" }),
      prereq({ name: "gh auth" }),
    ]);
    expect(r.allOk).toBe(true);
    expect(r.worst).toBeNull();
    expect(r.headline).toMatch(/All prerequisites satisfied/);
    expect(r.prereqs.every((p) => p.ok && p.consequence === "")).toBe(true);
  });

  it("gives missing Git Bash a specific consequence, not a generic failure", () => {
    const r = interpretDiagnostics([
      prereq({ name: "Git Bash", found: false, hint: "Install Git for Windows" }),
    ]);
    const gb = r.prereqs.find((p) => p.name === "Git Bash")!;
    expect(gb.ok).toBe(false);
    expect(gb.severity).toBe("critical");
    expect(gb.consequence).toMatch(/Git Bash is the shell/);
  });

  it("gives missing claude a specific consequence, not a generic failure", () => {
    const r = interpretDiagnostics([
      prereq({ name: "claude", found: false, hint: "Install the Claude CLI" }),
    ]);
    const c = r.prereqs.find((p) => p.name === "claude")!;
    expect(c.ok).toBe(false);
    expect(c.severity).toBe("critical");
    expect(c.consequence).toMatch(/Agents can't run/);
  });

  it("treats a missing gh / gh auth as a warning, not critical", () => {
    const r = interpretDiagnostics([
      prereq({ name: "gh", found: false }),
      prereq({ name: "gh auth", found: false }),
    ]);
    expect(r.prereqs.every((p) => p.severity === "warning")).toBe(true);
    expect(r.worst).toBe("warning");
  });

  it("worst is critical when any critical prerequisite is missing, even alongside warnings", () => {
    const r = interpretDiagnostics([
      prereq({ name: "git", found: false }),
      prereq({ name: "gh", found: false }),
    ]);
    expect(r.worst).toBe("critical");
    expect(r.headline).toMatch(/2 prerequisites need attention: git, gh/);
  });

  it("uses singular phrasing for exactly one missing prerequisite", () => {
    const r = interpretDiagnostics([
      prereq({ name: "claude", found: false }),
      prereq({ name: "git" }),
    ]);
    expect(r.headline).toMatch(/1 prerequisite need.*claude/);
  });

  it("defaults an unknown missing prerequisite to a critical generic consequence", () => {
    const r = interpretDiagnostics([prereq({ name: "podman", found: false })]);
    const p = r.prereqs[0];
    expect(p.severity).toBe("critical");
    expect(p.consequence.length).toBeGreaterThan(0);
  });

  it("preserves version and path on found tools", () => {
    const r = interpretDiagnostics([
      prereq({ name: "git", version: "git version 2.43.0", path: "/usr/bin/git" }),
    ]);
    expect(r.prereqs[0].version).toBe("git version 2.43.0");
    expect(r.prereqs[0].path).toBe("/usr/bin/git");
  });
});

describe("coerceShellKind", () => {
  it("accepts known shell kinds", () => {
    for (const k of ["auto", "bash", "powershell", "cmd"]) {
      expect(coerceShellKind(k)).toBe(k);
    }
  });
  it("falls back to the default for unknown / null / undefined", () => {
    expect(coerceShellKind("fish")).toBe(DEFAULT_SHELL);
    expect(coerceShellKind(null)).toBe(DEFAULT_SHELL);
    expect(coerceShellKind(undefined)).toBe(DEFAULT_SHELL);
  });
});

describe("shell + report persistence", () => {
  beforeEach(() => {
    globalThis.localStorage?.clear?.();
  });

  it("round-trips the selected shell", () => {
    expect(loadShellKind()).toBe(DEFAULT_SHELL);
    saveShellKind("powershell");
    expect(loadShellKind()).toBe("powershell");
  });

  it("coerces a corrupt persisted shell value back to the default", () => {
    globalThis.localStorage?.setItem("bsc.diagnostics.shell.v1", "not-a-shell");
    expect(loadShellKind()).toBe(DEFAULT_SHELL);
  });

  it("round-trips a stored report with its timestamp", () => {
    const report = interpretDiagnostics([prereq({ name: "git" })]);
    saveReport(report, 1717430000000);
    const stored = loadReport();
    expect(stored?.takenAt).toBe(1717430000000);
    expect(stored?.report.allOk).toBe(true);
  });

  it("returns null when no report is stored", () => {
    expect(loadReport()).toBeNull();
  });

  it("returns null for an unparseable stored report", () => {
    globalThis.localStorage?.setItem("bsc.diagnostics.report.v1", "{not json");
    expect(loadReport()).toBeNull();
  });
});
