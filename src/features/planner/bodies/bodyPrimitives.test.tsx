import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Card, Kv, ModeChip, EntityChip, Readiness, ListItemCard } from "./bodyPrimitives";
import { MONO, grpLabel, monoSm } from "./bodyStyles";

describe("bodyStyles — shared inline-style constants", () => {
  it("exposes the mono token and the byte-identical style objects extracted from the bodies", () => {
    expect(MONO).toBe("var(--mono)");
    expect(grpLabel).toEqual({
      fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)",
      textTransform: "uppercase", letterSpacing: ".06em",
    });
    expect(monoSm).toEqual({ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" });
  });
});

describe("bodyPrimitives — shared focused-pane primitives", () => {
  it("renders a Card with its label and children", () => {
    render(<Card label="readiness" hint="2/3"><span>inner</span></Card>);
    expect(screen.getByText("readiness")).toBeTruthy();
    expect(screen.getByText("2/3")).toBeTruthy();
    expect(screen.getByText("inner")).toBeTruthy();
  });

  it("renders a Kv pair, falling back to an em-dash for a missing value", () => {
    render(<Kv k="region" v="us-east" />);
    expect(screen.getByText("region")).toBeTruthy();
    expect(screen.getByText("us-east")).toBeTruthy();
  });

  it("renders a Kv em-dash when the value is absent", () => {
    render(<Kv k="region" />);
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("renders the mode and entity chips", () => {
    render(<><ModeChip mode="scrape" /><EntityChip name="Account" /></>);
    expect(screen.getByText("scrape")).toBeTruthy();
    expect(screen.getByText("Account")).toBeTruthy();
  });

  it("renders Readiness with a met gate when every check passes", () => {
    render(<Readiness checks={[{ id: "a", label: "all set", ok: true }]} />);
    expect(screen.getByText("all set")).toBeTruthy();
    expect(screen.getByText("gate met")).toBeTruthy();
  });

  it("renders a ListItemCard with title, optional meta, and badge", () => {
    const { rerender } = render(<ListItemCard title="my-skill" meta="does a thing" badge={<span>NEW</span>} />);
    expect(screen.getByText("my-skill")).toBeTruthy();
    expect(screen.getByText("does a thing")).toBeTruthy();
    expect(screen.getByText("NEW")).toBeTruthy();
    // meta omitted when not provided
    rerender(<ListItemCard title="bare" />);
    expect(screen.getByText("bare")).toBeTruthy();
    expect(screen.queryByText("does a thing")).toBeNull();
  });
});
