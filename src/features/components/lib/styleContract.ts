// The design-system STYLE DESCRIPTOR (#2567) — the authoritative source of truth for the semantic
// token contract. `src-tauri/data/ui/tokens-contract.css` is GENERATED from
// `src-tauri/data/ui/style-descriptor.json` by {@link emitTokensContractCss} (guarded by
// `styleContract.gen.test.ts`), and later `bsc ui tokens` enumerates the same descriptor as the
// addressable surface for the designer LLM (#2568). One SoT feeds CSS emission AND discovery.
//
// Additive-first: a new token defaults to today's value, so growing the descriptor lands as a
// zero-visual-change commit. Types are deliberately coarse ("color" | "dimension") — enough for
// `bsc ui`'s closed value grammar to type-check a write, not a full CSS type system.

export type TokenType = "color" | "dimension";

/** A base-palette token — an app-level default the semantic layer + themes compose from. */
export interface BaseToken {
  /** The CSS custom-property name, e.g. `--accent`. */
  name: string;
  type: TokenType;
  /** The literal default value (a raw colour/dimension; base tokens never reference other tokens). */
  value: string;
  /** One-line description surfaced by `bsc ui tokens`. */
  governs: string;
}

/** A semantic component token — what a kit component consumes and a theme overrides. */
export interface ComponentToken {
  /** The short key used for rung-2 addressing: `bsc ui component <c> set-token <key> [--variant v]`
   *  resolves to `--<component>[-<variant>]-<key>`. */
  key: string;
  /** The full CSS custom-property name, e.g. `--btn-primary-bg`. */
  name: string;
  type: TokenType;
  /** The default value (usually a `var(--base)` reference so a theme/accent composes through). */
  default: string;
  governs: string;
}

export interface StyleVariant {
  variant: string;
  governs: string;
  tokens: ComponentToken[];
}

export interface StyleComponent {
  component: string;
  governs: string;
  tokens: ComponentToken[];
  variants: StyleVariant[];
}

export interface StyleDescriptor {
  version: number;
  note: string;
  base: BaseToken[];
  components: StyleComponent[];
}

/** A flat, uniform view of every token in the descriptor — the shape `bsc ui tokens` will serialise
 *  and the resolver rung-2 addressing will search. `component`/`variant` are undefined for base tokens. */
export interface FlatToken {
  name: string;
  type: TokenType;
  /** The default (base tokens: their literal `value`; component tokens: their `default`). */
  default: string;
  governs: string;
  /** "base" for the palette, else the component name. */
  family: string;
  component?: string;
  variant?: string;
  key?: string;
}

/** Flatten the descriptor into one row per token (base → component → per-variant), preserving order. */
export function flattenTokens(d: StyleDescriptor): FlatToken[] {
  const out: FlatToken[] = [];
  for (const b of d.base) out.push({ name: b.name, type: b.type, default: b.value, governs: b.governs, family: "base" });
  for (const c of d.components) {
    for (const t of c.tokens) out.push({ name: t.name, type: t.type, default: t.default, governs: t.governs, family: c.component, component: c.component, key: t.key });
    for (const v of c.variants)
      for (const t of v.tokens) out.push({ name: t.name, type: t.type, default: t.default, governs: t.governs, family: c.component, component: c.component, variant: v.variant, key: t.key });
  }
  return out;
}

/**
 * Emit `tokens-contract.css` from the descriptor — the semantic token contract every kit component
 * consumes and `bsc ui emit-css` ships into a generated app as `tokens.css`. Declaration order:
 * base palette, then the semantic component tokens (each component's tokens, then its variants'),
 * matching the flatten order so the file reads top-to-bottom like the descriptor. Trailing newline
 * so the generated file is stable across platforms (the drift test normalises CRLF → LF).
 */
export function emitTokensContractCss(d: StyleDescriptor): string {
  const L: string[] = [];
  L.push("/* GENERATED from src-tauri/data/ui/style-descriptor.json — DO NOT EDIT BY HAND.");
  L.push("   Regenerate: `UPDATE_KITS=1 npx vitest run styleContract.gen`.");
  L.push(`   ${d.note} */`);
  L.push(":root {");
  L.push("  /* base palette — the app-level defaults the semantic layer (and the themes) compose from */");
  for (const b of d.base) L.push(`  ${b.name}: ${b.value};`);
  L.push("");
  L.push("  /* semantic component tokens — what kit components consume; what a theme overrides */");
  for (const c of d.components) {
    for (const t of c.tokens) L.push(`  ${t.name}: ${t.default};`);
    for (const v of c.variants) for (const t of v.tokens) L.push(`  ${t.name}: ${t.default};`);
  }
  L.push("}");
  return L.join("\n") + "\n";
}
