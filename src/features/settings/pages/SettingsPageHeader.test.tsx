import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { SettingsPageHeader, SettingsSubHeader } from "./SettingsPageHeader";

describe("SettingsPageHeader", () => {
  it("renders the title as a mono h2 and the description as a muted paragraph", () => {
    render(<SettingsPageHeader title="General" description="Some copy here." />);
    const heading = screen.getByRole("heading", { level: 2, name: "General" });
    expect(heading).toHaveClass("mono");
    const desc = screen.getByText("Some copy here.");
    expect(desc.tagName).toBe("P");
    expect(desc).toHaveStyle({ color: "var(--fg-muted)" });
  });

  it("defaults the description bottom margin to 4px and honours descMb", () => {
    const { rerender } = render(<SettingsPageHeader title="A" description="d" />);
    expect(screen.getByText("d")).toHaveStyle({ margin: "0 0 4px" });
    rerender(<SettingsPageHeader title="A" description="d" descMb={22} />);
    expect(screen.getByText("d")).toHaveStyle({ margin: "0 0 22px" });
  });

  it("renders SettingsSubHeader as an uppercase mono h3", () => {
    render(<SettingsSubHeader>Appearance</SettingsSubHeader>);
    const sub = screen.getByRole("heading", { level: 3, name: "Appearance" });
    expect(sub).toHaveClass("mono");
    expect(sub).toHaveStyle({ textTransform: "uppercase" });
  });
});
