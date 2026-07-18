import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compileVariantsCss } from "@/shared/ui/kit/variants";
import { flattenTokens, type StyleDescriptor } from "./styleContract";

// #3394 — the FIRST SLICE of #2553: Button is the "exhausted" component. Every VISUAL property of
// `.btn` resolves from a `--btn-*` token the design store owns, so the designer LLM can restyle it —
// a brand-new variant included — entirely through `bsc ui`, live, with zero React edits.
//
// The bug these tests exist to prevent is subtle and was the ORIGINAL state of this component: the
// runtime applier (`applyThemeToRoot`) faithfully writes ANY token a theme defines to `:root`, and
// `kitTokens()` is not allow-listed — so `--btn-height` could always be SET. It just did nothing,
// because `.btn` said `height:28px`. A token nothing consumes is indistinguishable from a token that
// works, right up until a designer tries to use it. Hence the load-bearing assertion here is
// CONSUMPTION (test 2), not declaration.

const TOKENS_CSS = join(process.cwd(), "src/styles/tokens.css");
const DESCRIPTOR = join(process.cwd(), "src-tauri/data/ui/style-descriptor.json");
const css = readFileSync(TOKENS_CSS, "utf8").replace(/\r\n/g, "\n");
const descriptor = JSON.parse(readFileSync(DESCRIPTOR, "utf8")) as StyleDescriptor;

/** Every `.btn…{ … }` rule body in tokens.css, keyed by its selector. */
function btnRules(): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  for (const m of css.matchAll(/^(\.btn[^{]*)\{([^}]*)\}/gm)) {
    out.push({ selector: m[1].trim(), body: m[2] });
  }
  return out;
}

/** Split a rule body into `prop: value` pairs, dropping comments and blanks. */
function decls(body: string): [string, string][] {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const i = d.indexOf(":");
      return [d.slice(0, i).trim(), d.slice(i + 1).trim()] as [string, string];
    });
}

// STRUCTURE and BEHAVIOUR, not design — #2553's reach table puts these outside the designer's line
// ("a component's internal structure/DOM" needs code once; "behavior" is never design). They stay
// hardcoded deliberately, so this allowlist is the spec for what "exhausted" excludes.
const STRUCTURAL = new Set(["display", "align-items", "cursor"]);

describe("Button is token-exhausted (#3394, first slice of #2553)", () => {
  it("has NO hardcoded visual literal — every non-structural declaration reads a --btn-* token", () => {
    const rules = btnRules();
    expect(rules.length, "expected the .btn rules to be found in tokens.css").toBeGreaterThan(5);

    const offenders: string[] = [];
    for (const { selector, body } of rules) {
      for (const [prop, value] of decls(body)) {
        if (STRUCTURAL.has(prop)) continue;
        // `padding:0 var(--btn-pad-x)` keeps a literal 0 for the VERTICAL axis on purpose: the button
        // is a fixed-height inline-flex box that centres its content, so vertical padding is inert —
        // tokenizing it would offer the designer a knob that cannot change what is rendered.
        if (!value.includes("var(--btn-")) offenders.push(`${selector} { ${prop}: ${value} }`);
      }
    }
    expect(offenders, `these .btn declarations still hardcode a visual value:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("CONSUMES every --btn-* token the descriptor declares (a token nothing reads is a dead knob)", () => {
    // The exact failure mode this slice fixes: a token can be declared, themed and applied to :root
    // and still do nothing, because no rule references it. Declaration is not reach — consumption is.
    const declared = flattenTokens(descriptor)
      .map((t) => t.name)
      .filter((n) => n.startsWith("--btn-"));
    expect(declared.length).toBeGreaterThan(15);

    const unread = declared.filter((name) => !css.includes(`var(${name})`));
    expect(unread, `declared but never consumed by tokens.css: ${unread.join(", ")}`).toEqual([]);
  });

  it("defaults reproduce the pre-tokenization values exactly (a zero-visual-change landing)", () => {
    // Pinning these is the whole basis for claiming the commit is visually inert. If someone changes a
    // default they must change it here too — which is the point: it becomes a deliberate design edit.
    const expected: Record<string, string> = {
      "--btn-height": "28px",
      "--btn-pad-x": "12px",
      "--btn-gap": "6px",
      "--btn-font-size": "11px",
      "--btn-font-weight": "400",
      "--btn-border-width": "1px",
      "--btn-disabled-opacity": "0.4",
      "--btn-primary-font-weight": "600",
      "--btn-primary-hover-brightness": "1.05",
      "--btn-sm-height": "24px",
      "--btn-sm-pad-x": "9px",
      "--btn-sm-font-size": "10.5px",
    };
    const byName = new Map(flattenTokens(descriptor).map((t) => [t.name, t.default]));
    for (const [name, value] of Object.entries(expected)) {
      expect(byName.get(name), `${name} default drifted`).toBe(value);
    }
  });

  it("lets a data-defined variant change SIZE and TYPE — the reach that did not exist before", () => {
    // Before this slice a variant could only restyle colour/radius: `.btn` hardcoded height, padding
    // and font-size, so a variant setting them was silently inert. This is the proof of the new reach,
    // and it runs through the REAL compiler the app uses (`compileVariantsCss`), not a mock.
    const out = compileVariantsCss([
      {
        id: "btn:brand",
        component: "btn",
        variant: "brand",
        tokens: { height: "40px", "pad-x": "20px", "font-size": "14px", "font-weight": "700", bg: "var(--accent)" },
      },
    ]);

    expect(out).toContain(".btn.brand {");
    expect(out).toContain("--btn-height: 40px;");
    expect(out).toContain("--btn-pad-x: 20px;");
    expect(out).toContain("--btn-font-size: 14px;");
    expect(out).toContain("--btn-font-weight: 700;");

    // …and the emitted custom properties are exactly the ones `.btn` reads, so the rule actually bites.
    for (const name of ["--btn-height", "--btn-pad-x", "--btn-font-size", "--btn-font-weight"]) {
      expect(css, `${name} must be consumed by .btn for the variant to have any effect`).toContain(`var(${name})`);
    }
  });

  it("still refuses an injecting value in a variant (the guard is not weakened by new token types)", () => {
    // `number`/`font` widen what `bsc ui tokens` LABELS, never what the compiler ACCEPTS.
    const out = compileVariantsCss([
      { id: "btn:evil", component: "btn", variant: "evil", tokens: { height: "40px}html{display:none" } },
    ]);
    expect(out).toBe("");
  });
});
