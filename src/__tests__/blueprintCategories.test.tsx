import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  blueprintCategory, filterBlueprints, CATEGORY_META, makeBlueprints, resolveProjectSeed,
  type Blueprint,
} from "../screens/projects/blueprints";
import { LibraryView } from "../screens/projects/BlueprintLibrary";

const bp = (id: string, name: string, over: Partial<Blueprint> = {}): Blueprint =>
  ({ id, name, desc: "", sections: [], ...over });

describe("blueprint categories (#645)", () => {
  it("defaults to greenfield when unset", () => {
    expect(blueprintCategory(bp("x", "X"))).toBe("greenfield");
    expect(blueprintCategory(bp("x", "X", { category: "transform" }))).toBe("transform");
  });

  it("labels the built-ins by lifecycle intent", () => {
    const all = makeBlueprints();
    expect(all.find((b) => b.id === "default")!.category).toBe("greenfield");
    expect(all.find((b) => b.id === "default")!.mode).toBe("create");
    const refactor = all.find((b) => b.id === "refactor")!;
    expect(refactor.category).toBe("transform");
    expect(refactor.mode).toBe("operate");
  });

  it("every category has display metadata", () => {
    expect(CATEGORY_META.greenfield.label).toBe("Greenfield");
    expect(CATEGORY_META.transform.label).toBe("Transform");
  });

  it("the default blueprint's repos stage is enabled so it shows in the plan (#672)", () => {
    const def = makeBlueprints().find((b) => b.id === "default")!;
    const repos = def.sections.find((s) => s.key === "repos")!;
    expect(repos.enabled).toBe(true);
  });

  it("the default blueprint's UI stage is optional (#676)", () => {
    const def = makeBlueprints().find((b) => b.id === "default")!;
    expect(def.sections.find((s) => s.key === "ui")!.optional).toBe(true);
    // other blueprints' UI stays required
    expect(makeBlueprints().find((b) => b.id === "fullstack")!.sections.find((s) => s.key === "ui")!.optional).toBeFalsy();
  });

  it("tags every built-in blueprint origin=built-in, incl. the greenfield four (#658)", () => {
    const all = makeBlueprints();
    expect(all.every((b) => b.origin === "built-in")).toBe(true);
    for (const id of ["default", "fullstack", "mobile", "api"]) {
      expect(all.find((b) => b.id === id)!.origin, id).toBe("built-in");
    }
  });
});

describe("transform blueprints (#645 slice 2)", () => {
  const all = makeBlueprints();
  const byId = (id: string) => all.find((b) => b.id === id)!;

  it("packages the lifecycle transforms with the right category/mode", () => {
    for (const id of ["split-services", "combine-services", "migrate"]) {
      expect(byId(id), id).toBeTruthy();
      expect(byId(id).category).toBe("transform");
      expect(byId(id).mode).toBe("operate");
    }
    expect(byId("harden").category).toBe("harden");
    expect(byId("harden").mode).toBe("operate");
  });

  it("builds their stages from real transform section defs (not the synth fallback)", () => {
    const split = byId("split-services");
    const keys = split.sections.map((s) => s.key);
    expect(keys).toEqual(expect.arrayContaining(["boundaries", "extraction"]));
    const extraction = split.sections.find((s) => s.key === "extraction")!;
    expect(extraction.deps).toContain("boundaries");
    // a real SECTION_DEF carries its own glyph; the synth fallback would be "✚".
    expect(split.sections.find((s) => s.key === "boundaries")!.glyph).not.toBe("✚");
  });

  it("the refactor blueprint has no structure stage (no issues.json) but keeps cleanup + testing (#666)", () => {
    const refactor = makeBlueprints().find((b) => b.id === "refactor")!;
    const keys = refactor.sections.map((s) => s.key);
    expect(keys).not.toContain("structure");
    expect(keys).toEqual(expect.arrayContaining(["cleanup", "testing"]));
  });

  it("are surfaced by the category filter", () => {
    const transforms = filterBlueprints(all, { category: "transform" }).map((b) => b.id);
    expect(transforms).toEqual(expect.arrayContaining(["refactor", "split-services", "combine-services", "migrate"]));
    expect(filterBlueprints(all, { category: "harden" }).map((b) => b.id)).toContain("harden");
  });
});

