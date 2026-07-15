// Cross-graph node addressing (#3115, epic #3114) — URN grammar + the reserved `@bsc/…` import mapping.
import { describe, it, expect } from "vitest";
import {
  formatNodeUrn,
  parseNodeUrn,
  isNodeUrn,
  isNodeGraph,
  parseLibrarySpec,
  isLibrarySpec,
  urnToImportSpec,
  NODE_GRAPHS,
} from "./nodeUrn";

describe("formatNodeUrn / parseNodeUrn (#3115)", () => {
  it("round-trips a URN for each graph", () => {
    const cases: [Parameters<typeof formatNodeUrn>[0], string, string][] = [
      ["algo", "typescript", "fibonacci.ts"],
      ["ui", "react-ui", "Sparkline"],
      ["sound", "default", "click"],
    ];
    for (const [graph, kit, id] of cases) {
      const urn = formatNodeUrn(graph, kit, id);
      expect(urn).toBe(`${graph}:${kit}/${id}`);
      expect(parseNodeUrn(urn!)).toEqual({ graph, kit, id });
    }
  });

  it("keeps an id containing a slash intact (kit is only the first segment)", () => {
    const urn = "ui:react-ui/forms/Field";
    expect(parseNodeUrn(urn)).toEqual({ graph: "ui", kit: "react-ui", id: "forms/Field" });
  });

  it("format rejects an empty component instead of minting a malformed URN", () => {
    expect(formatNodeUrn("algo", "", "x")).toBeNull();
    expect(formatNodeUrn("algo", "typescript", "")).toBeNull();
    // @ts-expect-error unknown graph
    expect(formatNodeUrn("nope", "k", "i")).toBeNull();
  });

  it("parse returns null (never throws) for malformed input", () => {
    for (const bad of ["", "algo", "algo:", "algo:typescript", "algo:/id", "algo:kit/", ":kit/id", "unknown:kit/id", "algo/kit/id"]) {
      expect(parseNodeUrn(bad)).toBeNull();
      expect(isNodeUrn(bad)).toBe(false);
    }
    // non-string input is tolerated
    expect(parseNodeUrn(undefined as unknown as string)).toBeNull();
  });

  it("isNodeGraph guards the graph token", () => {
    for (const g of NODE_GRAPHS) expect(isNodeGraph(g)).toBe(true);
    expect(isNodeGraph("designs")).toBe(false);
  });
});

describe("library import specifiers `@bsc/<segment>/<name>` (#3115)", () => {
  it("parses each graph's segment to its graph + name", () => {
    expect(parseLibrarySpec("@bsc/algorithms/fibonacci")).toEqual({ graph: "algo", name: "fibonacci" });
    expect(parseLibrarySpec("@bsc/sounds/click")).toEqual({ graph: "sound", name: "click" });
    expect(parseLibrarySpec("@bsc/ui/Sparkline")).toEqual({ graph: "ui", name: "Sparkline" });
  });

  it("keeps a name path with a slash", () => {
    expect(parseLibrarySpec("@bsc/ui/forms/Field")).toEqual({ graph: "ui", name: "forms/Field" });
  });

  it("rejects non-library / unknown-segment / nameless specs", () => {
    for (const bad of ["react", "@/features/x", "./sibling", "@bsc", "@bsc/", "@bsc/algorithms", "@bsc/algorithms/", "@bsc/nope/x", "@bscx/algorithms/y"]) {
      expect(parseLibrarySpec(bad)).toBeNull();
    }
    expect(isLibrarySpec("react")).toBe(false);
    expect(isLibrarySpec("@bsc/algorithms/fibonacci")).toBe(true);
  });

  it("urnToImportSpec builds the canonical `@bsc/<segment>/<id>` form", () => {
    expect(urnToImportSpec("algo:typescript/fibonacci.ts")).toBe("@bsc/algorithms/fibonacci.ts");
    expect(urnToImportSpec("sound:default/click")).toBe("@bsc/sounds/click");
    expect(urnToImportSpec("ui:react-ui/Sparkline")).toBe("@bsc/ui/Sparkline");
    expect(urnToImportSpec("garbage")).toBeNull();
  });
});
