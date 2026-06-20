import { describe, it, expect } from "vitest";
import {
  emptyDataModel, checkDataModel, seedDataModels,
  addEntity, updateEntity, removeEntity, addField, updateField, removeField, toggleIdentity,
  type DataModel,
} from "../screens/planner/dataModel";

const base = (): DataModel => ({
  id: "m1", name: "M", version: 1,
  entities: [
    { key: "account", label: "Account", identity: ["id"], fields: [
      { key: "id", type: "string", required: true },
      { key: "name", type: "string" },
    ] },
  ],
});

describe("checkDataModel (#780)", () => {
  it("the seeded CRM model is valid", () => {
    expect(checkDataModel(seedDataModels()[0])).toEqual([]);
    expect(checkDataModel(emptyDataModel("x"))).toEqual([]);
  });

  it("flags dangling refs, unknown identity, dupes, and unsafe identifiers", () => {
    const m: DataModel = {
      id: "m", name: "bad", version: 1,
      entities: [
        { key: "account", label: "", identity: ["missing"], fields: [
          { key: "id", type: "string" },
          { key: "id", type: "string" },              // duplicate field
          { key: "ref-bad", type: "ref", ref: "ghost" }, // unsafe key + dangling ref
        ] },
        { key: "account", label: "", identity: [], fields: [] }, // duplicate entity
      ],
    };
    const p = checkDataModel(m).join(" | ");
    expect(p).toContain('identity field "missing" is not a field');
    expect(p).toContain('duplicate field key "id"');
    expect(p).toContain('ref to unknown entity "ghost"');
    expect(p).toContain("not a safe identifier");
    expect(p).toContain('duplicate entity key "account"');
  });

  it("a ref field with no target is flagged", () => {
    const m = base();
    m.entities[0].fields.push({ key: "owner", type: "ref" });
    expect(checkDataModel(m).join(" ")).toContain("ref field has no target entity");
  });
});

describe("pure edit transforms", () => {
  it("add/remove/update entities and fields without mutating the input", () => {
    const m = base();
    const snapshot = JSON.stringify(m);

    const m2 = addEntity(m, "contact");
    expect(m2.entities.map((e) => e.key)).toEqual(["account", "contact"]);

    const m3 = addField(m2, "contact", { key: "email", type: "string" });
    expect(m3.entities[1].fields).toHaveLength(1);

    const m4 = updateField(m3, "account", "name", { required: true });
    expect(m4.entities[0].fields.find((f) => f.key === "name")!.required).toBe(true);

    const m5 = updateEntity(m4, "account", { label: "Acct" });
    expect(m5.entities[0].label).toBe("Acct");

    const m6 = removeField(m5, "account", "name");
    expect(m6.entities[0].fields.map((f) => f.key)).toEqual(["id"]);

    const m7 = removeEntity(m6, "contact");
    expect(m7.entities.map((e) => e.key)).toEqual(["account"]);

    // input never mutated
    expect(JSON.stringify(m)).toBe(snapshot);
  });

  it("removing a field also drops it from the identity", () => {
    const m = base();
    const out = removeField(m, "account", "id");
    expect(out.entities[0].identity).toEqual([]);
  });

  it("toggleIdentity adds then removes a field from the merge key", () => {
    const m = base();
    const added = toggleIdentity(m, "account", "name");
    expect(added.entities[0].identity).toContain("name");
    const removed = toggleIdentity(added, "account", "name");
    expect(removed.entities[0].identity).not.toContain("name");
  });
});

describe("wire compatibility with the Rust store (#781)", () => {
  it("fields serialize with the Rust field names (type/ref/enum_values)", () => {
    const json = JSON.stringify({ key: "x", type: "ref", ref: "account", enum_values: ["a"] });
    expect(json).toContain('"type":"ref"');
    expect(json).toContain('"ref":"account"');
    expect(json).toContain('"enum_values":["a"]');
  });
});
