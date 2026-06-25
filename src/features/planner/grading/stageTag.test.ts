import { describe, it, expect } from "vitest";
import { parseStageTags, stripStageTags } from "./stageTag";

describe("stageTag — parse", () => {
  it("parses id + cmd and collects the rest as args", () => {
    const tags = parseStageTags(`prose <pipeline id="vue-components" cmd="run" variant="button" size="lg" /> more`);
    expect(tags).toEqual([{ id: "vue-components", cmd: "run", args: { variant: "button", size: "lg" } }]);
  });

  it("parses a bare command with no extra args", () => {
    expect(parseStageTags(`<pipeline id="vue" cmd="confirm" />`))
      .toEqual([{ id: "vue", cmd: "confirm", args: {} }]);
  });

  it("parses multiple tags in stream order", () => {
    const tags = parseStageTags(`<pipeline id="a" cmd="next" /><pipeline id="a" cmd="save" />`);
    expect(tags.map(t => t.cmd)).toEqual(["next", "save"]);
  });

  it("accepts smart quotes like the other planning tags", () => {
    const tags = parseStageTags(`<pipeline id=“vue” cmd=“run” />`);
    expect(tags).toEqual([{ id: "vue", cmd: "run", args: {} }]);
  });

  it("skips tags missing id or cmd, or with an unknown cmd", () => {
    expect(parseStageTags(`<pipeline cmd="run" />`)).toEqual([]);            // no id
    expect(parseStageTags(`<pipeline id="x" />`)).toEqual([]);              // no cmd
    expect(parseStageTags(`<pipeline id="x" cmd="frobnicate" />`)).toEqual([]); // bad cmd
  });

  it("does not match unrelated tags", () => {
    expect(parseStageTags(`<pipeline_screen id="x" cmd="run" />`)).toEqual([]);
    expect(parseStageTags(`<ui_preview screen="Home" />`)).toEqual([]);
  });
});

describe("stageTag — strip", () => {
  it("removes every pipeline tag, leaving surrounding prose", () => {
    const out = stripStageTags(`a <pipeline id="x" cmd="run" /> b <pipeline id="y" cmd="save" /> c`);
    expect(out).toBe("a  b  c");
  });
});
