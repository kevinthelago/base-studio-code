// A broken preview must not cost a process per failure, and a HEALTHY one must not cost one at all
// (#a-broken-preview-costs-a-process-spawn-to-report).
//
// Measured: `bsc components preview-error` was 590 spawns / 251.9s in one session — the fourth-largest cost in
// the app and pure overhead. Two shapes drove it. Reporting fired per failure, and 149 of 200 errors in
// one hour were byte-identical, so the log was told the same thing again and again. Clearing fired on
// every SUCCESSFUL render: `bsc` no-ops a clear for an id holding no error, but only after ~39ms of
// process start to discover that, and in a working Studio that is nearly every render.
//
// Each test imports the module FRESH: the bookkeeping is module-level, so sharing it between cases
// would let one test's recorded ids decide another's outcome.
import { beforeEach, describe, expect, it, vi } from "vitest";

const bsc = vi.hoisted(() =>
  // Parameters are declared so `bsc.mock.calls` types as a real tuple — an argument-less `vi.fn`
  // gives calls of type `[]`, and indexing it is a compile error rather than a runtime surprise.
  vi.fn(async (_projectKey: string | null, _args: string[], _stdin?: string) => ""));
const bscJson = vi.hoisted(() => vi.fn(async (_k: unknown, _a: unknown, fallback: unknown) => fallback));
vi.mock("@/shared/lib/core/bsc", () => ({
  bsc,
  bscJson,
  bscRun: vi.fn(async () => undefined),
  bscWrite: vi.fn(async () => undefined),
}));

/** A fresh module instance, so each test starts with an empty recorded-error map. */
const fresh = async () => {
  vi.resetModules();
  return await import("./componentBridge");
};
/** Only the preview-error argv — `loadComponents` and friends share the same mock. */
const previewCalls = () =>
  bsc.mock.calls.filter(([, args]) => args?.[1] === "preview-error");

beforeEach(() => {
  vi.clearAllMocks();
  bscJson.mockImplementation(async (_k, _a, fallback) => fallback);
});

describe("preview-error reporting does not spawn a process per event", () => {
  it("writes a failure once, and does not re-write the SAME message", async () => {
    const { recordPreviewError } = await fresh();
    await recordPreviewError("chart", "TypeError: x is undefined");
    await recordPreviewError("chart", "TypeError: x is undefined");
    await recordPreviewError("chart", "TypeError: x is undefined");
    expect(previewCalls()).toHaveLength(1);
    expect(bsc).toHaveBeenCalledWith(null, ["ui", "preview-error", "chart"], "TypeError: x is undefined");
  });

  it("still writes when the message CHANGES — a different failure is news", async () => {
    const { recordPreviewError } = await fresh();
    await recordPreviewError("chart", "first");
    await recordPreviewError("chart", "second");
    expect(previewCalls()).toHaveLength(2);
  });

  it("a healthy component clears NOTHING — the common case costs no process", async () => {
    const { clearPreviewError } = await fresh();
    await clearPreviewError("fine-1");
    await clearPreviewError("fine-2");
    expect(previewCalls()).toHaveLength(0);
  });

  it("clears exactly once for a component that WAS failing, then goes quiet", async () => {
    const { recordPreviewError, clearPreviewError } = await fresh();
    await recordPreviewError("chart", "boom");
    await clearPreviewError("chart");
    await clearPreviewError("chart"); // it is healthy now; asking again buys nothing
    const clears = previewCalls().filter(([, args]) => args[2] === "clear");
    expect(clears).toHaveLength(1);
    expect(bsc).toHaveBeenCalledWith(null, ["ui", "preview-error", "clear", "chart"]);
  });

  it("SEEDS from the durable log, so an error from a previous session is still cleared (#45/#60)", async () => {
    // The regression this guards: the map starts empty and the log does not. Believing "nothing is
    // recorded" on a fresh boot would skip every clear, and a component fixed between sessions would
    // keep a stale finding forever — the exact failure clearing was added to fix.
    bscJson.mockImplementation(async () => [{ id: "stale", message: "old failure" }]);
    const { clearPreviewError } = await fresh();
    await clearPreviewError("stale");
    expect(bsc).toHaveBeenCalledWith(null, ["ui", "preview-error", "clear", "stale"]);
    // One read serves every id — it replaces the N clear-spawns it makes unnecessary.
    expect(bscJson).toHaveBeenCalledTimes(1);
  });

  it("degrades to the old spawn-always behaviour when the seed read fails", async () => {
    // The failure modes are NOT symmetric. A missing clear leaves doctor reporting a fault a live
    // preview disproves (#45/#60); a redundant clear just costs a process `bsc` no-ops. So when the
    // seed read fails the map is not trustworthy, and clearing spawns exactly as it did before.
    bscJson.mockRejectedValue(new Error("no bsc"));
    const { clearPreviewError } = await fresh();
    await clearPreviewError("unknown");
    expect(bsc).toHaveBeenCalledWith(null, ["ui", "preview-error", "clear", "unknown"]);
  });
});
