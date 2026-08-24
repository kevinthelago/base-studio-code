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

import { readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

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

/** `a Product Name (v2)` -> `a-product-name-v2`. Stable, filename-safe, and the store's join key. */
export function slug(s) {
  return s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/**
 * Emit the packaged corpus: one JSON per PRODUCT under `<dir>/<domain>/<product>.json`, plus one
 * `synthesis.json`.
 *
 * Per PRODUCT rather than per domain because a product's inventory is the unit that CHANGES — a
 * vendor ships something and one file moves. A per-domain file would make every vendor update a
 * diff against ten unrelated competitors.
 */
export function emitCorpus(parsed, dir) {
  rmSync(dir, { recursive: true, force: true });
  const byProduct = new Map();
  for (const r of parsed.rows) {
    if (r.kind !== "capability") continue;
    const key = `${slug(r.domain)}/${slug(r.product)}`;
    if (!byProduct.has(key)) {
      byProduct.set(key, {
        id: slug(r.product),
        name: r.product,
        domain: slug(r.domain),
        domainName: r.domain,
        capabilities: [],
      });
    }
    byProduct.get(key).capabilities.push({
      slug: slug(r.capability),
      label: r.capability,
      detail: r.detail,
      features: r.features,
      ...(r.nested ? { nested: true } : {}),
    });
  }
  let n = 0;
  for (const [key, product] of byProduct) {
    const [domainDir] = key.split("/");
    mkdirSync(join(dir, domainDir), { recursive: true });
    writeFileSync(join(dir, `${key}.json`), JSON.stringify(product, null, 2) + "\n");
    n++;
  }
  const synthesis = parsed.rows
    .filter((r) => r.kind !== "capability")
    .map((r) => ({ kind: r.kind, section: r.section, domain: slug(r.domain), label: r.capability, detail: r.detail }));
  writeFileSync(join(dir, "synthesis.json"), JSON.stringify({ title: parsed.title, rows: synthesis }, null, 2) + "\n");
  return { products: n, synthesis: synthesis.length };
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
  } else if (process.argv.includes("--emit")) {
    const dir = process.argv[process.argv.indexOf("--emit") + 1];
    if (!dir) { console.error("--emit needs a directory"); process.exit(2); }
    const { products, synthesis } = emitCorpus(out, dir);
    console.log(`emitted ${products} product file(s) + ${synthesis} synthesis row(s) to ${dir}`);
  } else {
    console.log(JSON.stringify(out, null, 2));
  }
}
