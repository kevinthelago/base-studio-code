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
import { dropComponent, dropKit, loadComponents, loadKits, pushComponent, pushKit } from "./componentBridge";
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
