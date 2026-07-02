// manifest.ts — the introspectable registry of the shared UI kit (#2060).
//
// A serialisable catalogue of every composable primitive and its prop schema, so an agent (or the
// in-app visual editor, v1.0.5) can ENUMERATE and COMPOSE the kit instead of hand-writing JSX. This
// module is pure data — no React, no component references — so it can be shipped to JSON verbatim
// (`manifestJson()`). The runtime render-map that turns a `PrimitiveName` back into a component lives
// alongside it in `registry.tsx`; a `PrimitiveName` union keeps the two in sync at compile time (the
// registry is a `Record<PrimitiveName, …>`, so a missing/extra component is a type error).
//
// Adding a primitive: add its name to `PrimitiveName`, a spec here, and a row in `registry.tsx`.
// The `manifest.test.ts` sync test then guards that the three stay aligned.

/** Every primitive the kit exposes to the builder. Also the key type of the render-map registry. */
export type PrimitiveName =
  // layout
  | "Box" | "Stack" | "Row" | "Spacer" | "Grid"
  // typography
  | "Text"
  // controls
  | "Button" | "IconButton" | "Checkbox" | "Toggle" | "SegmentedControl" | "TextField" | "SelectField"
  // data
  | "Card" | "Chip" | "StatTile" | "FillBar"
  // feedback
  | "Banner" | "EmptyState" | "StatusDot";

export type PrimitiveGroup = "layout" | "typography" | "controls" | "data" | "feedback";

/** The kind of a prop's value — drives how a builder renders an editor control for it. */
export type PropType =
  | "string"
  | "number"
  | "boolean"
  | "enum"      // a fixed set of string values (see `values`)
  | "node"      // ReactNode / slot
  | "function"  // event handler / callback
  | "style"     // a CSSProperties object
  | "array"     // a list of structured items (see `note`)
  | "space"     // a spacing rung (SPACE_RUNGS) or a raw px number
  | "fontSize"  // a type rung (FONT_RUNGS) or a raw px number
  | "tracks"    // grid tracks: a number → repeat(n, 1fr), or a template string
  | "color";    // a CSS color / design token string

/** The spacing rungs (`--sp-*`) a `space`-typed prop accepts by name; raw px is also legal. */
export const SPACE_RUNGS = ["xs", "sm", "md", "lg", "xl"] as const;
/** The type-scale rungs (`--fs-*`) a `fontSize`-typed prop accepts by name; raw px is also legal. */
export const FONT_RUNGS = ["xxs", "xs", "sm", "md", "lg", "xl"] as const;

export interface PropSpec {
  name: string;
  type: PropType;
  /** True for props the component cannot render without. */
  required?: boolean;
  /** Allowed values for `type: "enum"` (and the semantic set for tone-like props). */
  values?: readonly string[];
  /** The default the component applies when the prop is omitted. */
  default?: string | number | boolean;
  description: string;
}

export interface PrimitiveSpec {
  name: PrimitiveName;
  group: PrimitiveGroup;
  /** The `@/…` import specifier the component is exported from. */
  importPath: string;
  description: string;
  props: PropSpec[];
  /** True when arbitrary extra DOM props (className, style, data-attrs, handlers) pass through to the root. */
  passthrough?: boolean;
}

// Shared prop fragments reused across the layout primitives.
const GAP: PropSpec = { name: "gap", type: "space", description: "Gap between children — a rung (xs…xl) or raw px." };
const ALIGN = (dflt: string): PropSpec => ({ name: "align", type: "enum", values: ["start", "center", "end", "baseline", "stretch"], default: dflt, description: "Cross-axis alignment." });
const JUSTIFY: PropSpec = { name: "justify", type: "enum", values: ["start", "center", "end", "between", "around", "evenly"], description: "Main-axis distribution." };
const WRAP: PropSpec = { name: "wrap", type: "boolean", description: "Allow children to wrap onto multiple lines." };
const PAD: PropSpec = { name: "pad", type: "space", description: "Inner padding — a rung/px, or a [block, inline] pair." };
const INLINE = (kind: string): PropSpec => ({ name: "inline", type: "boolean", description: `Render as inline-${kind} instead of ${kind}.` });
const CHILDREN: PropSpec = { name: "children", type: "node", required: true, description: "Content." };

