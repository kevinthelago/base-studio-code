import { describe, it, expect } from "vitest";
import { decompose } from "./decompose";
import { renderFeatureContract } from "./featureContract";
import type { PlanNode, NodeKind, Maturity } from "../stages/planNode";

function n(id: string, kind: NodeKind, maturity: Maturity, children: PlanNode[] = [], summary?: string): PlanNode {
  return { id, kind, title: id.replace(/^layer:/, ""), maturity, summary, children };
}

const plan = n("root", "root", "specified", [
  n("layer:api", "layer", "specified", [
    n("login", "feature", "contract-ready", [], "Email/password login"),
    n("draft", "feature", "stub"), // not ready -> excluded
  ]),
  n("layer:domain", "layer", "contract-ready", [n("core", "component", "contract-ready")]),
]);

describe("decompose", () => {
  it("emits a contract only for contract-ready work nodes", () => {
    expect(decompose(plan).map((c) => c.id)).toEqual(["login", "core"]);
  });

  it("derives goal, layer ownership (stream + owns), gate, and dependsOn", () => {
    const [login] = decompose(plan, {
      gate: ["npm test"],
      ownsByLayer: { api: ["src/api/**"] },
      dependsOn: { login: ["#5"] },
    });
    expect(login).toMatchObject({
      id: "login",
      title: "login",
      goal: "Email/password login", // from node summary
      owns: ["src/api/**"],
      stream: "api", // nearest layer ancestor
      dependsOn: ["#5"],
      verification: { tests: [], gate: ["npm test"] },
    });
  });

  it("defaults goal/owns when not provided", () => {
    const core = decompose(plan).find((c) => c.id === "core")!;
    expect(core.goal).toBe("Implement core."); // no summary -> default
    expect(core.owns).toEqual([]); // no ownsByLayer for "domain"
    expect(core.stream).toBe("domain");
  });

  it("produces contracts that render to issue bodies", () => {
    const md = renderFeatureContract(decompose(plan)[0]);
    expect(md).toContain("# login");
    expect(md).toContain("## Goal");
  });
});
