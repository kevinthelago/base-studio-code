import { describe, it, expect } from "vitest";
import { parseWorkflowYaml } from "../lib/workflowYaml";

describe("parseWorkflowYaml — on triggers", () => {
  it("parses the block form with branches and a cron schedule", () => {
    const yaml = `
name: CI
on:
  push:
    branches: [main, develop]
  pull_request:
  schedule:
    - cron: '0 9 * * 1'
  workflow_dispatch:
jobs: {}
`;
    const { on } = parseWorkflowYaml(yaml);
    expect(on.map((t) => t.name)).toEqual([
      "push",
      "pull_request",
      "schedule",
      "workflow_dispatch",
    ]);
    expect(on.find((t) => t.name === "push")!.detail).toBe("branches: main, develop");
    expect(on.find((t) => t.name === "pull_request")!.detail).toBeNull();
    expect(on.find((t) => t.name === "schedule")!.detail).toBe("cron: 0 9 * * 1");
    expect(on.find((t) => t.name === "workflow_dispatch")!.detail).toBeNull();
  });

  it("parses a block list of branches", () => {
    const yaml = `
on:
  push:
    branches:
      - main
      - "release/**"
`;
    const { on } = parseWorkflowYaml(yaml);
    expect(on[0]).toEqual({ name: "push", detail: "branches: main, release/**" });
  });

  it("parses the inline scalar form", () => {
    expect(parseWorkflowYaml("on: push\n").on).toEqual([{ name: "push", detail: null }]);
  });

  it("parses the inline flow-sequence form", () => {
    const { on } = parseWorkflowYaml("on: [push, pull_request]\n");
    expect(on).toEqual([
      { name: "push", detail: null },
      { name: "pull_request", detail: null },
    ]);
  });

  it("handles the quoted 'on' key (YAML 1.1 boolean gotcha)", () => {
    const { on } = parseWorkflowYaml('"on":\n  push:\n');
    expect(on).toEqual([{ name: "push", detail: null }]);
  });
});

describe("parseWorkflowYaml — env", () => {
  it("parses top-level env key/values and strips quotes", () => {
    const yaml = `
env:
  RUST_VERSION: "1.82"
  CARGO_TERM_COLOR: always
  RUSTFLAGS: '-D warnings'
jobs: {}
`;
    const { env } = parseWorkflowYaml(yaml);
    expect(env).toEqual([
      { key: "RUST_VERSION", value: "1.82" },
      { key: "CARGO_TERM_COLOR", value: "always" },
      { key: "RUSTFLAGS", value: "-D warnings" },
    ]);
  });

  it("does not pick up env nested inside a job", () => {
    const yaml = `
jobs:
  test:
    env:
      NOT_TOPLEVEL: 1
`;
    expect(parseWorkflowYaml(yaml).env).toEqual([]);
  });
});

describe("parseWorkflowYaml — jobs", () => {
  it("parses job id, name, runs-on, and step labels", () => {
    const yaml = `
jobs:
  build:
    name: Build & Test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Set up Rust
        uses: dtolnay/rust-toolchain@stable
      - run: cargo test --all
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: cargo clippy
`;
    const { jobs } = parseWorkflowYaml(yaml);
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toEqual({
      id: "build",
      name: "Build & Test",
      runsOn: "ubuntu-latest",
      steps: ["checkout", "Set up Rust", "cargo test --all"],
    });
    expect(jobs[1]).toEqual({
      id: "lint",
      name: null,
      runsOn: "ubuntu-latest",
      steps: ["checkout", "cargo clippy"],
    });
  });

  it("preserves an expression runs-on and truncates a long run", () => {
    const yaml = `
jobs:
  matrix:
    runs-on: \${{ matrix.os }}
    steps:
      - run: echo this is a really long command that should get truncated for display
`;
    const { jobs } = parseWorkflowYaml(yaml);
    expect(jobs[0].runsOn).toBe("${{ matrix.os }}");
    expect(jobs[0].steps[0].endsWith("…")).toBe(true);
    expect(jobs[0].steps[0].length).toBe(32);
  });
});

describe("parseWorkflowYaml — robustness", () => {
  it("returns empty sections for an empty or unrecognized file", () => {
    expect(parseWorkflowYaml("")).toEqual({ on: [], env: [], jobs: [] });
    expect(parseWorkflowYaml("# just a comment\n")).toEqual({ on: [], env: [], jobs: [] });
  });

  it("ignores full-line and trailing comments", () => {
    const yaml = `
on:
  push:  # run on every push
    branches: [main]  # only main
env:
  KEY: value # trailing
`;
    const result = parseWorkflowYaml(yaml);
    expect(result.on[0]).toEqual({ name: "push", detail: "branches: main" });
    expect(result.env[0]).toEqual({ key: "KEY", value: "value" });
  });
});