export const UI_KIT: PrimitiveSpec[] = [
  // ---- layout ---------------------------------------------------------------
  {
    name: "Box", group: "layout", importPath: "@/shared/ui/layout/Box", passthrough: true,
    description: "The generic styled container — the catch-all so features never write a raw div.",
    props: [
      CHILDREN,
      { name: "as", type: "string", default: "div", description: "The rendered element (div/section/aside/span/…)." },
      { name: "pad", type: "space", description: "Inner padding — a rung/px, or a [block, inline] pair." },
      { name: "bg", type: "color", description: "Background color/token." },
      { name: "border", type: "enum", values: ["true", "soft", "<color>"], description: "true → --stroke, soft → --stroke-soft, or a color → 1px solid <color>." },
      { name: "radius", type: "enum", values: ["sm", "md", "lg"], description: "Corner radius rung (--r-*) or raw px." },
      { name: "shadow", type: "enum", values: ["sm", "md", "lg", "xl"], description: "Elevation (--shadow-*)." },
    ],
  },
  {
    name: "Stack", group: "layout", importPath: "@/shared/ui/layout/Stack", passthrough: true,
    description: "Vertical flex column with a gap.",
    props: [CHILDREN, GAP, ALIGN("stretch"), JUSTIFY, WRAP, PAD, INLINE("flex")],
  },
  {
    name: "Row", group: "layout", importPath: "@/shared/ui/layout/Row", passthrough: true,
    description: "Horizontal flex row with a gap. Pair with Spacer to push trailing items.",
    props: [CHILDREN, GAP, ALIGN("center"), JUSTIFY, WRAP, PAD, INLINE("flex")],
  },
  {
    name: "Spacer", group: "layout", importPath: "@/shared/ui/layout/Spacer",
    description: "Empty space inside a Row/Stack — flexible (flex:1) by default, or a fixed size.",
    props: [{ name: "size", type: "space", description: "A rigid spacer of this size; omit for a greedy flex:1 filler." }],
  },
  {
    name: "Grid", group: "layout", importPath: "@/shared/ui/layout/Grid", passthrough: true,
    description: "CSS grid container with template tracks and a gap.",
    props: [
      CHILDREN,
      { name: "cols", type: "tracks", description: "Columns — a number → repeat(n, 1fr), or a gridTemplateColumns string." },
      { name: "rows", type: "tracks", description: "Rows — a number → repeat(n, 1fr), or a gridTemplateRows string." },
      GAP,
      { name: "align", type: "enum", values: ["start", "center", "end", "baseline", "stretch"], description: "Cell cross-axis alignment (alignItems)." },
      { name: "justify", type: "enum", values: ["start", "center", "end", "between", "around", "evenly"], description: "Inline-axis track distribution (justifyContent)." },
      INLINE("grid"),
    ],
  },
  // ---- typography -----------------------------------------------------------
  {
    name: "Text", group: "typography", importPath: "@/shared/ui/typography/Text", passthrough: true,
    description: "The one typographic primitive — size, semantic tone, mono, weight, element.",
    props: [
      CHILDREN,
      { name: "size", type: "fontSize", description: "Font size — a rung (xxs…xl) or raw px. Omit to inherit." },
      { name: "tone", type: "enum", values: ["dim", "muted", "accent", "danger", "success"], description: "Semantic color tone. Omit to inherit." },
      { name: "mono", type: "boolean", description: "Apply the mono (JetBrains Mono) utility class." },
      { name: "weight", type: "number", description: "Font weight — a number (500/600) or CSS keyword." },
      { name: "as", type: "string", default: "span", description: "The rendered element (span/div/p/label/h1–h4…)." },
    ],
  },
  // ---- controls -------------------------------------------------------------
  {
    name: "Button", group: "controls", importPath: "@/shared/ui/controls/Button", passthrough: true,
    description: "The standard button. Passes through onClick/disabled/type and DOM props.",
    props: [
      CHILDREN,
      { name: "variant", type: "enum", values: ["default", "primary", "ghost"], default: "default", description: "Visual weight." },
      { name: "size", type: "enum", values: ["md", "sm"], default: "md", description: "Control height." },
      { name: "danger", type: "boolean", description: "Destructive (red) styling." },
    ],
  },
  {
    name: "IconButton", group: "controls", importPath: "@/shared/ui/controls/IconButton",
    description: "A square icon/glyph button with a hit-area (defaults to the ✕ close glyph).",
    props: [
      { name: "children", type: "node", description: "The glyph; defaults to the close ✕." },
      { name: "onClick", type: "function", description: "Click handler." },
      { name: "size", type: "enum", values: ["md", "sm", "xs"], default: "md", description: "Button + glyph size." },
      { name: "danger", type: "boolean", description: "Destructive (red) hover." },
      { name: "disabled", type: "boolean", description: "Disable the button." },
      { name: "title", type: "string", description: "Native tooltip / aria title." },
    ],
  },
  {
    name: "Checkbox", group: "controls", importPath: "@/shared/ui/controls/Checkbox",
    description: "A controlled checkbox.",
    props: [
      { name: "checked", type: "boolean", required: true, description: "Checked state." },
      { name: "onChange", type: "function", description: "Toggle handler." },
      { name: "size", type: "number", default: 14, description: "Box size in px." },
      { name: "disabled", type: "boolean", description: "Disable the control." },
    ],
  },
  {
    name: "Toggle", group: "controls", importPath: "@/shared/ui/controls/Toggle",
    description: "A controlled on/off switch.",
    props: [
      { name: "on", type: "boolean", required: true, description: "On state." },
      { name: "onClick", type: "function", description: "Toggle handler." },
      { name: "size", type: "enum", values: ["xs", "sm", "md"], default: "md", description: "Switch size." },
      { name: "tone", type: "enum", values: ["accent", "success"], default: "accent", description: "On-state color." },
    ],
  },
  {
    name: "SegmentedControl", group: "controls", importPath: "@/shared/ui/controls/SegmentedControl",
    description: "A row of mutually-exclusive segment buttons.",
    props: [
      { name: "options", type: "array", required: true, description: "SegOption[] — { label, on, onClick, tone?, dot?, title? }." },
      { name: "variant", type: "enum", values: ["padded", "joined"], default: "padded", description: "Spacing style." },
      { name: "size", type: "enum", values: ["sm", "md"], default: "sm", description: "Control height." },
      { name: "label", type: "node", description: "An optional leading label." },
    ],
  },
  {
    name: "TextField", group: "controls", importPath: "@/shared/ui/controls/Field", passthrough: true,
    description: "A labelled text input (label + hint + trailing over the input).",
    props: [
      { name: "value", type: "string", required: true, description: "Input value." },
      { name: "onChange", type: "function", required: true, description: "(value) => void." },
      { name: "label", type: "node", description: "Field label." },
      { name: "hint", type: "node", description: "Sub-label hint." },
      { name: "trailing", type: "node", description: "Right-aligned control in the label row." },
    ],
  },
  {
    name: "SelectField", group: "controls", importPath: "@/shared/ui/controls/Field",
    description: "A labelled <select> (children are the <option>s).",
    props: [
      { name: "value", type: "string", required: true, description: "Selected value." },
      { name: "onChange", type: "function", required: true, description: "(value) => void." },
      { name: "children", type: "node", required: true, description: "The <option> elements." },
      { name: "label", type: "node", description: "Field label." },
      { name: "hint", type: "node", description: "Sub-label hint." },
    ],
  },
  // ---- data -----------------------------------------------------------------
  {
    name: "Card", group: "data", importPath: "@/shared/ui/data/Card",
    description: "The framed-panel primitive (.card) with an optional canonical head.",
    props: [
      CHILDREN,
      { name: "title", type: "node", description: "Canonical head title (h3)." },
      { name: "hint", type: "node", description: "Inline hint beside the title." },
      { name: "right", type: "node", description: "Right-aligned control in the head row." },
      { name: "header", type: "node", description: "A fully-custom header node (wins over title)." },
      { name: "tone", type: "color", description: "Border accent color." },
      { name: "interactive", type: "boolean", description: "Hover/press affordance." },
      { name: "pad", type: "enum", values: ["sm"], description: "Compact padding." },
      { name: "onClick", type: "function", description: "Click handler (implies interactive)." },
    ],
  },
  {
    name: "Chip", group: "data", importPath: "@/shared/ui/data/Chip",
    description: "A small rounded tag/badge; a tone or a custom color, optional dot.",
    props: [
      CHILDREN,
      { name: "tone", type: "enum", values: ["neutral", "accent", "success", "info", "danger"], default: "neutral", description: "Semantic color." },
      { name: "color", type: "color", description: "Custom color (overrides tone)." },
      { name: "dot", type: "boolean", description: "Show a leading status dot." },
      { name: "size", type: "enum", values: ["xs", "sm", "md"], default: "sm", description: "Chip size." },
    ],
  },
  {
    name: "StatTile", group: "data", importPath: "@/shared/ui/data/StatTile",
    description: "A key/value stat tile with an optional sub-line.",
    props: [
      { name: "k", type: "node", required: true, description: "The label." },
      { name: "v", type: "node", required: true, description: "The value." },
      { name: "sub", type: "node", description: "A sub-line under the value." },
      { name: "tone", type: "enum", values: ["success", "accent", "danger"], description: "Value color." },
    ],
  },
  {
    name: "FillBar", group: "data", importPath: "@/shared/ui/data/FillBar",
    description: "A horizontal progress/fill bar.",
    props: [
      { name: "value", type: "number", required: true, description: "Fill amount (0–1 fraction)." },
      { name: "color", type: "color", default: "var(--accent)", description: "Fill color." },
      { name: "track", type: "color", default: "var(--bg-elev2)", description: "Track (background) color." },
      { name: "height", type: "number", default: 8, description: "Bar height in px." },
      { name: "rounded", type: "boolean", default: true, description: "Round the ends." },
    ],
  },
  // ---- feedback -------------------------------------------------------------
  {
    name: "Banner", group: "feedback", importPath: "@/shared/ui/feedback/Banner",
    description: "An inline or full-width status banner with a tone.",
    props: [
      CHILDREN,
      { name: "tone", type: "enum", values: ["neutral", "info", "success", "warn", "danger", "accent"], default: "neutral", description: "Semantic color." },
      { name: "variant", type: "enum", values: ["inline", "bar"], default: "inline", description: "Inline chip vs full-width bar." },
      { name: "lead", type: "node", description: "Leading icon/label." },
      { name: "dot", type: "boolean", description: "Show a leading status dot." },
      { name: "loud", type: "boolean", description: "Stronger emphasis." },
      { name: "right", type: "node", description: "Right-aligned content." },
      { name: "onDismiss", type: "function", description: "Show a dismiss ✕ and call this." },
    ],
  },
  {
    name: "EmptyState", group: "feedback", importPath: "@/shared/ui/feedback/EmptyState",
    description: "A centered empty/zero-state with icon, copy, and actions.",
    props: [
      { name: "title", type: "node", required: true, description: "The headline." },
      { name: "description", type: "node", description: "Supporting copy." },
      { name: "icon", type: "node", description: "A leading icon/glyph." },
      { name: "iconVariant", type: "enum", values: ["solid", "dashed"], description: "Icon tile style." },
      { name: "actions", type: "node", description: "Action buttons row." },
      { name: "variant", type: "enum", values: ["inline", "card"], default: "inline", description: "Bare vs carded." },
      { name: "align", type: "enum", values: ["center", "left"], default: "center", description: "Alignment." },
    ],
  },
  {
    name: "StatusDot", group: "feedback", importPath: "@/shared/ui/feedback/StatusDot",
    description: "A small colored status dot, optionally pulsing.",
    props: [
      { name: "state", type: "enum", values: ["run", "wait", "idle", "stopped"], description: "Session-state color." },
      { name: "color", type: "color", description: "Custom color (overrides state)." },
      { name: "size", type: "number", default: 6, description: "Diameter in px." },
      { name: "pulse", type: "boolean", default: false, description: "Pulse animation." },
      { name: "title", type: "string", description: "Native tooltip." },
    ],
  },
];

/** Look up a primitive spec by name. */
export function findPrimitive(name: PrimitiveName): PrimitiveSpec | undefined {
  return UI_KIT.find((p) => p.name === name);
}

/** Group the kit by `PrimitiveGroup` (for a grouped palette in the builder). */
export function primitivesByGroup(): Record<PrimitiveGroup, PrimitiveSpec[]> {
  const out = { layout: [], typography: [], controls: [], data: [], feedback: [] } as Record<PrimitiveGroup, PrimitiveSpec[]>;
  for (const p of UI_KIT) out[p.group].push(p);
  return out;
}

/** The manifest as a JSON string — the wire form for an agent or the visual editor. */
export function manifestJson(): string {
  return JSON.stringify(UI_KIT, null, 2);
}
