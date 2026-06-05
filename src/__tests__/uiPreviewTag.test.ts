import { describe, it, expect } from "vitest";
import { parseUiPreviewTags, stripUiPreviewTags } from "../screens/projects/uiPreviewTag";

describe("uiPreviewTag (#533)", () => {
  it("parses screen + mode (mode defaults to 2d)", () => {
    expect(parseUiPreviewTags(`pre <ui_preview screen="Login.jsx" mode="3d" /> post`))
      .toEqual([{ screen: "Login.jsx", mode: "3d" }]);
    expect(parseUiPreviewTags(`<ui_preview screen="Home.jsx" />`))
      .toEqual([{ screen: "Home.jsx", mode: "2d" }]);
  });

  it("tolerates smart quotes and collects multiple tags", () => {
    const tags = parseUiPreviewTags(`<ui_preview screen=“A.jsx” /> x <ui_preview screen="B.jsx" mode="2d" />`);
    expect(tags.map((t) => t.screen)).toEqual(["A.jsx", "B.jsx"]);
  });

  it("ignores bare text and a tag with an unsupported mode", () => {
    expect(parseUiPreviewTags("no tags here")).toEqual([]);
    // an unsupported mode value makes the whole tag malformed → ignored entirely
    expect(parseUiPreviewTags(`<ui_preview screen="A.jsx" mode="vr" />`)).toEqual([]);
  });

  it("strips the tags from the buffer", () => {
    const t = `keep <ui_preview screen="A.jsx" mode="2d" /> this`;
    expect(stripUiPreviewTags(t)).toBe("keep  this");
  });
});
