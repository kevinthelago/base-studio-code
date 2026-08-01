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
//
// Consciously EXCLUDED from the kit (#2421): `overlay/promptDialog` (usePromptDialog /
// useConfirmDialog) — an imperative hook API (an async fn + a `dialog` node to render), not a
// composable primitive; a builder cannot instantiate a hook from a manifest node. Compose the
// registered `Dialog` instead.

// The authored-motion shape (#2867, epic #2865) — carried through to each emitted `ComponentRecord`'s
// `animations` and compiled to live `@keyframes` by the render engine (`@/shared/ui/kit`). Imported
// type-only (erased at compile time) so this module stays pure, JSON-serialisable data.

/** Every primitive the kit exposes to the builder. Also the key type of the render-map registry. */
export type PrimitiveName =
  // layout
  | "Box" | "Stack" | "Row" | "Spacer" | "Slot" | "Grid" | "SectionHeader" | "SectionLabel" | "Dialog" | "ModalScrim" | "ModalCard"
  // typography
  | "Text"
  // controls
  | "Button" | "IconButton" | "Checkbox" | "Toggle" | "SegmentedControl" | "TextField" | "TextArea" | "SelectField" | "Option"
  | "BackButton" | "ColorSwatch" | "ConfirmButton"
  // data
  | "Card" | "Chip" | "StatTile" | "FillBar" | "Code"
  | "Avatar" | "IconBox" | "CardListRow" | "DataTableRow" | "RoleTierChips"
  // data · charts (analytics primitives)
  | "StatCard" | "LineArea" | "Bars" | "Donut" | "HBars" | "Swimlane" | "Spark" | "Legend" | "StackedDayBars"
  // feedback
  | "Banner" | "InlineError" | "EmptyState" | "StatusDot" | "Skeleton" | "PageBoundary"
  // #2421 gap-fill — data chips/feeds, the overlay pane, and the telemetry chart trio
  | "LabelChip" | "ActivityFeed" | "Pane" | "TelemetryPanel" | "ItemBars" | "SplitBar"
  // #2475 — the key-value record rendering (the property-list archetype of the row vocabulary)
  | "KeyValueList"
  // layouts — the page-skeleton templates tier (#2197)
  | "MasterDetail" | "SplitView" | "GraphCanvas" | "PaneGrid" | "Tree" | "Sequence"
  // pages — the complete data-driven page compositions tier (#2505)
  | "TablePage" | "TreeExplorerPage" | "PipelinePage" | "NetworkPage" | "DashboardPage" | "CollectionPage" | "RecordPage";

export type PrimitiveGroup = "layout" | "typography" | "controls" | "data" | "feedback" | "layouts" | "pages";

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
  | "object"    // a single structured object (shape in the description)
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
  /** MOTION references (#2942, #3451) — the NAMES of the animations this primitive plays. The full
   *  defs live in the `base` kit's motion library (`shared/ui/kit/baseAnimations.ts`), NOT here: a base
   *  motion is owned in ONE place and every consumer references it by name, so an edit propagates to all
   *  (the resolver falls back to the `base` kit — `resolveComponentAnimationDefs`). Emitted verbatim onto
   *  the generated `ComponentRecord.animations`. Absent ⇒ no motion. */
  animations?: string[];
}

// Shared prop fragments reused across the layout primitives.
const GAP: PropSpec = { name: "gap", type: "space", description: "Gap between children — a rung (xs…xl) or raw px." };
const ALIGN = (dflt: string): PropSpec => ({ name: "align", type: "enum", values: ["start", "center", "end", "baseline", "stretch"], default: dflt, description: "Cross-axis alignment." });
const JUSTIFY: PropSpec = { name: "justify", type: "enum", values: ["start", "center", "end", "between", "around", "evenly"], description: "Main-axis distribution." };
const WRAP: PropSpec = { name: "wrap", type: "boolean", description: "Allow children to wrap onto multiple lines." };
const PAD: PropSpec = { name: "pad", type: "space", description: "Inner padding — a rung/px, or a [block, inline] pair." };
const INLINE = (kind: string): PropSpec => ({ name: "inline", type: "boolean", description: `Render as inline-${kind} instead of ${kind}.` });
const CHILDREN: PropSpec = { name: "children", type: "node", required: true, description: "Content." };

