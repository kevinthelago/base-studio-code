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
      { id: "chart", name: "Chart", kitId: "react-ui", role: "composite", folder: "data-viz" },
      { id: "btn", name: "Button", kitId: "react-ui", role: "primitive" }, // no group ⇒ ungrouped
    ]));
    const comps = await loadComponents();
    expect(comps?.[0].folder).toBe("data-viz");
    expect(comps?.[1].folder).toBeUndefined();
  });

  it("a component's #3878 `tests` + #3810 `analytics` manifests ride verbatim — absent stays absent (#3884)", async () => {
    // `projectComponent` is an ALLOWLIST: a field missing from it is dropped on EVERY hydrate. Both of
    // these were declared as contracts before anything populated them, so the gap was invisible until the
    // inspector's Tests tab went to read `tests` and found it always empty. The seed round-trip contract
    // (`seed === load(push(seed))`) breaks the same way for any record carrying an unlisted field.
    vi.mocked(bsc).mockResolvedValueOnce(JSON.stringify([
      {
        id: "btn", name: "Button", kitId: "react-ui", role: "primitive",
        analytics: [{ event: "click", props: [{ name: "label", type: "string" }] }],
        tests: [{ name: "fires onClick", src: "it('fires', () => {});" }],
      },
      { id: "txt", name: "Text", kitId: "react-ui", role: "primitive" }, // neither ⇒ both absent
    ]));
    const comps = await loadComponents();
    expect(comps?.[0].tests).toEqual([{ name: "fires onClick", src: "it('fires', () => {});" }]);
    expect(comps?.[0].analytics?.[0].event).toBe("click");
    expect(comps?.[1].tests).toBeUndefined();
    expect(comps?.[1].analytics).toBeUndefined();
  });

  it("a component's #3568 change `history` + provenance ride through loadComponents (the inspector History tab reads them)", async () => {
    vi.mocked(bsc).mockResolvedValueOnce(JSON.stringify([
      {
        id: "btn", name: "Button", kitId: "react-ui", role: "primitive",
        rev: 2, updatedAt: "2026-07-16T00:01:00Z", updatedBy: "alice",
        history: [
          { rev: 1, at: "2026-07-16T00:00:00Z", by: "designer", note: "initial", changed: ["created"] },
          { rev: 2, at: "2026-07-16T00:01:00Z", by: "alice", changed: ["name"] },
        ],
      },
      { id: "chip", name: "Chip", kitId: "react-ui", role: "primitive" }, // legacy — no stamp/history
    ]));
    const comps = await loadComponents();
    expect(comps?.[0]).toMatchObject({ rev: 2, updatedBy: "alice" });
    expect(comps?.[0].history).toHaveLength(2);
    expect(comps?.[0].history?.[1]).toEqual({ rev: 2, at: "2026-07-16T00:01:00Z", by: "alice", changed: ["name"] });
    // A legacy row surfaces no provenance (absent ⇒ the History tab falls back).
    expect(comps?.[1].history).toBeUndefined();
    expect(comps?.[1].rev).toBeUndefined();
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
