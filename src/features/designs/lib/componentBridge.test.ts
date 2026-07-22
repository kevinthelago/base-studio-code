// #2469: the component-library + kit-usage bridges call the MERGED `bsc ui …` surface (the former
// `bsc component` verbs now mount under `bsc ui`; `bsc component` is a deprecated alias). These tests
// pin the exact argv so a regression back to the alias — or a verb typo — is caught here, not at runtime.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/shared/lib/core/bsc", () => ({
  bsc: vi.fn(async () => "[]"),
  bscRun: vi.fn(async () => undefined),
  bscWrite: vi.fn(async () => undefined),
}));

import { bsc, bscRun, bscWrite } from "@/shared/lib/core/bsc";
import type { ComponentRecord, Kit } from "./model";
import { dropComponent, dropKit, loadComponents, loadKits, pushComponent, pushKit, recordPreviewError } from "./componentBridge";
import { dropKitUsage, loadKitUsage, pushKitUsage } from "./kitUsageBridge";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("componentBridge → bsc ui (#2469)", () => {
  it("loads components via `bsc ui list --full`", async () => {
    expect(await loadComponents()).toEqual([]);
    expect(bsc).toHaveBeenCalledWith(null, ["ui", "list", "--full"]);
  });

  it("loads kits via `bsc ui kit list --full`", async () => {
    expect(await loadKits()).toEqual([]);
    expect(bsc).toHaveBeenCalledWith(null, ["ui", "kit", "list", "--full"]);
  });

  it("kit rows carry the #2487 tech/style axes verbatim — an absent axis stays ABSENT, never defaulted (the #2483 seedHash transition depends on it)", async () => {
    vi.mocked(bsc).mockResolvedValueOnce(JSON.stringify([
      { id: "react-ui", name: "react-ui", tech: "react", style: "studio" },
      { id: "legacy", name: "legacy" }, // a pre-#2487 store copy
    ]));
    const kits = await loadKits();
    expect(kits?.[0]).toMatchObject({ tech: "react", style: "studio" });
    expect(kits?.[1].tech).toBeUndefined();
    expect(kits?.[1].style).toBeUndefined();
  });

  it("a component's #3048 `group` rides verbatim through loadComponents — absent stays absent", async () => {
    vi.mocked(bsc).mockResolvedValueOnce(JSON.stringify([
      { id: "chart", name: "Chart", kitId: "react-ui", role: "composite", group: "data-viz" },
      { id: "btn", name: "Button", kitId: "react-ui", role: "primitive" }, // no group ⇒ ungrouped
    ]));
    const comps = await loadComponents();
    expect(comps?.[0].group).toBe("data-viz");
    expect(comps?.[1].group).toBeUndefined();
  });

  it("a page node's #3569 `spec` (GeneralNode skeleton) rides verbatim through loadComponents — so the host can render from the store", async () => {
    const spec = { type: "Box", props: { className: "an-page" }, children: [{ type: "Slot", props: { name: "workerBoard" } }] };
    vi.mocked(bsc).mockResolvedValueOnce(JSON.stringify([
      { id: "fleetpage", name: "FleetPage", kitId: "harvested", role: "page", spec },
      { id: "btn", name: "Button", kitId: "react-ui", role: "primitive" }, // no spec ⇒ undefined
    ]));
    const comps = await loadComponents();
    expect(comps?.[0].spec).toEqual(spec);
    expect(comps?.[1].spec).toBeUndefined();
  });

  it("writes component upsert/removal through the ui surface", async () => {
    const comp = { id: "c1" } as unknown as ComponentRecord;
    await pushComponent(comp);
    expect(bscWrite).toHaveBeenCalledWith(null, ["ui", "set"], comp);
    await dropComponent("c1");
    expect(bscRun).toHaveBeenCalledWith(null, ["ui", "remove", "c1"]);
  });

  it("writes kit upsert/removal through the ui surface", async () => {
    const kit = { id: "k1" } as unknown as Kit;
    await pushKit(kit);
    expect(bscWrite).toHaveBeenCalledWith(null, ["ui", "kit", "set"], kit);
    await dropKit("k1");
    expect(bscRun).toHaveBeenCalledWith(null, ["ui", "kit", "remove", "k1"]);
  });

  it("records a preview runtime error via `bsc ui preview-error <id>` with the message on stdin (#3165)", async () => {
    await recordPreviewError("chart", "TypeError: x is undefined");
    expect(bsc).toHaveBeenCalledWith(null, ["ui", "preview-error", "chart"], "TypeError: x is undefined");
  });

  it("recordPreviewError never throws when the bridge is unreachable (banner-only)", async () => {
    vi.mocked(bsc).mockRejectedValueOnce(new Error("no bsc"));
    await expect(recordPreviewError("chart", "boom")).resolves.toBeUndefined();
  });
});

describe("kitUsageBridge → bsc ui usage (#2469)", () => {
  it("loads consumer edges via `bsc ui usage list --json`", async () => {
    expect(await loadKitUsage()).toEqual([]);
    expect(bsc).toHaveBeenCalledWith(null, ["ui", "usage", "list", "--json"]);
  });

  it("adds and removes edges on the ui surface", async () => {
    await pushKitUsage("proj", "react-ui");
    expect(bscRun).toHaveBeenCalledWith(null, ["ui", "usage", "add", "proj", "react-ui"]);
    await dropKitUsage("proj>react-ui");
    expect(bscRun).toHaveBeenCalledWith(null, ["ui", "usage", "remove", "proj>react-ui"]);
  });
});