// Shared prop fragments for the Pages tier (#2505) — the titled header bar + the house selection idiom.
const PAGE_TITLE: PropSpec = { name: "title", type: "node", required: true, description: "Page title (the header bar)." };
const PAGE_HINT: PropSpec = { name: "hint", type: "node", description: "Dimmed inline hint after the title." };
const PAGE_TOOLBAR: PropSpec = { name: "toolbar", type: "node", description: "Right-aligned header controls (search, filters, actions)." };
const SELECTED_ID = (what: string): PropSpec => ({ name: "selectedId", type: "string", description: `Controlled selection — the selected ${what} id (pair with onSelect). Omit for uncontrolled.` });
const DEFAULT_SELECTED = (what: string): PropSpec => ({ name: "defaultSelectedId", type: "string", description: `Uncontrolled: the initially selected ${what} id.` });
const ON_SELECT = (what: string): PropSpec => ({ name: "onSelect", type: "function", description: `Fires with the clicked ${what}'s id (both selection modes).` });
const PAGE_DETAIL = (of: string, dflt: string): PropSpec => ({ name: "detail", type: "function", description: `Detail panel override — a render fn of the selected ${of}. Default: ${dflt}.` });

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
    name: "Slot", group: "layout", importPath: "@/shared/ui/layout/Slot",
    description: "A HOLE the host fills with its own React (#3504) — the seam between a data tree and the app code around it. Not a visual component: the spec says WHERE, the host's `slots` map says WHAT. Use it for a feature component (one owning hooks/queries/app state) that a spec cannot and should not express.",
    props: [
      { name: "name", type: "string", required: true, description: "The key the host's `slots` map must carry. An unfilled name renders a visible marker, never nothing." },
    ],
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
  {
    name: "SectionHeader", group: "layout", importPath: "@/shared/ui/layout/SectionHeader",
    description: "The one uppercase section-title row — `title · hint · spacer · meta|right`.",
    props: [
      { name: "title", type: "node", required: true, description: "Section title (uppercase h3)." },
      { name: "hint", type: "node", description: "Dimmed inline sub-text after the title." },
      { name: "meta", type: "node", description: "Right-aligned dim mono text (e.g. a count)." },
      { name: "right", type: "node", description: "Right-aligned raw content (input/button) — overrides meta." },
      { name: "titleStyle", type: "style", description: "Inline style for the title element." },
    ],
  },
  {
    name: "SectionLabel", group: "layout", importPath: "@/shared/ui/layout/SectionLabel",
    description: "The uppercase mono micro-label — a dim/muted section/kv caption, optionally a space-between label row via `right`.",
    props: [
      CHILDREN,
      { name: "size", type: "enum", values: ["sm", "md"], default: "md", description: "md (10px/.06em) or sm (9px/.08em, denser KPI tiles); a raw px number is also legal (dense .08em tracking)." },
      { name: "tone", type: "enum", values: ["dim", "muted"], default: "dim", description: "Label color." },
      { name: "right", type: "node", description: "Right-aligned slot — renders a space-between label row (label · right); style then lands on the row." },
    ],
  },
  {
    name: "Dialog", group: "layout", importPath: "@/shared/ui/overlay/Dialog",
    description: "The standard modal dialog card (built on ModalScrim) — title, body, right-aligned actions.",
    props: [
      { name: "title", type: "string", required: true, description: "Dialog heading." },
      { name: "children", type: "node", required: true, description: "Body content." },
      { name: "actions", type: "node", required: true, description: "Footer action buttons (right-aligned)." },
      { name: "onDismiss", type: "function", required: true, description: "Escape / scrim-click dismiss handler." },
      { name: "danger", type: "boolean", description: "Red heading + border for a destructive confirm." },
    ],
  },
  {
    name: "ModalScrim", group: "layout", importPath: "@/shared/ui/overlay/ModalScrim",
    description: "The one centered-modal overlay — a full-screen scrim that flex-centers its card, with Escape + overlay-click dismiss.",
    props: [
      { name: "children", type: "node", required: true, description: "The centered modal card." },
      { name: "onDismiss", type: "function", description: "Escape / scrim-click dismiss; omit to make it non-dismissable." },
      { name: "align", type: "enum", values: ["center", "start"], default: "center", description: "Center the card, or top-align it for tall scrolling modals." },
      { name: "blur", type: "boolean", default: false, description: "Add a backdrop blur." },
    ],
  },
  {
    name: "ModalCard", group: "layout", importPath: "@/shared/ui/overlay/ModalCard",
    description: "The titled head/body/foot modal card over ModalScrim — icon+title(+sub) head with a ✕, scrollable body, optional footer action row.",
    props: [
      { name: "title", type: "node", required: true, description: "Head title (mono h2)." },
      { name: "children", type: "node", required: true, description: "Body content (scrolls)." },
      { name: "sub", type: "node", description: "Dim sub-line under the title." },
      { name: "icon", type: "node", description: "Leading head glyph in a 30px IconBox." },
      { name: "iconBackground", type: "color", description: "Icon tile background (default: translucent accent)." },
      { name: "iconColor", type: "color", description: "Icon glyph color (default: accent)." },
      { name: "onClose", type: "function", description: "Wires the head ✕ + Escape + scrim-click dismiss; omit for non-dismissable." },
      { name: "busy", type: "boolean", default: false, description: "Disable the ✕ and suppress scrim/Escape dismiss while an op runs." },
      { name: "width", type: "number", default: 540, description: "Card width (px or CSS length); capped at 100%." },
      { name: "maxHeight", type: "string", default: "88vh", description: "Card max height." },
      { name: "align", type: "enum", values: ["center", "start"], default: "center", description: "Scrim card alignment — start top-aligns tall scrolling modals." },
      { name: "blur", type: "boolean", default: true, description: "Backdrop blur." },
      { name: "headExtra", type: "node", description: "Extra head rows (search/tabs/meta) inside the bordered head block." },
      { name: "foot", type: "node", description: "Footer action-row content." },
      { name: "bodyStyle", type: "style", description: "Merged onto the body (padding/overflow overrides for list bodies)." },
      { name: "footStyle", type: "style", description: "Merged onto the foot row." },
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
      { name: "loading", type: "boolean", description: "Render the text loading — an inline shimmer line the height of the text (#2302)." },
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
    // Base motion (#3451): the primary action plays the `base` kit's hover `lift` (owned in baseAnimations.ts).
    animations: ["lift"],
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
      // Accessibility (#3500). The component has always accepted these; the manifest omitted them, which
      // made an accessible switch UNAUTHORABLE as data — Toggle is not passthrough, so a spec setting
      // them was rejected as an unknown prop. A spec-rendered toggle must be able to say it is a switch.
      { name: "role", type: "string", description: "ARIA role — pass \"switch\" for an accessible on/off control." },
      { name: "ariaChecked", type: "boolean", description: "aria-checked; mirror of `on` when role is \"switch\"." },
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
      { name: "loading", type: "boolean", description: "Render the field loading — keep the label, skeleton the input (#2302)." },
    ],
  },
  {
    name: "TextArea", group: "controls", importPath: "@/shared/ui/controls/Field", passthrough: true,
    description: "A labelled multiline text area — the TextField sibling (same label + hint + trailing over an .input <textarea>).",
    props: [
      { name: "value", type: "string", required: true, description: "Textarea value." },
      { name: "onChange", type: "function", required: true, description: "(value) => void." },
      { name: "label", type: "node", description: "Field label." },
      { name: "hint", type: "node", description: "Sub-label hint." },
      { name: "trailing", type: "node", description: "Right-aligned control in the label row." },
      { name: "loading", type: "boolean", description: "Render the field loading — keep the label, skeleton the textarea (#2302)." },
    ],
  },
  {
    name: "SelectField", group: "controls", importPath: "@/shared/ui/controls/Field", passthrough: true,
    description: "A labelled <select> (children are the <option>s).",
    props: [
      { name: "value", type: "string", required: true, description: "Selected value." },
      { name: "onChange", type: "function", required: true, description: "(value) => void." },
      { name: "children", type: "node", required: true, description: "The Option children." },
      { name: "label", type: "node", description: "Field label." },
      { name: "hint", type: "node", description: "Sub-label hint." },
    ],
  },
  {
    name: "Option", group: "controls", importPath: "@/shared/ui/controls/Option",
    description: "One choice inside a SelectField — the data-authorable <option>.",
    props: [
      { name: "children", type: "node", description: "The visible label." },
      { name: "value", type: "string", description: "Submitted value; defaults to the visible text." },
      { name: "disabled", type: "boolean", description: "Unselectable (e.g. a placeholder)." },
    ],
  },
  {
    name: "BackButton", group: "controls", importPath: "@/shared/ui/controls/BackButton",
    description: "The one canonical back control — always the chevron_left glyph, as a boxed icon or a chevron + text label.",
    props: [
      { name: "onClick", type: "function", required: true, description: "Click handler." },
      { name: "aria-label", type: "string", required: true, description: "Screen-reader label — required (the bare chevron has no text)." },
      { name: "variant", type: "enum", values: ["icon", "text"], default: "text", description: "Boxed 30×30 chevron (icon) vs chevron + text label (text)." },
      { name: "label", type: "string", description: "Text-variant label after the chevron (ignored for icon)." },
      { name: "disabled", type: "boolean", description: "Disable the button." },
      { name: "size", type: "number", description: "Chevron size in px (default 18 icon / 14 text)." },
      { name: "title", type: "string", description: "Native tooltip." },
    ],
  },
  {
    name: "ColorSwatch", group: "controls", importPath: "@/shared/ui/controls/ColorSwatch",
    description: "The small rounded color square used as a category / profile / legend indicator.",
    props: [
      { name: "color", type: "color", required: true, description: "Fill color — any CSS color incl. var()/color-mix()." },
      { name: "size", type: "number", default: 9, description: "Square side in px." },
      { name: "radius", type: "number", default: 2, description: "Corner radius in px." },
    ],
  },
  {
    name: "ConfirmButton", group: "controls", importPath: "@/shared/ui/controls/ConfirmButton",
    description: "A two-step confirm button — the first click arms it (turns red), the second within the same focus fires; blur disarms.",
    props: [
      { name: "label", type: "string", required: true, description: "Resting label." },
      { name: "armedLabel", type: "string", required: true, description: "Label shown once armed (after the first click)." },
      { name: "onConfirm", type: "function", required: true, description: "Fired on the confirming second click." },
      { name: "size", type: "enum", values: ["sm", "md"], default: "md", description: "Control size — md (reset cards) or sm (inline row actions)." },
      { name: "disabled", type: "boolean", default: false, description: "Disable + dim the button." },
      { name: "danger", type: "boolean", default: true, description: "Red (destructive) styling when armed." },
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
      { name: "loading", type: "boolean", description: "Render the card loading — a skeleton body the shape of its content (#2302)." },
    ],
    // Base motion (#3451): the card plays the `base` kit's one-shot `fade-in` on mount (owned in baseAnimations.ts).
    animations: ["fade-in"],
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
      { name: "loading", type: "boolean", description: "Render the chip loading — a shimmer pill (#2302)." },
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
      { name: "loading", type: "boolean", description: "Render the bar loading — an indeterminate shimmer track (#2302)." },
    ],
  },
  {
    name: "Code", group: "data", importPath: "@/shared/ui/data/Code",
    description: "A read-only monospace code/prompt block — a scrollable framed <pre>.",
    props: [
      CHILDREN,
      { name: "maxHeight", type: "number", default: 150, description: "Max scroll height in px." },
      { name: "wrap", type: "boolean", default: true, description: "Soft-wrap long lines vs a horizontal scroll." },
      { name: "tone", type: "enum", values: ["dim", "muted", "accent", "danger", "success"], default: "muted", description: "Foreground color tone." },
      { name: "loading", type: "boolean", description: "Render the block loading — shimmer lines inside the frame (#2302)." },
    ],
  },
  {
    name: "Avatar", group: "data", importPath: "@/shared/ui/data/Avatar",
    description: "A round GitHub user avatar — the login's initial on a login-hashed color.",
    props: [
      { name: "login", type: "string", required: true, description: "GitHub login — its initial on a login-hashed color." },
      { name: "size", type: "number", default: 20, description: "Diameter in px." },
      { name: "palette", type: "boolean", default: false, description: "Use the discrete assignee-stack palette instead of the continuous login hue." },
      { name: "bordered", type: "boolean", default: false, description: "1.5px canvas ring so overlapping avatars read as separate disks." },
      { name: "ml", type: "number", description: "Left margin — negative for overlapping assignee stacks." },
      { name: "fontScale", type: "number", default: 0.5, description: "Initial font size as a fraction of size." },
    ],
  },
  {
    name: "IconBox", group: "data", importPath: "@/shared/ui/data/IconBox",
    description: "A centered fixed-size icon/glyph square — the dedup'd tile behind the planner modal + card glyphs.",
    props: [
      CHILDREN,
      { name: "size", type: "number", default: 30, description: "Square side in px." },
      { name: "radius", type: "number", default: 7, description: "Corner radius in px." },
      { name: "background", type: "color", description: "Background color." },
      { name: "color", type: "color", description: "Foreground color." },
      { name: "fontSize", type: "number", description: "Glyph font size in px." },
      { name: "fontWeight", type: "number", default: 700, description: "Glyph font weight." },
      { name: "border", type: "string", description: "Full border shorthand (e.g. 1px solid …)." },
    ],
  },
  {
    name: "CardListRow", group: "data", importPath: "@/shared/ui/data/CardListRow",
    description: "The selectable card-list row — `[lead · title+badge / subtitle · trailing]`; the card archetype of the row vocabulary (#1865).",
    props: [
      { name: "title", type: "node", required: true, description: "Primary label." },
      { name: "lead", type: "node", description: "18px lead column — a status dot, icon, or avatar." },
      { name: "badge", type: "node", description: "A pill next to the title (left of the spacer)." },
      { name: "titleAside", type: "node", description: "Right-aligned element on the title line." },
      { name: "subtitle", type: "node", description: "Secondary line under the title." },
      { name: "body", type: "node", description: "Full-width rich content below the header line." },
      { name: "trailing", type: "node", description: "Trailing (auto-width) column — chips, counts, controls." },
      { name: "selected", type: "boolean", description: "Selection highlight." },
      { name: "off", type: "boolean", description: "Dimmed/disabled look." },
      { name: "variant", type: "enum", values: ["card", "grouped"], default: "card", description: "Bordered card vs borderless top-separated group row." },
      { name: "accent", type: "color", description: "Left-rail accent color shown when selected." },
      { name: "onClick", type: "function", description: "Click handler (adds a clickable affordance)." },
    ],
  },
  {
    name: "DataTableRow", group: "data", importPath: "@/shared/ui/data/DataTableRow",
    description: "One columnar row of a data table — the columnar archetype of the row vocabulary (#1865; sibling: CardListRow).",
    props: [
      { name: "template", type: "string", required: true, description: "grid-template-columns — share with the DataTableHeader so cells align under labels." },
      { name: "children", type: "node", required: true, description: "Cell content, one node per column." },
      { name: "index", type: "number", description: "Row index — odd rows get a zebra-stripe when provided." },
      { name: "selected", type: "boolean", description: "Selection highlight." },
      { name: "off", type: "boolean", description: "Dimmed/disabled look." },
      { name: "onClick", type: "function", description: "Click handler." },
      { name: "height", type: "number", default: 37, description: "Fixed row height in px." },
    ],
  },
  {
    name: "RoleTierChips", group: "data", importPath: "@/shared/ui/data/RoleTierChips",
    description: "A session role's capability tiers (git · github · code · net) as colored pills — the permission floor a persona/position inherits.",
    props: [
      { name: "role", type: "string", required: true, description: "The SessionRole whose capability floor to render (planner/worker/director/…)." },
    ],
  },
  // ---- data · charts (analytics primitives, #399) ---------------------------
  {
    name: "StatCard", group: "data", importPath: "@/shared/ui/charts/primitives",
    description: "An analytics KPI card — label, big value, sub-line, optional trend delta.",
    props: [
      { name: "k", type: "string", required: true, description: "The stat label." },
      { name: "v", type: "node", required: true, description: "The stat value." },
      { name: "sub", type: "node", description: "A sub-line under the value." },
      { name: "tone", type: "enum", values: ["fg", "accent", "info", "success", "danger"], default: "fg", description: "Value color tone." },
      { name: "loading", type: "boolean", description: "Render value + sub as shimmer placeholders while the metric loads (#2234)." },
    ],
  },
  {
    name: "LineArea", group: "data", importPath: "@/shared/ui/charts/Charts",
    description: "A multi-series SVG line / area chart with optional hover tooltips.",
    props: [
      { name: "series", type: "array", required: true, description: "LineSeries[] — { name, color, data:number[], width?, dash?, dots?, fill?, dotR? }." },
      { name: "labels", type: "array", required: true, description: "X-axis labels (string[]), one per data point." },
      { name: "height", type: "number", default: 150, description: "Chart height in px." },
      { name: "yMax", type: "number", description: "Fixed y-axis max (else derived from the data)." },
      { name: "area", type: "boolean", default: true, description: "Fill the area under each series." },
      { name: "fmtY", type: "function", description: "Format a y value for the axis + tooltip." },
    ],
  },
  {
    name: "Bars", group: "data", importPath: "@/shared/ui/charts/Charts",
    description: "A grouped or stacked SVG bar chart with optional hover tooltips.",
    props: [
      { name: "groups", type: "array", required: true, description: "BarGroup[] — { name, color, data:number[] }." },
      { name: "labels", type: "array", required: true, description: "X-axis labels (string[]), one per bucket." },
      { name: "height", type: "number", default: 130, description: "Chart height in px." },
      { name: "stacked", type: "boolean", default: false, description: "Stack the groups instead of clustering them." },
      { name: "fmtY", type: "function", description: "Format a y value for the axis + tooltip." },
    ],
  },
  {
    name: "Donut", group: "data", importPath: "@/shared/ui/charts/Charts",
    description: "A donut / gauge ring chart with an optional center label.",
    props: [
      { name: "slices", type: "array", required: true, description: "DonutSlice[] — { name, value, color }." },
      { name: "size", type: "number", default: 132, description: "Diameter in px." },
      { name: "thickness", type: "number", default: 16, description: "Ring thickness in px." },
    ],
  },
  {
    name: "HBars", group: "data", importPath: "@/shared/ui/charts/Charts",
    description: "A ranked list of horizontal meter bars (label · meter · value).",
    props: [
      { name: "rows", type: "array", required: true, description: "HBarRow[] — { label, value, color?, strong?, icon?, tag? }." },
      { name: "fmtV", type: "function", description: "Format a row value." },
      { name: "max", type: "number", description: "Fixed bar max (else the largest row value)." },
    ],
  },
  {
    name: "Swimlane", group: "data", importPath: "@/shared/ui/charts/Charts",
    description: "A swimlane / activity timeline — points + spans across labeled lanes, with optional time markers.",
    props: [
      { name: "lanes", type: "array", required: true, description: "SwimLane[] — { name, color? }." },
      { name: "events", type: "array", required: true, description: "SwimEvent[] — { lane, t0, t1?, color, label, r? } (t in 0–1)." },
      { name: "height", type: "number", default: 26, description: "Lane height in px." },
      { name: "marks", type: "array", description: "SwimMark[] — { t, label } vertical time markers." },
    ],
  },
  {
    name: "Spark", group: "data", importPath: "@/shared/ui/charts/Charts",
    description: "A tiny inline sparkline for a numeric series.",
    props: [
      { name: "data", type: "array", required: true, description: "The numeric series (number[]) — needs ≥2 points." },
      { name: "color", type: "color", required: true, description: "Line / fill color." },
      { name: "w", type: "number", default: 70, description: "Width in px." },
      { name: "h", type: "number", default: 20, description: "Height in px." },
      { name: "fill", type: "boolean", default: true, description: "Fill under the line." },
      { name: "dot", type: "boolean", default: true, description: "Show a dot at the last point." },
    ],
  },
  {
    name: "Legend", group: "data", importPath: "@/shared/ui/charts/Charts",
    description: "A swatch + label (+ optional value) legend row for a chart.",
    props: [
      { name: "items", type: "array", required: true, description: "LegendItem[] — { color, label, value? }." },
    ],
  },
  {
    name: "StackedDayBars", group: "data", importPath: "@/shared/ui/charts/Charts",
    description: "A panel-wrapped two-series stacked bar chart over a run of days (the shared over-time card).",
    props: [
      { name: "data", type: "array", required: true, description: "StackedDay[] — { day, upper, lower }." },
      { name: "title", type: "string", required: true, description: "Card title." },
      { name: "subtitle", type: "string", required: true, description: "Card subtitle." },
      { name: "upperLabel", type: "string", required: true, description: "Legend label for the upper (top) series." },
      { name: "lowerLabel", type: "string", required: true, description: "Legend label for the lower (baseline) series." },
      { name: "upperColor", type: "color", default: "var(--accent)", description: "Upper series color." },
      { name: "lowerColor", type: "color", default: "var(--danger)", description: "Lower series color." },
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
    name: "InlineError", group: "feedback", importPath: "@/shared/ui/feedback/InlineError",
    description: "A small static mono danger callout — a short error string on a translucent danger wash.",
    props: [
      CHILDREN,
      { name: "pad", type: "space", default: "[8, 12]", description: "Inner padding — a rung/px or a [block, inline] pair." },
      { name: "radius", type: "enum", values: ["sm", "md", "lg"], default: 4, description: "Corner radius rung (--r-*) or raw px." },
      { name: "borderFade", type: "number", default: 70, description: "Border tint — transparency % of --danger in the 1px border (some sites use 60)." },
    ],
  },
  {
    // #4172 — failure containment as a COMPOSABLE primitive. #4170 built this into the app's own Screen;
    // registering it means a DESIGNED page can carry the same guarantee. Grouped with the other
    // feedback surfaces because what it renders is an error state.
    name: "PageBoundary", group: "feedback", importPath: "@/shared/ui/layouts/PageBoundary",
    description:
      "Contains a render failure to ONE page: catches an error thrown by its children and shows a " +
      "recoverable fallback in their place, so a broken page cannot blank the surface hosting it. " +
      "Wrap a page composition's body. Clears itself when `page` changes, so navigating away recovers.",
    props: [
      CHILDREN,
      { name: "page", type: "string", required: true, description: "The page id — named in the fallback, and the reset key: changing it clears a caught error." },
      { name: "title", type: "string", default: "This page didn’t load.", description: "Fallback headline." },
      { name: "hint", type: "string", description: "How to recover, in the host's own words (e.g. which navigation to use). Defaults to a neutral line — say what YOUR app offers." },
      { name: "retryLabel", type: "string", default: "Try again", description: "Label of the retry button, which re-renders the children." },
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
    // Base motion (#3451): the live status dot plays the `base` kit's breathing `pulse` (owned in baseAnimations.ts).
    animations: ["pulse"],
  },
  {
    name: "Skeleton", group: "feedback", importPath: "@/shared/ui/feedback/Skeleton",
    description: "The shared loading placeholder — a shimmering block that holds a card's layout while data loads (#2234).",
    props: [
      { name: "w", type: "number", default: "100%", description: "Width — a px number or a CSS length string." },
      { name: "h", type: "number", default: 12, description: "Height — a px number or a CSS length string." },
      { name: "radius", type: "number", default: 6, description: "Corner radius in px." },
    ],
  },

  // ---- layouts (page-skeleton templates — the Layouts tier, #2197) -----------
  {
    name: "MasterDetail", group: "layouts", importPath: "@/shared/ui/layouts/MasterDetail",
    description: "The list+detail page skeleton — a fixed-width bordered scroll RAIL beside a flex scroll DETAIL, under an optional TOOLBAR. Owns rail width/border/scroll + detail scroll/padding by construction.",
    props: [
      { name: "rail", type: "node", required: true, description: "The master column — the list/nav rail." },
      { name: "detail", type: "node", required: true, description: "The detail column — the selected item's editor/view." },
      { name: "toolbar", type: "node", description: "Optional full-width toolbar/header above both columns." },
      { name: "railWidth", type: "number", default: 240, description: "Fixed rail width in px (the starting width when resizable)." },
      { name: "railPad", type: "space", default: 14, description: "Rail inner padding — a rung/px or [block, inline] pair." },
      { name: "detailPad", type: "space", default: 20, description: "Detail inner padding — a rung/px or [block, inline] pair." },
      { name: "resizable", type: "boolean", default: false, description: "Opt into a drag-resizable rail (a .resize-x splitter), bounded by railMin/railMax." },
    ],
  },
  {
    name: "SplitView", group: "layouts", importPath: "@/shared/ui/layouts/SplitView",
    description: "The two-pane split page skeleton — a flexing PRIMARY pane beside (or above) a fixed-size, drag-resizable SECONDARY pane, under an optional TOOLBAR. The canonical planner session (terminal + inspector) split.",
    props: [
      { name: "primary", type: "node", required: true, description: "The flexing pane — fills the remaining space (terminal, editor, main content)." },
      { name: "secondary", type: "node", required: true, description: "The fixed-size, drag-resizable trailing pane (inspector, sidebar, detail)." },
      { name: "toolbar", type: "node", description: "Optional full-width toolbar/header above the split." },
      { name: "orientation", type: "enum", values: ["horizontal", "vertical"], default: "horizontal", description: "horizontal → side by side; vertical → primary above secondary." },
      { name: "resizable", type: "boolean", default: true, description: "Draw the drag splitter (opt out for a fixed secondary), bounded by secondaryMin/secondaryMax." },
      { name: "secondarySize", type: "number", default: 340, description: "Secondary size in px (width when horizontal, height when vertical) — the starting size." },
      { name: "divider", type: "boolean", default: true, description: "Draw the 1px divider border between the two panes." },
    ],
  },
  {
    name: "GraphCanvas", group: "layouts", importPath: "@/shared/ui/layouts/GraphCanvas",
    description: "The pan/zoom graph page skeleton — a full-height left RAIL and right INSPECTOR flanking a content column whose TOOLBAR sits only over the pan/zoom CANVAS (viewport-clip + transformed world layer), with an optional bottom DOCK strip. Owns the viewport ref/wheel/pan wiring + world transform.",
    props: [
      { name: "vp", type: "object", required: true, description: "The viewport created by the page's useGraphViewport()." },
      { name: "world", type: "object", required: true, description: "World (design-space) size { w, h } — drives the world layer's box." },
      { name: "toolbar", type: "node", required: true, description: "Full toolbar content (search + palette + <ZoomControls vp={vp}/> + fit)." },
      { name: "children", type: "node", required: true, description: "World-layer content: grid, SVG edges, node cards — positioned in world coords." },
      { name: "rail", type: "node", description: "Optional left rail/sidebar (feature-styled full node)." },
      { name: "inspector", type: "node", description: "Optional inspector column on the right (feature-styled full node)." },
      { name: "dock", type: "node", description: "Optional strip docked below the canvas (inside the content column, flex:none) — e.g. a docked session terminal. Caller owns its height/handle." },
      { name: "overlays", type: "node", description: "Fixed overlays drawn over the canvas but NOT transformed (hints, legends)." },
      { name: "grid", type: "boolean", default: false, description: "Dotted graph-paper backdrop — an infinite grid on the viewport that tracks zoom + pan." },
      { name: "gridSize", type: "number", default: 24, description: "Grid tile size in world px (scaled by zoom on screen)." },
      { name: "railResizable", type: "boolean", default: false, description: "Make the left rail drag-resizable (a .resize-x splitter)." },
      { name: "inspectorResizable", type: "boolean", default: false, description: "Make the right inspector drag-resizable (splitter on its left edge)." },
      { name: "onBackgroundClick", type: "function", description: "Fires on a genuine click on the empty canvas backdrop (not a pan-drag end, not a node press)." },
    ],
  },
  {
    name: "PaneGrid", group: "layouts", importPath: "@/shared/ui/layouts/PaneGrid",
    description: "The grid-of-panes page skeleton — a cols × rows CSS grid that flexes to fill its parent, with a uniform gap + padding, hosting N pane cells. The canonical Console tab grid (one per tab, kept alive across switches via hidden).",
    props: [
      { name: "children", type: "node", required: true, description: "The pane cells — N children laid across the grid tracks (cols × rows)." },
      { name: "cols", type: "number", required: true, description: "Column track count → repeat(cols, 1fr). Clamped to ≥ 1." },
      { name: "rows", type: "number", required: true, description: "Row track count → repeat(rows, 1fr). Clamped to ≥ 1." },
      { name: "gap", type: "number", default: 8, description: "Gap between cells in px." },
      { name: "pad", type: "number", default: 10, description: "Grid inner padding in px." },
      { name: "hidden", type: "boolean", default: false, description: "Render the grid display:none but keep it MOUNTED (children stay alive — the console cross-tab mount)." },
    ],
  },
  {
    name: "Sequence", group: "layouts", importPath: "@/shared/ui/layouts/Sequence",
    description: "The ordered-steps page skeleton for linked-list-shaped data (workflows, pipelines, wizards, timelines) — a status-colored step STRIP (nodes joined by directional prev→next connectors; horizontal stepper or vertical timeline rail) driving an active-step DETAIL panel, under an optional TOOLBAR. Owns the ordering, connectors, click-to-focus, and the strip's own overflow scroll.",
    props: [
      { name: "steps", type: "array", required: true, description: "SequenceStep[] — ordered { id, label, status?, hint? }; array order IS the sequence. status: complete | active | upcoming | blocked (default upcoming)." },
      { name: "detail", type: "function", description: "The focus panel — a render prop receiving the focused step. Omit for a strip-only sequence." },
      { name: "orientation", type: "enum", values: ["horizontal", "vertical"], default: "horizontal", description: "horizontal → stepper strip above the detail; vertical → timeline rail beside it." },
      { name: "toolbar", type: "node", description: "Optional full-width toolbar/header above the sequence." },
      { name: "selectedId", type: "string", description: "Controlled focused step id (pair with onSelect); omit for uncontrolled selection." },
      { name: "defaultSelectedId", type: "string", description: "Uncontrolled initial focus — defaults to auto-following the active step, else the first." },
      { name: "onSelect", type: "function", description: "Fires with the clicked step's id (both modes)." },
      { name: "railWidth", type: "number", default: 260, description: "Timeline rail width in px (vertical only)." },
      { name: "detailPad", type: "space", default: 20, description: "Detail inner padding — a rung/px or [block, inline] pair." },
    ],
  },
  {
    name: "Tree", group: "layouts", importPath: "@/shared/ui/layouts/Tree",
    description: "The tree page skeleton for hierarchy-shaped data (#2476) — one recursive `nodes` prop, two variants: INDENTED (file-explorer rail of collapsible, depth-indented rows + a detail panel, for deep/navigational trees) or LAYERED (a top-down org-chart canvas on the shared graph stack — layerDag + the edge grammar + GraphCanvas pan/zoom, for presentational hierarchies).",
    props: [
      { name: "nodes", type: "array", required: true, description: "The tree roots — a recursive forest of TreeNodeData ({ id, label, meta?, children? }). Ids must be unique." },
      { name: "variant", type: "enum", values: ["indented", "layered"], default: "indented", description: "indented → collapsible rows + detail; layered → top-down pan/zoom chart." },
      { name: "detail", type: "node", description: "Detail panel for the selected node — a node, or a render fn of the selected TreeNodeData. Indented: the detail column; layered: the canvas inspector." },
      { name: "toolbar", type: "node", description: "Optional toolbar — full-width above (indented) / in the canvas toolbar row before the zoom cluster (layered)." },
      { name: "selectedId", type: "string", description: "Controlled selection — the selected node id (pair with onSelect). Omit for uncontrolled (defaultSelectedId)." },
      { name: "onSelect", type: "function", description: "Fires with the clicked node's id (both selection modes)." },
      { name: "defaultCollapsedIds", type: "array", description: "Indented: branch ids that start collapsed (expansion is uncontrolled). Default: all expanded." },
      { name: "onToggle", type: "function", description: "Fires (id, expanded) when a branch expands/collapses." },
      { name: "indent", type: "number", default: 16, description: "Indented: px of indentation per depth level." },
      { name: "railWidth", type: "number", default: 260, description: "Indented: rail width in px (the starting width when resizable)." },
      { name: "resizable", type: "boolean", default: false, description: "Indented: opt into a drag-resizable rail (MasterDetail's .resize-x splitter)." },
    ],
  },
  // ---- #2421 gap-fill (contiguous block: data · layout/overlay · data · charts) ---------------
  {
    name: "LabelChip", group: "data", importPath: "@/shared/ui/data/LabelChip",
    description: "A GitHub issue/PR label chip — a dotted Chip tinted from the label's dynamic 6-hex color.",
    props: [
      { name: "label", type: "object", required: true, description: "The GitHub label — { name, color } (6-hex, no leading #)." },
    ],
  },
  {
    name: "ActivityFeed", group: "data", importPath: "@/shared/ui/data/ActivityFeed",
    description: "The \"Recent activity\" striped feed card — Avatar · action · target · repo · timeAgo rows, with loading + empty states.",
    props: [
      { name: "items", type: "array", required: true, description: "ActivityItem[] — { login, action, target, repo, createdAt }." },
      { name: "hint", type: "string", required: true, description: "Dimmed hint after the card title." },
      { name: "loading", type: "boolean", required: true, description: "Shimmer rows while the feed's source loads (only when items is empty)." },
      { name: "tone", type: "object", required: true, description: "action → color map — each caller keeps its own EVENT_TONE." },
      { name: "right", type: "node", description: "Optional header control on the right (e.g. a filter select)." },
      { name: "actionWidth", type: "number", default: 80, description: "Action column width in px (github uses 70, planner 80)." },
    ],
  },
  {
    name: "KeyValueList", group: "data", importPath: "@/shared/ui/data/KeyValueList",
    description: "The read-only label : value property list (#2475) — one aligned labelWidth·1fr grid of { k, v } rows. The key-value archetype of the row vocabulary (siblings: CardListRow, DataTableRow): a detail summary, config/property panel, or inspector facts block.",
    props: [
      { name: "items", type: "array", required: true, description: "KeyValueItem[] — the { k, v } rows, in display order." },
      { name: "labelWidth", type: "number", default: 120, description: "Fixed label column width in px." },
      { name: "mono", type: "boolean", default: false, description: "Render values (not labels) in the mono font — ids, paths, config values." },
      { name: "loading", type: "boolean", description: "Shimmer value placeholders (labels stay) while the record's source loads (#2302)." },
    ],
  },
  {
    name: "Pane", group: "layout", importPath: "@/shared/ui/overlay/Pane",
    description: "The ONE detail/editor pane — a header / scrollable-body / footer frame, as a slide-over drawer or an inline master-detail fill.",
    props: [
      { name: "mode", type: "enum", values: ["drawer", "inline"], default: "drawer", description: "Slide-over (scrim + slide-in) vs fills-its-container." },
      { name: "open", type: "boolean", default: true, description: "Drawer mode: drives the scrim/slide state and gates the body render." },
      { name: "header", type: "node", description: "Top-zone content (drawer mode auto-appends a close button)." },
      { name: "body", type: "node", description: "Body content — pass via body or as children." },
      { name: "children", type: "node", description: "Body content (alias of body)." },
      { name: "footer", type: "node", description: "Custom footer; omitted in drawer mode → the standard draft/remove bar." },
      { name: "onClose", type: "function", description: "Close (scrim click / ✕ / cancel / done) handler." },
      { name: "onRemove", type: "function", description: "Standard-footer remove handler for an existing item." },
      { name: "isDraft", type: "boolean", description: "Standard footer: drafting (cancel/done) vs existing (remove/done)." },
      { name: "onCommit", type: "function", description: "Standard-footer draft done handler." },
      { name: "commitDisabled", type: "boolean", description: "Disable the draft done button (e.g. a required field is empty)." },
      { name: "flush", type: "boolean", description: "Drop the body's default padding (sections supply their own)." },
      { name: "bare", type: "boolean", description: "Inline mode only: bare flex-column frame with no styled zone wrappers." },
      { name: "className", type: "string", description: "Extra class on the frame element." },
    ],
  },
  {
    name: "TelemetryPanel", group: "data", importPath: "@/shared/ui/charts/telemetry",
    description: "A framed analytics panel — bg-panel card with a baseline header (title · hint · right slot) over chart content.",
    props: [
      { name: "title", type: "string", required: true, description: "Panel title (mono h3)." },
      { name: "hint", type: "string", description: "Dimmed hint after the title." },
      { name: "right", type: "node", description: "Right-aligned header content (a legend, a filter, a count)." },
      CHILDREN,
    ],
  },
  {
    name: "ItemBars", group: "data", importPath: "@/shared/ui/charts/telemetry",
    description: "A vertical list of labelled FillBar rows (calls-per-server, fires-per-hook, …).",
    props: [
      { name: "rows", type: "array", required: true, description: "ItemBarRow[] — { key, label, meta?, value, fraction (0–1), color? }." },
      { name: "empty", type: "node", description: "Rendered when rows is empty; defaults to a \"No data recorded yet.\" hint." },
    ],
  },
  {
    name: "SplitBar", group: "data", importPath: "@/shared/ui/charts/telemetry",
    description: "A two-segment proportional bar with a label and the two counts (ok/err, allow/block, …).",
    props: [
      { name: "label", type: "string", required: true, description: "Row label." },
      { name: "a", type: "number", required: true, description: "First-segment count." },
      { name: "b", type: "number", required: true, description: "Second-segment count." },
      { name: "aLabel", type: "string", required: true, description: "First-segment legend label (e.g. ok)." },
      { name: "bLabel", type: "string", required: true, description: "Second-segment legend label (e.g. err)." },
      { name: "aColor", type: "color", default: "var(--success)", description: "First-segment color." },
      { name: "bColor", type: "color", default: "var(--danger)", description: "Second-segment color." },
    ],
  },

  // ---- pages (complete data-driven page compositions — the Pages tier, #2505) -----------------
  {
    name: "TablePage", group: "pages", importPath: "@/shared/ui/pages/TablePage",
    description: "The complete records-browser page for TABLE-shaped data — a titled header bar, a columnar data table (DataTableHeader + DataTableRow) rendered from typed columns × rows, and a selected-record detail (KeyValueList) in a SplitView inspector.",
    props: [
      PAGE_TITLE, PAGE_HINT, PAGE_TOOLBAR,
      { name: "columns", type: "array", required: true, description: "TablePageColumn[] — { key, label, width? }; order is display order, `key` addresses the row cells." },
      { name: "rows", type: "array", required: true, description: "TablePageRow[] — { id, cells: Record<key, ReactNode> }, in display order." },
      SELECTED_ID("row"), DEFAULT_SELECTED("row"), ON_SELECT("row"),
      PAGE_DETAIL("row", "a KeyValueList of the row's cells"),
      { name: "detailWidth", type: "number", default: 320, description: "Detail (SplitView secondary) width in px." },
    ],
  },
  {
    name: "TreeExplorerPage", group: "pages", importPath: "@/shared/ui/pages/TreeExplorerPage",
    description: "The complete hierarchy-explorer page for TREE-shaped data — the Tree template's indented variant (collapsible depth-indented rows) under a titled header bar, with the selected node's facts (id · meta · children) as a KeyValueList detail.",
    props: [
      PAGE_TITLE, PAGE_HINT, PAGE_TOOLBAR,
      { name: "nodes", type: "array", required: true, description: "The tree roots — a recursive forest of TreeNodeData ({ id, label, meta?, children? }). Ids must be unique." },
      SELECTED_ID("node"), DEFAULT_SELECTED("node"), ON_SELECT("node"),
      { name: "defaultCollapsedIds", type: "array", description: "Branch ids that start collapsed (expansion is uncontrolled). Default: all expanded." },
      PAGE_DETAIL("node", "the node's facts as a KeyValueList"),
      { name: "nodeFacts", type: "function", description: "Extra KeyValueItem[] appended to the default detail, derived from the selected node." },
      { name: "railWidth", type: "number", default: 260, description: "Rail width in px." },
    ],
  },
  {
    name: "PipelinePage", group: "pages", importPath: "@/shared/ui/pages/PipelinePage",
    description: "The complete pipeline/workflow page for LINKED-LIST-shaped data — the Sequence template (status-colored prev→next step strip) under a titled header bar, driving a focused-step detail: label + status Chip, description, and the step's facts as a KeyValueList.",
    props: [
      PAGE_TITLE, PAGE_HINT, PAGE_TOOLBAR,
      { name: "steps", type: "array", required: true, description: "PipelineStep[] — ordered SequenceStep ({ id, label, status?, hint? }) plus { description?, facts? }; array order IS the pipeline." },
      { name: "orientation", type: "enum", values: ["horizontal", "vertical"], default: "horizontal", description: "horizontal → stepper strip above the detail; vertical → timeline rail beside it." },
      SELECTED_ID("step"), DEFAULT_SELECTED("step"), ON_SELECT("step"),
      PAGE_DETAIL("step", "heading + status Chip + description + facts KeyValueList"),
    ],
  },
  {
    name: "NetworkPage", group: "pages", importPath: "@/shared/ui/pages/NetworkPage",
    description: "The complete node/edge workspace page for GRAPH-shaped data — GraphCanvas pan/zoom over typed { nodes, edges } laid out by the shared graph stack (findBackEdges + layerDag + orderLayers + the #2222 edge grammar), with a selected-node inspector (facts as a KeyValueList).",
    props: [
      { name: "title", type: "node", required: true, description: "Page title (the toolbar row)." },
      PAGE_HINT,
      { name: "toolbar", type: "node", description: "Extra toolbar controls, before the zoom cluster." },
      { name: "nodes", type: "array", required: true, description: "NetworkNodeData[] — { id, label, meta? }. Ids must be unique." },
      { name: "edges", type: "array", required: true, description: "NetworkEdgeData[] — directed { from, to, id? }; cycles are fine (layering breaks them, drawing keeps them)." },
      SELECTED_ID("node"), DEFAULT_SELECTED("node"), ON_SELECT("node"),
      PAGE_DETAIL("node", "label + facts (id · meta · in/out degree) as a KeyValueList"),
      { name: "inspectorWidth", type: "number", default: 300, description: "Inspector width in px when a node is selected." },
    ],
  },
  {
    name: "DashboardPage", group: "pages", importPath: "@/shared/ui/pages/DashboardPage",
    description: "The complete analytics dashboard page — a Grid of StatCard KPI tiles (optional inline Spark trends), a LineArea trend Card + a Donut/Legend breakdown Card, and an ActivityFeed column, all under a titled header bar. Renders entirely from typed stats/trend/breakdown/activity inputs.",
    props: [
      PAGE_TITLE, PAGE_HINT,
      { name: "toolbar", type: "node", description: "Right-aligned header controls (range toggle, filters)." },
      { name: "stats", type: "array", required: true, description: "DashboardStat[] — { k, v, sub?, tone?, trend?, trendColor? }, in display order." },
      { name: "trend", type: "object", description: "The trend chart card — { title, hint?, labels, series: LineSeries[] }. Omit to drop the card." },
      { name: "breakdown", type: "object", description: "The breakdown donut card — { title, hint?, slices: DonutSlice[] }. Omit to drop the card." },
      { name: "activity", type: "object", description: "The activity column — { hint, items: ActivityItem[], tone }. Omit to drop the column." },
    ],
  },
  {
    name: "CollectionPage", group: "pages", importPath: "@/shared/ui/pages/CollectionPage",
    description: "The complete master→detail collection page for LIST-shaped data — MasterDetail with the rail rendered as CardListRow items (badge Chip, subtitle, trailing meta) under a titled header bar, and a selected-item detail (title + subtitle + facts KeyValueList).",
    props: [
      PAGE_TITLE, PAGE_HINT, PAGE_TOOLBAR,
      { name: "items", type: "array", required: true, description: "CollectionItem[] — { id, title, subtitle?, badge?, badgeTone?, meta?, facts? }, in display order." },
      SELECTED_ID("item"), DEFAULT_SELECTED("item"), ON_SELECT("item"),
      PAGE_DETAIL("item", "title + subtitle + facts KeyValueList"),
      { name: "railWidth", type: "number", default: 280, description: "Rail width in px." },
    ],
  },
  {
    name: "RecordPage", group: "pages", importPath: "@/shared/ui/pages/RecordPage",
    description: "The complete record-detail page for KEY-VALUE-shaped data — a titled identity header (status Chip beside the title, subtitle, an actions slot) over grouped KeyValueList sections (a SectionLabel per group), with an optional side column for facts/related items.",
    props: [
      { name: "title", type: "node", required: true, description: "The record's identity — the page title (the header bar)." },
      { name: "subtitle", type: "node", description: "Dimmed identity sub-text after the title (the header hint slot)." },
      { name: "status", type: "string", description: "A status Chip label rendered beside the title (e.g. \"running\", \"archived\")." },
      { name: "statusTone", type: "enum", values: ["neutral", "accent", "success", "info", "danger"], default: "neutral", description: "Status Chip tone." },
      { name: "actions", type: "node", description: "Right-aligned header actions (edit, open, delete)." },
      { name: "sections", type: "array", required: true, description: "RecordSection[] — { label, entries: { k, v }[] }, in display order; each renders as a SectionLabel over a KeyValueList." },
      { name: "aside", type: "node", description: "Optional side column (facts, related items) beside the sections." },
      { name: "asideWidth", type: "number", default: 300, description: "Side column width in px." },
    ],
  },
];

/** Look up a primitive spec by name. */
export function findPrimitive(name: PrimitiveName): PrimitiveSpec | undefined {
  return UI_KIT.find((p) => p.name === name);
}

/** Group the kit by `PrimitiveGroup` (for a grouped palette in the builder). */
export function primitivesByGroup(): Record<PrimitiveGroup, PrimitiveSpec[]> {
  const out = { layout: [], typography: [], controls: [], data: [], feedback: [], layouts: [], pages: [] } as Record<PrimitiveGroup, PrimitiveSpec[]>;
  for (const p of UI_KIT) out[p.group].push(p);
  return out;
}

/** The manifest as a JSON string — the wire form for an agent or the visual editor. */
export function manifestJson(): string {
  return JSON.stringify(UI_KIT, null, 2);
}
