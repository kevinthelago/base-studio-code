import { describe, it, expect } from "vitest";
import { parsePipelineTags, stripPipelineTags } from "./pipelineTag";

describe("pipelineTag — parse", () => {
  it("parses id + cmd and collects the rest as args", () => {
    const tags = parsePipelineTags(`prose <pipeline id="vue-components" cmd="run" variant="button" size="lg" /> more`);
    expect(tags).toEqual([{ id: "vue-components", cmd: "run", args: { variant: "button", size: "lg" } }]);
  });

  it("parses a bare command with no extra args", () => {
    expect(parsePipelineTags(`<pipeline id="vue" cmd="confirm" />`))
      .toEqual([{ id: "vue", cmd: "confirm", args: {} }]);
  });

  it("parses multiple tags in stream order", () => {
    const tags = parsePipelineTags(`<pipeline id="a" cmd="next" /><pipeline id="a" cmd="save" />`);
    expect(tags.map(t => t.cmd)).toEqual(["next", "save"]);
  });

  it("accepts smart quotes like the other planning tags", () => {
    const tags = parsePipelineTags(`<pipeline id=“vue” cmd=“run” />`);
    expect(tags).toEqual([{ id: "vue", cmd: "run", args: {} }]);
  });

  it("skips tags missing id or cmd, or with an unknown cmd", () => {
    expect(parsePipelineTags(`<pipeline cmd="run" />`)).toEqual([]);            // no id
    expect(parsePipelineTags(`<pipeline id="x" />`)).toEqual([]);              // no cmd
    expect(parsePipelineTags(`<pipeline id="x" cmd="frobnicate" />`)).toEqual([]); // bad cmd
  });

  it("does not match unrelated tags", () => {
    expect(parsePipelineTags(`<pipeline_screen id="x" cmd="run" />`)).toEqual([]);
    expect(parsePipelineTags(`<ui_preview screen="Home" />`)).toEqual([]);
  });
});

describe("pipelineTag — strip", () => {
  it("removes every pipeline tag, leaving surrounding prose", () => {
    const out = stripPipelineTags(`a <pipeline id="x" cmd="run" /> b <pipeline id="y" cmd="save" /> c`);
    expect(out).toBe("a  b  c");
  });
});
