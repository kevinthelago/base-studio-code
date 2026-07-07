// #2514 — the packaged kit assembly must IGNORE the config-dir overlay. An auto-seeded (or stale)
// `config/components/` copy of a packaged kit file acted as a silent override that pinned the
// effective seed at the copy's drop-date roster, so the #2483 hash refresh could never refresh or
// retire anything (the live #2514 incident); a copy of a RETIRED stem (`examples.json`) would
// resurrect the retired kit as a ghost. These tests pin makeBuiltinKits to the embedded data.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { primeConfigOverrides, resetConfigOverridesForTest } from "@/shared/lib/core/configOverrides";
import { makeBuiltinKits } from "./builtinKits";
import { seedHashOf } from "./seedRefresh";

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  resetConfigOverridesForTest();
});

describe("makeBuiltinKits ignores the config-dir overlay (#2514)", () => {
  it("a config-dir copy of a PACKAGED kit stem does not pin the seed", async () => {
    // The #2514 trap, verbatim: a stale first-run snapshot of react-ui.json sitting in the config
    // dir (43-record roster, no tech/style). If it overlaid, refresh/retire could never fire.
    const stale = {
      kit: { id: "react-ui", name: "react-ui", stack: "React · TypeScript", dot: "var(--info)", builtin: true },
      components: [],
    };
    vi.mocked(invoke).mockResolvedValue({ "components/react-ui.json": JSON.stringify(stale) });
    await primeConfigOverrides();
    const { kits, components } = makeBuiltinKits();
    const reactUi = kits.find((k) => k.id === "react-ui")!;
    expect(reactUi.tech).toBeDefined(); // the packaged #2487 axes, not the stale copy
    expect(reactUi.style).toBeDefined();
    expect(components.length).toBeGreaterThan(0); // the packaged roster, not the empty stale copy
  });

  it("a config-dir copy of a RETIRED kit stem does not resurrect it", async () => {
    const ghost = {
      kit: { id: "examples", name: "examples", stack: "demo · multi-stack", dot: "var(--state-wait)", builtin: true },
      components: [],
    };
    vi.mocked(invoke).mockResolvedValue({ "components/examples.json": JSON.stringify(ghost) });
    await primeConfigOverrides();
    const { kits } = makeBuiltinKits();
    expect(kits.some((k) => k.id === "examples")).toBe(false);
  });

  it("assembles the embedded kits stamped builtin + self-consistent seedHash", () => {
    const { kits, components } = makeBuiltinKits();
    expect(kits.length).toBeGreaterThan(0);
    for (const rec of [...kits, ...components]) {
      expect(rec.builtin).toBe(true);
      expect(seedHashOf(rec)).toBe(rec.seedHash);
    }
  });
});
