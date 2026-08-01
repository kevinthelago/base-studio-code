// The per-page verdict (#4169) — the two signals must stay independent: structural drift does not block a
// flip (the page still renders, just an older skeleton), an unbound behaviour does (the page throws on
// load and shows its fallback).
import { describe, it, expect } from "vitest";
import { buildPageShadow, formatShadowLine, formatShadowSummary, type ModuleShadow } from "./shadowReport";
import type { OutlineDiff } from "./outlineDiff";

const clean: OutlineDiff = { identical: true, differing: 0, fileNodes: 10, graphNodes: 10, onlyInFile: [], onlyInGraph: [] };
const drifted: OutlineDiff = { identical: false, differing: 3, fileNodes: 10, graphNodes: 8, onlyInFile: ["Screen>New"], onlyInGraph: [] };

const mod = (recordId: string, status: ModuleShadow["status"], diff: OutlineDiff | null): ModuleShadow =>
  ({ recordId, file: `/src/${recordId}.tsx`, status, diff });

const page = (over: Partial<Parameters<typeof buildPageShadow>[0]> = {}) =>
  buildPageShadow({
    pageId: "mcppage", label: "MCP", rendersFrom: "graph",
    modules: [mod("mcppage", "identical", clean)], unbound: [], hasGraphNode: true, ...over,
  });

describe("buildPageShadow", () => {
  it("is graph-identical when every module matches", () => {
    const p = page();
    expect(p.status).toBe("graph-identical");
    expect(p.differingNodes).toBe(0);
    expect(p.readyForGraph).toBe(true);
  });

  it("sums the differing nodes across a page's modules", () => {
    const p = page({ modules: [mod("mcppage", "differs", drifted), mod("mcp-analytics", "differs", drifted)] });
    expect(p.status).toBe("differs");
    expect(p.differingNodes).toBe(6);
    expect(p.fileNodes).toBe(20);
  });

  it("keeps drift OUT of readiness — a drifted page still renders", () => {
    expect(page({ modules: [mod("mcppage", "differs", drifted)] }).readyForGraph).toBe(true);
  });

  it("is NOT ready with an unbound behaviour — it would throw on load, not degrade", () => {
    const p = page({ unbound: [{ specifier: "@/features/mcp/lib/x", symbols: ["probe"], importedBy: ["mcppage"] }] });
    expect(p.readyForGraph).toBe(false);
    expect(p.status).toBe("graph-identical"); // …and the structural verdict is unaffected
  });

  it("is NOT ready when the source will not compile", () => {
    expect(page({ compileError: "Unexpected }" }).readyForGraph).toBe(false);
  });

  it("reports a page the graph does not carry at all", () => {
    const p = page({ hasGraphNode: false, modules: [mod("settingspage", "no-graph-node", null)] });
    expect(p.status).toBe("no-graph-node");
    expect(p.readyForGraph).toBe(false);
  });

  it("counts a module with no graph record as drift, not as a match", () => {
    // A tab body added to the file page after the migration: nothing differs node-for-node because there
    // is nothing to compare — and reading that as "identical" is exactly the false green to avoid.
    const p = page({ modules: [mod("mcppage", "identical", clean), mod("mcp-new-tab", "no-graph-node", null)] });
    expect(p.status).toBe("differs");
  });

  it("reports a graph-only page (its files are deleted) as such, and as ready", () => {
    const p = page({ pageId: "fleetpage", modules: [{ recordId: "fleetpage", file: null, status: "no-file-baseline", diff: null }] });
    expect(p.status).toBe("no-file-baseline");
    expect(p.readyForGraph).toBe(true);
  });
});

describe("formatShadowLine", () => {
  it("states the verdict, the render source and the bindings", () => {
    expect(formatShadowLine(page())).toBe("mcppage [renders from graph] — graph-identical · all behaviors bound");
    expect(formatShadowLine(page({ modules: [mod("mcppage", "differs", drifted)] })))
      .toBe("mcppage [renders from graph] — differs in 3 of 10 nodes · all behaviors bound");
    expect(formatShadowLine(page({ unbound: [{ specifier: "@/x", symbols: [], importedBy: ["mcppage"] }] })))
      .toContain("unbound: @/x");
  });
});

describe("formatShadowSummary", () => {
  it("rolls up how much of the app the graph could render today", () => {
    const summary = formatShadowSummary([
      page(),
      page({ pageId: "skillspage", unbound: [{ specifier: "@/a", symbols: [], importedBy: ["skillspage"] }] }),
      page({ pageId: "githubpage", modules: [mod("githubpage", "differs", drifted)] }),
    ]);
    expect(summary).toBe("3 pages · 2 structurally identical · 2 fully bound · 1 distinct unbound specifiers");
  });
});
