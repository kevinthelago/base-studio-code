import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Card } from "./data/Card";
import { Chip } from "./data/Chip";
import { FillBar } from "./data/FillBar";
import { Code } from "./data/Code";
import { Text } from "./typography/Text";
import { TextField } from "./controls/Field";

// #2302 — every content component renders its own shape-matched skeleton when `loading`, via the
// shared Skeleton (an aria-hidden shimmer Box), and hides its real content.
const shimmers = (c: HTMLElement) => c.querySelectorAll('[aria-hidden="true"]').length;

describe("component loading states (#2302)", () => {
  it("Card: skeleton body when loading, real body otherwise", () => {
    const { container, rerender } = render(<Card loading>the real body</Card>);
    expect(screen.queryByText("the real body")).toBeNull();
    expect(shimmers(container)).toBeGreaterThan(0);
    rerender(<Card>the real body</Card>);
    expect(screen.getByText("the real body")).toBeTruthy();
    expect(shimmers(container)).toBe(0);
  });

  it("Chip: a single shimmer pill when loading, hides the label", () => {
    const { container } = render(<Chip loading>status</Chip>);
    expect(screen.queryByText("status")).toBeNull();
    expect(shimmers(container)).toBe(1);
  });

  it("Text: an inline shimmer line when loading, hides the text", () => {
    const { container } = render(<Text loading>hello world</Text>);
    expect(screen.queryByText("hello world")).toBeNull();
    expect(shimmers(container)).toBe(1);
  });

  it("FillBar: an indeterminate shimmer track when loading", () => {
    const { container } = render(<FillBar value={0.5} loading />);
    expect(shimmers(container)).toBe(1);
  });

  it("Code: shimmer lines inside the frame when loading, hides the text", () => {
    const { container } = render(<Code loading>console.log(1)</Code>);
    expect(screen.queryByText("console.log(1)")).toBeNull();
    expect(shimmers(container)).toBeGreaterThan(0);
  });

  it("TextField: keeps the label but skeletons the input when loading", () => {
    const { container } = render(<TextField label="Name" value="x" onChange={() => {}} loading />);
    expect(container.querySelector("input")).toBeNull();
    expect(screen.getByText("Name")).toBeTruthy();
    expect(shimmers(container)).toBe(1);
  });
});
