import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAtlas, splitFeatures } from "./parse-enterprise-atlas.mjs";

const md = readFileSync(join(process.cwd(), "docs/enterprise-atlas.md"), "utf8");
const out = parseAtlas(md);

describe("the enterprise atlas parses without losing a line", () => {
  /**
   * THE ONE ASSERTION THAT MATTERS. Every non-blank line is either consumed into a row or
   * deliberately classified (heading, rule, blockquote, section lead-in). `unparsed` is what matched
   * nothing.
   *
   * A migration that silently drops part of a corpus is worse than one that does not run, because the
   * loss is invisible exactly when the source stops being the source. The first pass dropped NINE
   * lines — and they turned out to be the synthesis conclusion, the most analytically valuable content
   * in the file ("the universal enterprise-software pattern present in EVERY category"). They were
   * dropped only because they are a NUMBERED list rather than a bulleted one.
   */
  it("leaves nothing unparsed", () => {
    expect(
      out.unparsed,
      `lines the parser could not place — each is content the migration would lose:\n  ${out.unparsed
        .map((u) => `L${u.line}: ${u.text.slice(0, 100)}`)
        .join("\n  ")}`,
    ).toEqual([]);
  });

  it("finds the corpus it is supposed to find", () => {
    // Non-vacuity: a parser that returned nothing would also have an empty `unparsed`.
    expect(out.domains.length).toBe(11);
    expect(out.products.length).toBe(72);
    expect(out.rows.length).toBeGreaterThan(1000);
    expect(out.rows.every((r) => r.domain), "every row is attributed to a domain").toBe(true);
  });

  it("keeps the three kinds distinct", () => {
    // `capability` is the product inventory; `pattern` and `statement` are the cross-category
    // synthesis. Collapsing them would let analysis read as a vendor's feature.
    const kinds = new Set(out.rows.map((r) => r.kind));
    expect(kinds).toEqual(new Set(["capability", "pattern", "statement"]));
    expect(out.rows.filter((r) => r.kind === "capability").every((r) => r.product)).toBe(true);
  });

  it("stores the raw detail beside the split, so the split is never the only copy", () => {
    for (const r of out.rows.slice(0, 200)) {
      expect(typeof r.detail).toBe("string");
      if (r.features.length) expect(r.detail).toContain(r.features[0].slice(0, 12));
    }
  });
});

describe("splitFeatures is paren-aware", () => {
  /**
   * The bullets are comma-separated, but commas appear INSIDE parentheses — "Einstein Lead Scoring
   * (AI 1–99), web-to-lead". A naive `split(",")` turns one feature into two and corrupts the corpus
   * quietly, which is the failure this function exists to avoid.
   */
  it("does not split inside parentheses", () => {
    expect(splitFeatures("Einstein Lead Scoring (AI 1–99), web-to-lead, assignment rules")).toEqual([
      "Einstein Lead Scoring (AI 1–99)",
      "web-to-lead",
      "assignment rules",
    ]);
  });

  it("handles nesting and unbalanced input without throwing", () => {
    expect(splitFeatures("a (b, c (d, e)), f")).toEqual(["a (b, c (d, e))", "f"]);
    expect(splitFeatures("a (b, c")).toEqual(["a (b, c"]);   // unbalanced: keep it whole, never guess
    expect(splitFeatures("")).toEqual([]);
  });

  it("is applied to the real corpus without producing empty features", () => {
    const empty = out.rows.flatMap((r) => r.features).filter((f) => !f.trim());
    expect(empty).toEqual([]);
  });
});
