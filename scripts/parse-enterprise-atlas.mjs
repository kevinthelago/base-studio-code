#!/usr/bin/env node
// Parse docs/enterprise-atlas.md into structured rows — domain · product · capability · features.
//
// The atlas is a DATASET written as prose: 11 `##` domains, 72 `###` products, and ~1,000 bullets in
// one regular form (`- **Capability:** feature, feature, feature`). At 191 KB / ~48k tokens nothing
// can read it selectively, which is the whole reason it is being migrated — a session that wants CRM
// should not pay for eCommerce and Finance.
//
// ## The parser REFUSES to lose a line
//
// Every non-blank line is either consumed into a row or explicitly classified (heading, separator,
// prose, nested). Anything that matches nothing is returned in `unparsed`, and the test fails on a
// non-empty `unparsed`. A migration that silently drops 3% of a corpus is worse than one that does
// not run: the loss is invisible precisely because the source is about to stop being the source.
//
// ## Features are split PAREN-AWARE, and the raw text is kept anyway
//
// The bullets are comma-separated, but commas appear inside parentheses — "Einstein Lead Scoring
// (AI 1–99), web-to-lead". A naive split corrupts those. This tracks depth, and still stores `detail`
// verbatim so the split is a convenience over the source rather than a replacement for it.

import { readFileSync } from "node:fs";

/** Split a feature list on top-level commas only — depth-aware, so parenthesised commas survive. */
export function splitFeatures(detail) {
  const out = [];
  let buf = "";
  let depth = 0;
  for (const ch of detail) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      if (buf.trim()) out.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

const BULLET = /^(\s*)-\s+\*\*(.+?):?\*\*:?\s*(.*)$/;
// The synthesis section closes with a NUMBERED list — `1. **A visual, no-code builder** as the …` —
// and two standalone bold lead-ins. Different shape, and the most analytically valuable content in
// the file ("the universal enterprise-software pattern present in EVERY category"). Parsed rather
// than discarded: dropping the conclusion because it is not a bullet would be the exact silent loss
// this parser exists to refuse.
const NUMBERED = /^(\s*)\d+\.\s+\*\*(.+?):?\*\*:?\s*(.*)$/;
// A standalone `**Heading:**` line labels the list that follows; it is a SECTION, not a row.
const LEADIN = /^\*\*(.+?):?\*\*:?\s*$/;
// ...and the same shape WITH trailing prose is a standalone claim — the document's closing sentence
// is one ("**The generational shift every incumbent is racing toward:** from human-operated software
// → to agentic"). Label plus detail is a row by any other name.
const STATEMENT = /^\*\*(.+?):?\*\*:?\s+(\S.*)$/;

export function parseAtlas(md) {
  const rows = [];
  const unparsed = [];
  const domains = [];
  const products = [];
  let domain = null;
  let product = null;
  let title = null;
  let section = null;

  for (const [i, raw] of md.split("\n").entries()) {
    const line = raw.replace(/\s+$/, "");
    const n = i + 1;
    if (!line.trim()) continue;
    if (line.startsWith("# ")) { title = line.slice(2).trim(); continue; }
    if (line.startsWith("## ")) {
      domain = line.slice(3).trim();
      product = null;
      section = null;
      domains.push(domain);
      continue;
    }
    if (line.startsWith("### ")) {
      product = line.slice(4).trim();
      products.push({ domain, product });
      continue;
    }
    if (/^-{3,}$/.test(line.trim())) continue;      // section rule
    if (line.trim().startsWith(">")) continue;       // the source blockquote

    const lead = line.match(LEADIN);
    if (lead) { section = lead[1].trim(); continue; }

    const stmt = line.match(STATEMENT);
    const m = line.match(BULLET) ?? line.match(NUMBERED) ?? (stmt && [stmt[0], "", stmt[1], stmt[2]]);
    if (m) {
      const [, indent, capability, detail] = m;
      rows.push({
        kind: line.match(BULLET) ? "capability" : line.match(NUMBERED) ? "pattern" : "statement",
        section,
        domain,
        // A nested bullet in the synthesis section has no product; keep it addressable rather than
        // dropping it, and mark the nesting so a reader knows it qualifies the bullet above.
        product: product ?? null,
        capability: capability.trim(),
        detail: detail.trim(),
        features: splitFeatures(detail),
        nested: indent.length > 0,
      });
      continue;
    }
    // Prose — real content, but not a row. Kept so the count reconciles and nothing is invisible.
    unparsed.push({ line: n, text: line.trim() });
  }
  return { title, domains, products, rows, unparsed };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2] ?? "docs/enterprise-atlas.md";
  const out = parseAtlas(readFileSync(path, "utf8"));
  if (process.argv.includes("--summary")) {
    console.log(
      `title      ${out.title}\n` +
      `domains    ${out.domains.length}\n` +
      `products   ${out.products.length}\n` +
      `rows       ${out.rows.length}  (nested ${out.rows.filter((r) => r.nested).length})\n` +
      `features   ${out.rows.reduce((n, r) => n + r.features.length, 0)}\n` +
      `unparsed   ${out.unparsed.length}`,
    );
  } else {
    console.log(JSON.stringify(out, null, 2));
  }
}
