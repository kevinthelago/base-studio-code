// EVERY FIELD `AgentStream` DECLARES MUST SURVIVE THE PARSER.
//
// THREE TIMES the same shape: a field declared on the type, written by `bsc plan fleet`, sitting in
// plan.db, and silently dropped by `parseFleetFile`.
//
//   model     (#173) — validated against MODEL_IDS and anything else discarded, throwing away every
//                      LOCAL model a director assigned. Its fix comment is still in the parser.
//   requires         — typed `string[]` on the feature side and coerced with `strArray`, dropping every
//                      attributed entry so the board showed an empty list.
//   feature          — `a-feature-owns-many-streams` added it to the interface, to Rust and to the CLI,
//                      and never revisited the decoder. All 89 studio-code streams arrived
//                      `feature: undefined`, which IS the plan as it looked before any feature was
//                      assigned. The maintainer reported "I'm still seeing the old plan" four times
//                      across two days, and every other gate was green throughout.
//
// A dropped field is invisible to typecheck (the property is optional), to lint, and to every unit test
// that builds its fixture in memory instead of round-tripping through the decoder. The only thing that
// sees it is a check reading the TYPE and the PARSER together.
//
// DERIVED, NOT HAND-LISTED — hand-checking is exactly what failed all three times.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseFleetFile } from "@/features/planner/fleet/planFleet";

/** The parser's source, from the seed — it is a record, not a file (docs/records.md). */
function planFleetSource(): string {
  const seed = JSON.parse(readFileSync("src-tauri/data/knowledge/algorithms.json", "utf8")) as {
    implementations: { id: string; code?: string }[];
  };
  const rec = seed.implementations.find((i) => i.id === "plan-fleet.ts");
  if (!rec?.code) throw new Error("plan-fleet.ts is not in the seed — this guard is looking at nothing");
  return rec.code;
}

/** The field names declared on an interface body. One level of indentation, so a nested literal's
 *  keys (which are deeper) are not mistaken for fields. */
function declaredFields(src: string, iface: string): string[] {
  const start = src.indexOf(`export interface ${iface} {`);
  if (start < 0) throw new Error(`${iface} not found`);
  const body = src.slice(start, src.indexOf("\n}", start));
  return [...body.matchAll(/\n {2}(\w+)\??:/g)].map((m) => m[1]);
}

describe("parseFleetFile carries every field AgentStream declares", () => {
  const src = planFleetSource();
  const fields = declaredFields(src, "AgentStream");
  /** The parser's stream construction — the object literal pushed into `streams`. */
  const at = src.indexOf("streams.push({");
  const construction = src.slice(at, src.indexOf("\n    });", at));

  it("found a real interface and a real construction", () => {
    // A scan that matched nothing would pass every assertion below for the wrong reason.
    expect(at, "streams.push({ not found — the guard is reading the wrong shape").toBeGreaterThan(-1);
    expect(fields.length).toBeGreaterThan(10);
    expect(fields).toContain("id");
    expect(construction.length).toBeGreaterThan(200);
  });

  it.each(fields)("`%s` appears in the stream the parser builds", (field) => {
    expect(
      new RegExp(`(^|[\\s{,])${field}\\s*[:,]`, "m").test(construction),
      `AgentStream declares \`${field}\` and parseFleetFile never sets it. A field the store holds and ` +
        `the decoder drops is invisible to typecheck, to lint and to every in-memory fixture — it ` +
        `surfaces as "the data I saved isn't there", days later.`,
    ).toBe(true);
  });

  it("round-trips `feature` through the decoder — the regression", () => {
    // The behaviour, not just the source: a blob with `feature` set must come back with it intact.
    const plan = parseFleetFile(
      JSON.stringify({
        streams: [
          { id: "glance", repo: "o/r", feature: "glance-cockpit" },
          { id: "bare", repo: "o/r" },
          { id: "blank", repo: "o/r", feature: "   " },
        ],
      }),
    );
    expect(plan?.streams.find((s) => s.id === "glance")?.feature).toBe("glance-cockpit");
    // Absent stays absent, and whitespace-only is NOT a feature — it would look decided and resolve to
    // nothing, which is the shape the CLI already refuses on the way in.
    expect(plan?.streams.find((s) => s.id === "bare")?.feature).toBeUndefined();
    expect(plan?.streams.find((s) => s.id === "blank")?.feature).toBeUndefined();
  });
});
