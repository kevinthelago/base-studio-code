// The claim census's classifier (a-derivative-record-must-not-claim-the-module-it-derives-from).
//
// Tested here rather than through the script because the script needs a live STORE, which a vitest run
// does not have — and the part worth guarding is the JUDGEMENT, not the store read. The three kinds it
// separates each want a different action, and getting them confused is what makes a census unactionable:
// repairing a preview derivative's imports puts SAMPLE data on live screens.
import { describe, it, expect } from "vitest";
import { classify, importedSpecifiers, summarize } from "./claimCensus.mjs";

describe("classify", () => {
  it("calls a record that vendors SAMPLE data a preview derivative", () => {
    const v = classify({
      recordSrc: 'const SAMPLE_ISSUE = { id: 1 };\nexport const IssueRow = () => SAMPLE_ISSUE;',
      fileSrc: 'import { useIssue } from "@/features/x";\nexport const IssueRow = () => useIssue();',
      fileExports: new Set(["IssueRow"]),
      recordExports: new Set(["IssueRow"]),
    });
    expect(v.kind).toBe("preview-derivative");
    expect(v.keepsProvides).toBe(false);
  });

  it("calls a record that stopped importing something and stands it in locally a derivative", () => {
    // `kitrenderer` swapping the real `primitiveFor` for `componentFor` — same exports, so the export
    // check sees nothing, and the record would read as the newer truth.
    const v = classify({
      recordSrc: 'const componentFor = () => null;\nexport const KitRenderer = () => componentFor();',
      fileSrc: 'import { primitiveFor } from "@/features/designs/lib/palette";\nexport const KitRenderer = () => primitiveFor();',
      fileExports: new Set(["KitRenderer"]),
      recordExports: new Set(["KitRenderer"]),
    });
    expect(v.kind).toBe("preview-derivative");
  });

  it("does NOT call a subset export a loss when several records share the file", () => {
    // THE CORRECTION. The banners lifted out of AppBanners.tsx each export only their own, which is the
    // lift working — counting it as a dropped export is what made the 33 an overcount.
    const v = classify({
      recordSrc: "export const CrashBanner = () => null;",
      fileSrc: "export const CrashBanner = () => null;\nexport const QuarantineBanner = () => null;",
      fileExports: new Set(["CrashBanner", "QuarantineBanner"]),
      recordExports: new Set(["CrashBanner"]),
      sharesSrc: 2,
    });
    expect(v.kind).toBe("per-component-lift");
    expect(v.keepsProvides).toBe(false);
  });

  it("DOES call it a dropped export when the record is the file's only claimant", () => {
    const v = classify({
      recordSrc: "export const A = 1;",
      fileSrc: "export const A = 1;\nexport const B = 2;",
      fileExports: new Set(["A", "B"]),
      recordExports: new Set(["A"]),
      sharesSrc: 1,
    });
    expect(v.kind).toBe("drops-exports");
    expect(v.why).toContain("B");
  });

  it("keeps provides ONLY for a record that is genuinely the newer version", () => {
    const v = classify({
      recordSrc: "export const A = 2; // improved",
      fileSrc: "export const A = 1;",
      fileExports: new Set(["A"]),
      recordExports: new Set(["A"]),
    });
    expect(v.kind).toBe("newer-truth");
    expect(v.keepsProvides).toBe(true);
  });

  it("reports unknown rather than guessing when a star export hides the list", () => {
    // `exportedNames` returns null through `export *`. A confident "safe" derived from a function that
    // said "I cannot tell" is the worst of the three answers.
    const v = classify({ recordSrc: "export * from './x';", fileSrc: "export * from './x';", fileExports: null, recordExports: null });
    expect(v.kind).toBe("unknown");
    expect(v.keepsProvides).toBe(false);
  });
});

describe("importedSpecifiers", () => {
  it("finds import and re-export specifiers alike", () => {
    const s = importedSpecifiers('import a from "x";\nexport { b } from "y";');
    expect([...s].sort()).toEqual(["x", "y"]);
  });
});

describe("summarize", () => {
  it("counts by kind and totals what must lose its claim", () => {
    const out = summarize([
      { kind: "preview-derivative", keepsProvides: false },
      { kind: "newer-truth", keepsProvides: true },
      { kind: "per-component-lift", keepsProvides: false },
    ]);
    expect(out.total).toBe(3);
    expect(out.counts["preview-derivative"]).toBe(1);
    expect(out.shouldDropProvides).toBe(2);
  });
});
