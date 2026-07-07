// Settings nav rail (#2493) — the selected category is marked by the elevated background + brighter
// text ONLY; the old 2px accent borderLeft (and its compensating padding shift) is gone.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SettingsWorkspace } from "./index";
import { useAppStore } from "@/store";

describe("settings nav selection style (#2493)", () => {
  it("the selected category carries no left accent border and no padding shift", () => {
    useAppStore.setState({ settingsSection: "general" });
    render(<SettingsWorkspace />);
    // The nav item is the clickable mono Box whose label is its text content (the page body may
    // also say "General", so filter to the rail item).
    const item = screen.getAllByText("General").find(
      (el) => el.className.includes("mono") && el.style.cursor === "pointer",
    )!;
    expect(item).toBeTruthy();
    expect(item.style.borderLeft).toBe("");
    // Selected and unselected items share one padding — no compensating shift.
    expect(item.style.padding).toBe("7px 12px");
    expect(item.style.paddingLeft).toBe("12px");
  });
});
