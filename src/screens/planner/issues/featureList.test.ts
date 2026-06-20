import { describe, it, expect } from "vitest";
import { parseFeaturesFile, featureDefined, featuresSummary, featuresGateComplete, featuresAwaitingConfirm } from "./featureList";

describe("parseFeaturesFile", () => {
  it("returns [] for empty / bad JSON / non-array", () => {
    expect(parseFeaturesFile("")).toEqual([]);
    expect(parseFeaturesFile("   ")).toEqual([]);
    expect(parseFeaturesFile("{not json")).toEqual([]);
    expect(parseFeaturesFile('{"slug":"x","name":"X"}')).toEqual([]); // object, not array
  });

  it("parses a clean feature array", () => {
    const f = parseFeaturesFile(JSON.stringify([
      { slug: "invite", name: "Invite teammates", behavior: "send an invite", acceptance: ["email sent"], tools: ["resend"] },
    ]));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ slug: "invite", name: "Invite teammates", behavior: "send an invite" });
    expect(f[0].acceptance).toEqual(["email sent"]);
    expect(f[0].tools).toEqual(["resend"]);
    expect(f[0].stream).toBe("invite"); // defaults to slug
  });

  it("derives a slug from the name when missing, and an explicit stream wins", () => {
    const f = parseFeaturesFile(JSON.stringify([{ name: "Export to CSV", stream: "exporter" }]));
    expect(f[0].slug).toBe("export-to-csv");
    expect(f[0].stream).toBe("exporter");
  });

  it("drops entries with no name and de-dupes slugs", () => {
    const f = parseFeaturesFile(JSON.stringify([
      { slug: "a", name: "A" },
      { slug: "a", name: "A duplicate" },
      { behavior: "no name" },
    ]));
    expect(f.map((x) => x.slug)).toEqual(["a"]);
  });

  it("ignores malformed field types", () => {
    const f = parseFeaturesFile(JSON.stringify([{ slug: "a", name: "A", acceptance: "not-an-array", tools: [1, "ok", ""] }]));
    expect(f[0].acceptance).toBeUndefined();
    expect(f[0].tools).toEqual(["ok"]);
  });
});

describe("featureDefined / featuresSummary", () => {
  const full = { slug: "a", name: "A", behavior: "does a thing", acceptance: ["x"] };
  it("a feature is defined only with name + behavior + ≥1 acceptance", () => {
    expect(featureDefined(full)).toBe(true);
    expect(featureDefined({ slug: "a", name: "A" })).toBe(false);
    expect(featureDefined({ slug: "a", name: "A", behavior: "b" })).toBe(false);
    expect(featureDefined({ slug: "a", name: "A", behavior: "b", acceptance: [] })).toBe(false);
  });

  it("summary reports count + all-defined", () => {
    expect(featuresSummary([])).toEqual({ count: 0, allConfirmed: false });
    expect(featuresSummary([full])).toEqual({ count: 1, allConfirmed: true });
    expect(featuresSummary([full, { slug: "b", name: "B" }])).toEqual({ count: 2, allConfirmed: false });
  });
});

describe("featuresGateComplete / featuresAwaitingConfirm (#plan-db — the auto-complete fix)", () => {
  it("a single fully-populated feature does NOT complete the stage until the user confirms", () => {
    const populated = { allConfirmed: true }; // even one defined feature reports all-defined
    expect(featuresGateComplete(populated, false)).toBe(false); // the old auto-complete is gone
    expect(featuresGateComplete(populated, true)).toBe(true);   // completes once the user confirms
  });

  it("offers the confirm only once everything is populated, not mid-population", () => {
    expect(featuresAwaitingConfirm({ allConfirmed: false }, false)).toBe(false); // still populating → no offer
    expect(featuresAwaitingConfirm({ allConfirmed: true }, false)).toBe(true);   // all populated → offer confirm
    expect(featuresAwaitingConfirm({ allConfirmed: true }, true)).toBe(false);   // already confirmed → nothing pending
  });
});
