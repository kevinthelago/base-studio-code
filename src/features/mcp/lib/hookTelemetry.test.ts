import { describe, it, expect } from "vitest";
import { parseHookLog, aggregateHookTelemetry } from "./hookTelemetry";

const NOW = new Date("2026-06-15T12:00:00");
const day = (offset: number, h = 10) => new Date(2026, 5, 15 - offset, h).getTime(); // `offset` days ago

function log(rows: Array<[number, string, string, string]>): string {
  return rows.map((r) => r.join("\t")).join("\n");
}

describe("parseHookLog", () => {
  it("parses TSV fire lines and skips malformed ones", () => {
    const text = [
      `${day(0)}\tPreToolUse\tBlock PII\tblock`,
      "garbage line",
      `${day(1)}\tPostToolUse\tAuto-format\tok`,
      `notanumber\tPreToolUse\tX\tallow`, // bad ts → skipped
    ].join("\n");
    const fires = parseHookLog(text);
    expect(fires).toHaveLength(2);
    expect(fires[0]).toMatchObject({ event: "PreToolUse", hook: "Block PII", outcome: "block" });
    expect(fires[1]).toMatchObject({ event: "PostToolUse", hook: "Auto-format", outcome: "ok" });
  });

  it("normalizes unknown outcomes to ok", () => {
    expect(parseHookLog(`${day(0)}\tStop\tH\tweird`)[0].outcome).toBe("ok");
  });

  it("parses the #1743 pane-prefixed shape and reads past the pane column", () => {
    // New writer line: ts \t pane \t event \t hook \t outcome (5 fields).
    const [f] = parseHookLog(`${day(0)}\tk:web\tPreToolUse\tBlock PII\tblock`);
    expect(f).toMatchObject({ event: "PreToolUse", hook: "Block PII", outcome: "block" });
  });

  it("parses a mix of legacy (no pane) and new (pane) lines in one log", () => {
    const text = [
      `${day(0)}\tPostToolUse\tAuto-format\tok`,         // legacy, 4 fields
      `${day(1)}\tk:web\tPreToolUse\tBlock PII\tblock`,  // new, 5 fields
    ].join("\n");
    const fires = parseHookLog(text);
    expect(fires).toHaveLength(2);
    expect(fires[0]).toMatchObject({ event: "PostToolUse", hook: "Auto-format", outcome: "ok" });
    expect(fires[1]).toMatchObject({ event: "PreToolUse", hook: "Block PII", outcome: "block" });
  });
});

describe("aggregateHookTelemetry", () => {
  const fires = parseHookLog(log([
    [day(0), "PreToolUse", "Block PII", "block"],
    [day(0), "PreToolUse", "Block PII", "allow"],
    [day(1), "PreToolUse", "Guard", "allow"],
    [day(2), "PostToolUse", "Auto-format", "ok"],
    [day(20), "PreToolUse", "Block PII", "block"], // outside the 14-day window → dropped
  ]));
  const a = aggregateHookTelemetry(fires, NOW, 14);

  it("counts totals, blocks, allows, and the allow rate within the window", () => {
    expect(a.total).toBe(4);          // the 20-day-old fire is excluded
    expect(a.blocks).toBe(1);
    expect(a.allows).toBe(2);         // PostToolUse "ok" is not an allow
    expect(a.allowRate).toBe(67);     // 2 / (2+1) = 66.6 → 67
  });

  it("produces exactly `days` daily buckets, oldest→newest, with allow=allow+ok", () => {
    expect(a.daily).toHaveLength(14);
    const today = a.daily[13];
    expect(today).toMatchObject({ allows: 1, blocks: 1 }); // day0: 1 allow + 1 block
    expect(a.daily[11]).toMatchObject({ allows: 1, blocks: 0 }); // day2: PostToolUse ok counts as allow-side
  });

  it("ranks fires per hook and splits PreToolUse hooks into allows/blocks", () => {
    expect(a.perHook[0]).toMatchObject({ hook: "Block PII", fires: 2 });
    const blockPii = a.perPreHook.find((p) => p.hook === "Block PII")!;
    expect(blockPii).toMatchObject({ allows: 1, blocks: 1 });
    // Auto-format is PostToolUse → not in the PreToolUse split.
    expect(a.perPreHook.some((p) => p.hook === "Auto-format")).toBe(false);
  });

  it("allowRate is 100 when there are no PreToolUse decisions", () => {
    const onlyPost = aggregateHookTelemetry(parseHookLog(log([[day(0), "PostToolUse", "Fmt", "ok"]])), NOW, 14);
    expect(onlyPost.allowRate).toBe(100);
    expect(onlyPost.blocks).toBe(0);
  });
});
