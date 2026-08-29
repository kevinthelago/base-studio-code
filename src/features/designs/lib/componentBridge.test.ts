// #2469: the component-library + kit-usage bridges call the MERGED `bsc ui …` surface (the former
// `bsc component` verbs now mount under `bsc ui`; `bsc component` is a deprecated alias). These tests
// pin the exact argv so a regression back to the alias — or a verb typo — is caught here, not at runtime.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/shared/lib/core/bsc", () => ({
  bsc: vi.fn(async () => "[]"),
  bscJson: vi.fn(async (_k: unknown, _a: unknown, fallback: unknown) => fallback),
  bscRun: vi.fn(async () => undefined),
  bscWrite: vi.fn(async () => undefined),
}));

import { bsc, bscRun, bscWrite } from "@/shared/lib/core/bsc";
import type { ComponentRecord, Kit } from "@/features/designs/lib/model";
import {
  APP_RECONCILE_WRITER,
  dropComponent,
  dropKit,
  loadComponents,
  loadKits,
  projectComponent,
  pushComponent,
  pushKit,
  recordPreviewError,
  stampComponent,
} from "./componentBridge";
import { dropKitUsage, loadKitUsage, pushKitUsage } from "@/features/designs/lib/kitUsageBridge";

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

  it("a tombstone's `supersededBy` rides the projection — a dropped field would be silently erased on write-back", async () => {
    // #a-tombstone-can-name-what-superseded-it. `projectComponent` is an ALLOWLIST, and this projection is
    // ALSO what the app pushes back with `--replace` — so a stored field the projection does not model is
    // destroyed by the next app write. That is exactly how request #63 wiped 38 records.
    //
    // It would be a particularly bad place to repeat it: the tombstone's whole purpose is to be the one
    // fact that survives every reseed, so a pointer that the app quietly strips is worse than none.
    vi.mocked(bsc).mockResolvedValueOnce(JSON.stringify([
      { id: "oldcard", suppressed: true, supersededBy: "newwidget" },
      { id: "plain", suppressed: true }, // a bare tombstone ⇒ absent stays absent
    ]));
    const comps = await loadComponents();
    expect(comps?.[0].supersededBy).toBe("newwidget");
    expect(comps?.[1].supersededBy).toBeUndefined();
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

  // #4197: `bsc ui set` MERGES by default (so a fleet worker's partial edit cannot delete the rest of a
  // record whose source file is gone). The app is the opposite case — it holds the WHOLE record, and
  // `reconcileSeed`'s seed-authoritative reset (#3723) only converges if the store copy is overwritten
  // field-for-field, so the bridge must keep asking for the verbatim write.
  it("writes component upsert/removal through the ui surface, replacing the whole record", async () => {
    const comp = { id: "c1" } as unknown as ComponentRecord;
    await pushComponent(comp);
    expect(bscWrite).toHaveBeenCalledWith(null, ["ui", "set", "--replace"], comp);
    await dropComponent("c1");
    expect(bscRun).toHaveBeenCalledWith(null, ["ui", "remove", "c1"]);
  });

  it("guards a push with the rev the caller READ, so a store that moved refuses the write", async () => {
    // #a-stale-app-copy-overwrites-a-designer-edit — the rev8/rev9 sequence, exactly. The app read
    // plan-body-streams at rev 7, a designer edited it out of band to rev 8, and 23 minutes later the
    // app's converge pushed its pre-edit copy back — destroying the fix with no notice to anyone.
    //
    // `--if-version` names the rev this write is BASED on; the store refuses when it has moved. The
    // guard already existed in `bsc ui set` and nothing was sending it.
    const comp = { id: "plan-body-streams", srcText: "pre-edit" } as unknown as ComponentRecord;
    await pushComponent(comp, { ifVersion: 7 });
    expect(bscWrite).toHaveBeenCalledWith(null, ["ui", "set", "--replace", "--if-version", "7"], comp);
  });

  it("leaves an UNGUARDED push exactly as it was — no rev, no flag", async () => {
    // Every existing caller must be unaffected: a record the store lacks has no prior rev to name.
    const comp = { id: "c-new" } as unknown as ComponentRecord;
    await pushComponent(comp, { ifVersion: undefined });
    expect(bscWrite).toHaveBeenCalledWith(null, ["ui", "set", "--replace"], comp);
  });

  it("does not throw when the store REFUSES the write, and says so", async () => {
    // A refused write must not break the caller's render — but it must stop being indistinguishable
    // from an unreachable store, which is what made this class invisible: the old bare `catch {}` gave
    // "my edit vanished" no counterpart anywhere in the log.
    vi.mocked(bscWrite).mockRejectedValueOnce(new Error("version conflict on component 'x': its current rev is 8, not 7"));
    await expect(pushComponent({ id: "x" } as unknown as ComponentRecord, { ifVersion: 7 })).resolves.toBeUndefined();
  });

  it("REFUSES to write a lite record — the #63 bulk-overwrite shape", async () => {
    // #a-lite-record-must-never-be-written-back. On 2026-08-14 at 17:36:50-51Z, one second after an app
    // boot, THIRTY-EIGHT records took an srcText write; 34 shrank (`ui-tree` lost 6,887 chars) and
    // `glance-node`'s change entry named srcText plus exactly the six fields `projectComponent` defaults.
    //
    // That is a `--graph` LITE record being pushed with `--replace`: its emptiness is the projection's
    // defaults, not the component's content. The rev guard does not catch it — those writes were not
    // stale, so they passed. Lossy is not stale.
    const lite = {
      ...projectComponent({ id: "ui-tab-bar", name: "TabBar", kitId: "base-studio-code" }),
      lite: true as const,
    };
    // The exact shape: everything the real record carries is a default here.
    expect(lite.srcText).toBe("");
    expect([lite.tags, lite.variants, lite.whenUse, lite.whenNot].map((v) => v.length)).toEqual([0, 1, 0, 0]);

    await pushComponent(lite);
    expect(bscWrite, "a defaults-only record must never reach the store").not.toHaveBeenCalled();
  });

  it("still writes a FULL record — the fast-paint hydrate is not disabled, only its records are barred", async () => {
    const full = projectComponent({ id: "ui-tab-bar", name: "TabBar", kitId: "base-studio-code", srcText: "export const TabBar = () => null;" });
    await pushComponent(full);
    expect(bscWrite).toHaveBeenCalledWith(null, ["ui", "set", "--replace"], full);
  });

  it("writes kit upsert/removal through the ui surface, replacing the whole record", async () => {
    const kit = { id: "k1" } as unknown as Kit;
    await pushKit(kit);
    expect(bscWrite).toHaveBeenCalledWith(null, ["ui", "kit", "set", "--replace"], kit);
    await dropKit("k1");
    expect(bscRun).toHaveBeenCalledWith(null, ["ui", "kit", "remove", "k1"]);
  });

  // Request #98 — a background write the APP ITSELF issues (a seed reconcile push, a provenance
  // restamp) must be `bsc ui log`-distinguishable from a write some other session/fork made to the
  // same record: `by: "unknown"` on both looked identical, so a designer had to reconstruct which was
  // which from timing + content alone (dropdown rev 3, request #98's own repro).
  it("tags a component push as the caller names it (`opts.by`), untagged by default", async () => {
    const comp = { id: "c1" } as unknown as ComponentRecord;
    await pushComponent(comp, { by: APP_RECONCILE_WRITER });
    expect(bscWrite).toHaveBeenCalledWith(null, ["ui", "set", "--replace", "--by", APP_RECONCILE_WRITER], comp);

    await pushComponent(comp);
    expect(bscWrite).toHaveBeenLastCalledWith(null, ["ui", "set", "--replace"], comp);
  });

  it("tags a kit push as the caller names it (`by`), untagged by default", async () => {
    const kit = { id: "k1" } as unknown as Kit;
    await pushKit(kit, APP_RECONCILE_WRITER);
    expect(bscWrite).toHaveBeenCalledWith(null, ["ui", "kit", "set", "--replace", "--by", APP_RECONCILE_WRITER], kit);

    await pushKit(kit);
    expect(bscWrite).toHaveBeenLastCalledWith(null, ["ui", "kit", "set", "--replace"], kit);
  });

  it("stampComponent (the #4207 provenance repair — always app-driven) defaults its `by` to app-reconcile", async () => {
    await stampComponent("fleetpage", "abc123");
    expect(bscWrite).toHaveBeenCalledWith(null, ["ui", "set", "--by", APP_RECONCILE_WRITER], { id: "fleetpage", builtin: true, seedHash: "abc123" });

    await stampComponent("fleetpage", "abc123", "someone-else");
    expect(bscWrite).toHaveBeenLastCalledWith(null, ["ui", "set", "--by", "someone-else"], { id: "fleetpage", builtin: true, seedHash: "abc123" });
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