describe("resolveProjectSeed — blueprint tracking for the reset prompt (#647 fix)", () => {
  it("a brand-new project (no config) seeds + records the active blueprint", () => {
    expect(resolveProjectSeed(false, undefined, "fullstack")).toEqual({ seedConfig: true, setBlueprintId: "fullstack" });
  });
  it("an existing project with NO recorded blueprint backfills to default (so a switch prompts)", () => {
    expect(resolveProjectSeed(true, undefined, "fullstack")).toEqual({ seedConfig: false, setBlueprintId: "default" });
  });
  it("an existing project that already knows its blueprint changes nothing", () => {
    expect(resolveProjectSeed(true, "refactor", "fullstack")).toEqual({ seedConfig: false });
  });
});

describe("filterBlueprints (#645)", () => {
  const list = [
    bp("a", "Default", { category: "greenfield", desc: "balanced start" }),
    bp("b", "Refactor & Cleanup", { category: "transform", tags: ["dead-code"] }),
    bp("c", "Harden security", { category: "harden" }),
  ];

  it("filters by category", () => {
    expect(filterBlueprints(list, { category: "transform" }).map((b) => b.id)).toEqual(["b"]);
    expect(filterBlueprints(list, { category: "all" })).toHaveLength(3);
  });
  it("filters by free-text across name/desc/tags/category", () => {
    expect(filterBlueprints(list, { query: "refactor" }).map((b) => b.id)).toEqual(["b"]);
    expect(filterBlueprints(list, { query: "dead-code" }).map((b) => b.id)).toEqual(["b"]); // tag
    expect(filterBlueprints(list, { query: "harden" }).map((b) => b.id)).toEqual(["c"]); // category word
    expect(filterBlueprints(list, { query: "balanced" }).map((b) => b.id)).toEqual(["a"]); // desc
  });
  it("combines query + category", () => {
    expect(filterBlueprints(list, { query: "security", category: "harden" }).map((b) => b.id)).toEqual(["c"]);
    expect(filterBlueprints(list, { query: "security", category: "greenfield" })).toHaveLength(0);
  });
});

describe("LibraryView search + filter (#645)", () => {
  const list = [
    bp("a", "Default", { category: "greenfield" }),
    bp("b", "Refactor & Cleanup", { category: "transform" }),
  ];

  // Card names render as <h3>; the hero references the top blueprint in a <b>, so target
  // the card headings specifically.
  const card = (re: RegExp) => screen.queryByRole("heading", { level: 3, name: re });

  it("shows a category badge and filters by the category chip", () => {
    render(<LibraryView blueprints={list} onOpen={vi.fn()} onMenu={vi.fn()} onNew={vi.fn()} onImport={vi.fn()} />);
    expect(card(/Default/)).toBeInTheDocument();
    expect(card(/Refactor & Cleanup/)).toBeInTheDocument();
    // click the Transform filter chip → only the transform card remains
    fireEvent.click(screen.getByRole("button", { name: "Transform" }));
    expect(card(/Default/)).not.toBeInTheDocument();
    expect(card(/Refactor & Cleanup/)).toBeInTheDocument();
  });

  it("searches by text", () => {
    render(<LibraryView blueprints={list} onOpen={vi.fn()} onMenu={vi.fn()} onNew={vi.fn()} onImport={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Search blueprints"), { target: { value: "refactor" } });
    expect(card(/Default/)).not.toBeInTheDocument();
    expect(card(/Refactor & Cleanup/)).toBeInTheDocument();
  });
});
