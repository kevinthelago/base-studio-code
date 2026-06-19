import { describe, it, expect } from "vitest";
import { parseDataModelTag, stripDataModelTags } from "../screens/projects/Planning";

// Minimal valid DataModel payload
const MODEL_JSON = JSON.stringify({
  name: "CRM",
  version: 1,
  entities: [
    {
      key: "account",
      label: "Account",
      identity: ["id"],
      fields: [
        { key: "id", type: "string", required: true },
        { key: "name", type: "string" },
      ],
    },
  ],
});

describe("parseDataModelTag", () => {
  it("extracts and parses a well-formed <data_model> tag", () => {
    const buf = `<data_model>${MODEL_JSON}</data_model>`;
    const model = parseDataModelTag(buf);
    expect(model).not.toBeNull();
    expect(model!.name).toBe("CRM");
    expect(model!.entities).toHaveLength(1);
    expect(model!.entities[0].key).toBe("account");
  });

  it("returns null when no tag is present", () => {
    expect(parseDataModelTag("just some planner output")).toBeNull();
  });

  it("returns null for a tag with malformed JSON", () => {
    expect(parseDataModelTag("<data_model>not json</data_model>")).toBeNull();
  });

  it("returns null when JSON lacks required fields", () => {
    expect(parseDataModelTag('<data_model>{"something":"else"}</data_model>')).toBeNull();
  });

  it("ignores content outside the tag", () => {
    const buf = `Planner output <data_model>${MODEL_JSON}</data_model> more output`;
    const model = parseDataModelTag(buf);
    expect(model!.name).toBe("CRM");
  });

  it("handles whitespace inside the tag", () => {
    const buf = `<data_model>\n  ${MODEL_JSON}\n</data_model>`;
    expect(parseDataModelTag(buf)!.name).toBe("CRM");
  });
});

describe("stripDataModelTags", () => {
  it("removes a single tag leaving surrounding text", () => {
    const buf = `before <data_model>${MODEL_JSON}</data_model> after`;
    expect(stripDataModelTags(buf)).toBe("before  after");
  });

  it("removes multiple tags", () => {
    const buf = `<data_model>${MODEL_JSON}</data_model>x<data_model>${MODEL_JSON}</data_model>`;
    expect(stripDataModelTags(buf)).toBe("x");
  });

  it("is a no-op when no tags are present", () => {
    expect(stripDataModelTags("plain text")).toBe("plain text");
  });
});
