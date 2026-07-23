// #3618 — ProfiledRegion is a transparent wrapper: it always renders its children (a React <Profiler>
// around them) and only LOGS when a commit is slow AND metrics are on. The slow-commit log path depends
// on React's own timing (not unit-testable in jsdom, where actualDuration is ~0); the timing/log logic it
// shares with the graph layout is covered by the `timedSync` tests. This guards the render contract.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProfiledRegion } from "./renderProfiler";

describe("ProfiledRegion (#3618)", () => {
  it("renders its children unchanged (a transparent profiling wrapper)", () => {
    render(
      <ProfiledRegion id="graph-x">
        <div>graph-body</div>
      </ProfiledRegion>,
    );
    expect(screen.getByText("graph-body")).toBeTruthy();
  });
});
