import { describe, it, expect } from "vitest";
import type { Tab } from "../components/chrome/Tabstrip";

// Mirror of the helper in App.tsx — tested in isolation
function nextTabName(tabs: Tab[]): string {
  const nums = tabs
    .map(t => t.name.match(/^tab-(\d+)$/)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number);
  return `tab-${nums.length === 0 ? 1 : Math.max(...nums) + 1}`;
}

describe("nextTabName", () => {
  it("returns tab-1 when there are no tabs", () => {
    expect(nextTabName([])).toBe("tab-1");
  });

  it("returns tab-N+1 where N is the highest existing tab number", () => {
    const tabs: Tab[] = [
      { name: "tab-1", layout: "1×1" },
      { name: "tab-2", layout: "2×2" },
      { name: "tab-3", layout: "1×1" },
    ];
    expect(nextTabName(tabs)).toBe("tab-4");
  });

  it("skips gaps — uses max+1, not first gap", () => {
    const tabs: Tab[] = [
      { name: "tab-1", layout: "1×1" },
      { name: "tab-5", layout: "1×1" },
    ];
    expect(nextTabName(tabs)).toBe("tab-6");
  });

  it("ignores tabs with non-standard names", () => {
    const tabs: Tab[] = [
      { name: "my-workspace", layout: "2×2" },
      { name: "tab-3",        layout: "1×1" },
    ];
    expect(nextTabName(tabs)).toBe("tab-4");
  });

  it("returns tab-1 when all tabs have custom names", () => {
    const tabs: Tab[] = [
      { name: "orchestrator", layout: "3×3" },
      { name: "feat/tunnel",  layout: "2×2" },
    ];
    expect(nextTabName(tabs)).toBe("tab-1");
  });
});
