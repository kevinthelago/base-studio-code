// Generate the `react-ui` kit from the shared-UI manifest (#2305, slice 1). The app's OWN components
// are the first kit — derived from the authoritative introspection registry (`shared/ui/manifest.ts`,
// #2060, which `manifest.test.ts` keeps synced to the render-map) instead of a hand-listed seed. So the
// kit is COMPLETE (every registered primitive), NO-DRIFT (generated), and REAL (no fake demo rows).
//
// The manifest carries names + prop schemas + groups; the richer kit metadata it does NOT
// (variants/composes/wraps/whenUse/whenNot/srcText/version/role) is layered as a per-name GUIDANCE
// overlay. A primitive without an overlay entry gets sensible generated defaults + a stub source;
// authoring the rich guidance for the rest is #2305 slice 3.
import { UI_KIT, type PrimitiveSpec, type PropSpec as ManifestProp, type PrimitiveGroup } from "@/shared/ui/manifest";
import type { ComponentRecord, Kit, PropSpec, Role } from "./model";

export const REACT_UI_KIT_ID = "react-ui";

/** Default architectural role by manifest group (the overlay may override per component). */
const GROUP_ROLE: Record<PrimitiveGroup, Role> = {
  layout: "layout", typography: "primitive", controls: "primitive", data: "primitive", feedback: "primitive",
  layouts: "layout",
};

/** Kit metadata the manifest doesn't encode, keyed by component name. Ported from the #2269 seed for
 *  the components that had it; the rest fall back to generated defaults (rich guidance is slice 3). */
interface Guidance {
  role?: Role;
  version?: string;
  used?: number;
  tags?: string[];
  /** Overrides the manifest-derived variants entirely. */
  variants?: string[];
  composes?: string[];
  /** The raw intrinsic this component replaces — drives the derived lint rule (`deriveRules`). */
  wraps?: string;
  whenUse?: string[];
  whenNot?: string[];
  srcText?: string;
}

const GUIDANCE: Record<string, Guidance> = {
  Button: {
    version: "2.3.0", used: 214, tags: ["control", "form"], wraps: "button",
    variants: ["primary", "ghost", "danger", "sm"],
    whenUse: [
      "A single, discrete action the user can take.",
      'Form submit / primary CTA (use variant="primary", one per view).',
      'Inline row actions (use variant="ghost").',
    ],
    whenNot: ["Navigating between views — use a link.", "Toggling a persistent on/off state — use Toggle."],
    srcText: "export function Button({ variant, size, ...rest }: ButtonProps) {\n  return (\n    <button\n      className={cx(\"btn\", variant, size)}\n      {...rest}\n    />\n  );\n}",
  },
  Chip: {
    version: "1.4.1", used: 168, tags: ["badge", "status"], composes: ["StatusDot"],
    variants: ["neutral", "accent", "success", "info", "danger"],
    whenUse: ["A short, non-interactive status or category label.", "Dynamic colors (GitHub labels) via the color prop."],
    whenNot: ["A clickable filter — use SegmentedControl.", "Long text — chips are single-line."],
    srcText: "export function Chip({ tone = \"neutral\", color, dot, children }: ChipProps) {\n  if (color) return <span style={mix(color)}>{children}</span>;\n  return <span className={`chip tone-${tone}`}>{children}</span>;\n}",
  },
  TextField: {
    version: "1.2.0", used: 97, tags: ["form", "input"], wraps: "input",
    whenUse: ["Any single-line text input with a label.", "Controlled form fields (value + onChange)."],
    whenNot: ["Multi-line input — use a textarea.", "A boolean — use Toggle / Checkbox."],
    srcText: "export function TextField({ label, value, onChange, hint }: TextFieldProps) {\n  return (\n    <label className=\"field\">\n      <span>{label}</span>\n      <input className=\"input\" value={value}\n        onChange={(e) => onChange(e.target.value)} />\n    </label>\n  );\n}",
  },
  StatusDot: {
    version: "1.0.3", used: 142, tags: ["status"],
    whenUse: ["A tiny live activity indicator beside a label.", "Session / build state in a dense row."],
    whenNot: ["Conveying state by color alone — pair with text.", "A large status graphic — use a Banner."],
  },
  SegmentedControl: {
    role: "composite", version: "1.1.0", used: 63, tags: ["control"], composes: ["Button"],
    whenUse: ["2–4 mutually-exclusive options (mode / scope).", "A multi-toggle where each option holds its own state."],
    whenNot: ["Many options (>5) — use a select.", "A single on/off — use Toggle."],
  },
  Card: {
    role: "layout", version: "1.3.2", used: 121, tags: ["surface"],
    whenUse: ["Group related content in a framed surface.", "A selectable item in a list (interactive)."],
    whenNot: ["Full-bleed page sections — cards imply containment.", "A modal — use Dialog."],
  },
  EmptyState: {
    role: "composite", version: "1.0.5", used: 38, tags: ["feedback"], composes: ["Button", "Card"],
    whenUse: ["A list / view with nothing in it yet.", "An onboarding / connect prompt with a CTA."],
    whenNot: ["A transient loading state — use a skeleton.", "An error — use InlineError / Banner."],
  },

  // ── layout ──
  Box: {
    tags: ["layout", "container"], wraps: "div",
    whenUse: ["The generic styled container — any div you'd otherwise write raw.", "Applying token padding / bg / border / radius / shadow."],
    whenNot: ["A flex row or column — use Row / Stack.", "Text — use Text."],
  },
  Stack: {
    tags: ["layout"],
    whenUse: ["Stacking children vertically with a consistent gap.", "A form or a labelled list column."],
    whenNot: ["A horizontal cluster — use Row.", "A 2-D layout with tracks — use Grid."],
  },
  Row: {
    tags: ["layout"], composes: ["Spacer"],
    whenUse: ["Laying items in a horizontal line with a gap.", "A header / toolbar cluster (pair with Spacer to push trailing items)."],
    whenNot: ["A vertical column — use Stack.", "Aligned tabular data — use Grid."],
  },
  Spacer: {
    tags: ["layout"],
    whenUse: ["Pushing trailing items to the far edge of a Row (greedy flex:1).", "A fixed rigid gap between two specific items."],
    whenNot: ["Even spacing between many children — use the parent's gap.", "Inner padding — use pad."],
  },
  Grid: {
    tags: ["layout"],
    whenUse: ["A 2-D layout with explicit column / row tracks.", "A responsive card or tile grid."],
    whenNot: ["A single row or column — use Row / Stack.", "One-off positioning — use Box."],
  },
  SectionHeader: {
    tags: ["layout", "chrome"],
    whenUse: ["A titled section heading with an optional trailing control.", "The head of a settings or card group."],
    whenNot: ["A page title — that's screen chrome.", "A bare eyebrow label — use SectionLabel."],
  },
  SectionLabel: {
    tags: ["layout", "chrome"],
    whenUse: ["A small uppercase eyebrow labelling a group.", "A field-group or list-section caption."],
    whenNot: ["A full heading with actions — use SectionHeader.", "Body copy — use Text."],
  },
  Dialog: {
    role: "composite", tags: ["overlay"], composes: ["ModalScrim", "Card"],
    whenUse: ["A focused, blocking task (confirm or short form).", "Content that must be dismissed before continuing."],
    whenNot: ["Non-blocking info — use a Banner / toast.", "A large multi-step flow — use a page / stage."],
  },
  ModalScrim: {
    tags: ["overlay"],
    whenUse: ["The dimmed, click-to-dismiss backdrop behind a modal surface.", "Trapping focus under a Dialog."],
    whenNot: ["A non-modal overlay — use a positioned Box.", "The whole modal — compose this inside a Dialog."],
  },

  // ── typography ──
  Text: {
    tags: ["typography"], wraps: "span",
    whenUse: ["Any text — sized by rung, semantically toned, mono or not.", "Labels, values, and body copy."],
    whenNot: ["A raw string in a slot that already styles its text.", "An interactive label — pair it with a control."],
  },

  // ── controls ──
  IconButton: {
    tags: ["control"],
    whenUse: ["A compact glyph-only action (close, more, expand).", "A dense toolbar where a text label won't fit."],
    whenNot: ["A labelled action — use Button.", "A persistent on/off state — use Toggle."],
  },
  Checkbox: {
    tags: ["control", "form"],
    whenUse: ["A single boolean in a form or list row.", "Multi-select where each item is independently on/off."],
    whenNot: ["A prominent on/off switch — use Toggle.", "Mutually-exclusive options — use SegmentedControl."],
  },
  Toggle: {
    tags: ["control", "form"],
    whenUse: ["An immediate on/off switch (a setting that applies at once).", "A prominent binary state."],
    whenNot: ["A form value submitted later — use Checkbox.", "More than two states — use SegmentedControl."],
  },
  SelectField: {
    tags: ["control", "form"], wraps: "select",
    whenUse: ["Choosing one option from a longer fixed list (>4).", "A labelled dropdown inside a form."],
    whenNot: ["2–4 options — use SegmentedControl.", "Free text — use TextField."],
  },
  BackButton: {
    tags: ["control", "nav"],
    whenUse: ["Returning to the previous view within a screen.", "A detail → list back affordance."],
    whenNot: ["App-level navigation — use the Rail.", "A generic action — use Button."],
  },
  ColorSwatch: {
    tags: ["control"],
    whenUse: ["Picking or displaying a color / token value.", "A keyed color in a legend or settings row."],
    whenNot: ["A live status color — use StatusDot.", "A category label — use Chip."],
  },
  ConfirmButton: {
    tags: ["control"], composes: ["Button"],
    whenUse: ["A destructive action that needs an in-place two-step confirm.", "Delete / reset where a Dialog is too heavy."],
    whenNot: ["A safe, single-step action — use Button.", "A blocking decision with context — use Dialog."],
  },

  // ── data ──
  StatTile: {
    tags: ["data", "metric"],
    whenUse: ["A single key / value metric with an optional sub-line.", "A compact KPI in a row of stats."],
    whenNot: ["A trend over time — use a chart.", "A large headline number — use Text."],
  },
  FillBar: {
    tags: ["data", "metric"],
    whenUse: ["A horizontal progress / proportion bar (0–1 fraction).", "A budget or usage meter."],
    whenNot: ["A precise value — pair it with a label.", "A time series — use a chart."],
  },
  Code: {
    tags: ["data"],
    whenUse: ["A read-only, scrollable monospace code / prompt block.", "Showing a command, config, or source snippet."],
    whenNot: ["Editable code — use an editor.", "Inline mono text — use Text mono."],
  },
  Avatar: {
    tags: ["data", "identity"],
    whenUse: ["A person / agent identity glyph or initials.", "A compact author or owner marker in a row."],
    whenNot: ["A live status indicator — use StatusDot.", "A category tag — use Chip."],
  },
  IconBox: {
    tags: ["data"],
    whenUse: ["A framed icon tile — a leading glyph on a surface.", "The icon slot of a card or empty state."],
    whenNot: ["A clickable icon — use IconButton.", "A bare inline glyph — use Text."],
  },
  CardListRow: {
    role: "composite", tags: ["data", "list"], composes: ["Card"],
    whenUse: ["A selectable row in a card-style list.", "A master-list item with a leading glyph + trailing meta."],
    whenNot: ["A dense table row — use DataTableRow.", "A standalone card — use Card."],
  },
  DataTableRow: {
    tags: ["data", "table"],
    whenUse: ["A row in a dense, column-aligned data table.", "Tabular records with fixed columns."],
    whenNot: ["A card-style list — use CardListRow.", "A single metric — use StatTile."],
  },
  StatCard: {
    role: "composite", tags: ["data", "metric"], composes: ["Card", "StatTile"],
    whenUse: ["A framed metric card — label, value, optional trend.", "A dashboard KPI tile."],
    whenNot: ["A bare inline stat — use StatTile.", "A full chart — use a chart primitive."],
  },

  // ── feedback ──
  Banner: {
    tags: ["feedback", "status"],
    whenUse: ["An inline or full-width status message with a tone.", "A dismissible notice above content."],
    whenNot: ["A blocking decision — use Dialog.", "A short inline error — use InlineError."],
  },
  InlineError: {
    tags: ["feedback"],
    whenUse: ["A short static error string on a danger wash.", "A field- or section-level failure note."],
    whenNot: ["A dismissible page notice — use Banner.", "A blocking error — use Dialog."],
  },
  Skeleton: {
    tags: ["feedback", "loading"],
    whenUse: ["A shape-matched loading placeholder while content loads.", "The loading state a content component renders for itself (#2302)."],
    whenNot: ["An empty (no-data) state — use EmptyState.", "An error — use InlineError / Banner."],
  },

  // ── charts (#2305 slice 3 remainder) ──
  Bars: {
    role: "composite", tags: ["chart", "data-viz"],
    whenUse: ["Comparing a value across a small set of categories.", "A discrete, labelled distribution (per-day, per-stream counts)."],
    whenNot: ["A trend over continuous time — use LineArea/Spark.", "Parts of a whole — use Donut."],
  },
  HBars: {
    role: "composite", tags: ["chart", "data-viz"],
    whenUse: ["Ranking categories with long labels (labels read left-to-right).", "A leaderboard or top-N breakdown."],
    whenNot: ["Many categories that scroll — use a table.", "A time series — use LineArea."],
  },
  StackedDayBars: {
    role: "composite", tags: ["chart", "data-viz"],
    whenUse: ["A per-day total split into composition segments (a stacked column per day).", "Daily volume with a status/category breakdown."],
    whenNot: ["A single continuous line — use LineArea.", "One category only — use Bars."],
  },
  Spark: {
    role: "composite", tags: ["chart", "data-viz"],
    whenUse: ["A tiny inline trend beside a metric (no axes).", "A dense row/tile where a full chart won't fit."],
    whenNot: ["A chart the user must read precisely — use LineArea with axes.", "Category comparison — use Bars."],
  },
  LineArea: {
    role: "composite", tags: ["chart", "data-viz"],
    whenUse: ["A trend over continuous time, with the area emphasizing magnitude.", "A single series where the shape matters more than exact points."],
    whenNot: ["Comparing discrete categories — use Bars.", "A tiny inline glyph — use Spark."],
  },
  Donut: {
    role: "composite", tags: ["chart", "data-viz"],
    whenUse: ["Parts of a whole at a glance (a few large segments).", "A single proportion with a centered value."],
    whenNot: ["Many small slices (hard to compare) — use HBars.", "A trend — use LineArea."],
  },
  Legend: {
    role: "composite", tags: ["chart", "data-viz"],
    whenUse: ["Keying a chart's colors to their meaning.", "A compact color↔label index beside a graph."],
    whenNot: ["A clickable filter — use SegmentedControl / Chips.", "Status on one item — use StatusDot."],
  },
  Swimlane: {
    role: "composite", tags: ["chart", "data-viz"],
    whenUse: ["Per-lane activity across a shared horizontal axis (streams over time).", "A timeline where each row is an independent track."],
    whenNot: ["A single aggregate series — use LineArea.", "Category totals — use Bars."],
  },

  // ── layouts (page-skeleton templates, #2197) ──
  MasterDetail: {
    version: "1.0.0", tags: ["layout", "page", "list-detail"], composes: ["Box", "Row", "Stack"],
    variants: ["default", "resizable"],
    whenUse: ["A list/nav rail beside a detail view (Personas · Skills · MCP · GitHub · Security · Settings).", "Any master→detail page where selecting a rail row drives the detail column."],
    whenNot: ["A free pan/zoom graph — use GraphCanvas.", "A two-pane split with no fixed list rail — use SplitView."],
    srcText: 'import { MasterDetail } from "@/shared/ui/layouts/MasterDetail";\n\n<MasterDetail\n  rail={<PersonaList/>}\n  detail={<PersonaEditor/>}\n/>',
  },
  SplitView: {
    version: "1.0.0", tags: ["layout", "page", "split"], composes: ["Box", "Row", "Stack"],
    variants: ["horizontal", "vertical"],
    whenUse: ["A resizable two-pane split (the planner session's terminal + inspector).", "A main content area beside a fixed, draggable side panel."],
    whenNot: ["A fixed-width list rail + detail — use MasterDetail.", "A grid of many equal panes — use PaneGrid."],
    srcText: 'import { SplitView } from "@/shared/ui/layouts/SplitView";\n\n<SplitView\n  primary={<Terminal/>}\n  secondary={<Inspector/>}\n/>',
  },
  GraphCanvas: {
    version: "1.0.0", tags: ["layout", "page", "graph"], composes: ["Box", "Row", "Stack", "IconButton"],
    variants: ["default", "with-rail"],
    whenUse: ["A pan/zoom graph workspace (Streams graph · Org designer · Glance).", "Any node/edge canvas needing viewport wiring + an optional rail/inspector."],
    whenNot: ["A static list or form — use MasterDetail.", "A CSS grid of equal panes — use PaneGrid."],
    srcText: 'import { GraphCanvas, ZoomControls } from "@/shared/ui/layouts/GraphCanvas";\nimport { useGraphViewport } from "@/shared/ui/layouts/useGraphViewport";\n\nconst vp = useGraphViewport(world);\n<GraphCanvas vp={vp} world={world} grid\n  toolbar={<ZoomControls vp={vp}/>}>\n  {edges}{nodes}\n</GraphCanvas>',
  },
  PaneGrid: {
    version: "1.0.0", tags: ["layout", "page", "grid"], composes: ["Box"],
    variants: ["2×2", "1×3"],
    whenUse: ["A CSS grid of N equal panes (the Console tab grid).", "A dashboard of equally-weighted tiles kept alive across tab switches (hidden)."],
    whenNot: ["A single list+detail split — use MasterDetail.", "A pan/zoom graph — use GraphCanvas."],
    srcText: 'import { PaneGrid } from "@/shared/ui/layouts/PaneGrid";\n\n<PaneGrid cols={2} rows={2}>\n  {panes.map((p) => <Pane key={p.id} {...p}/>)}\n</PaneGrid>',
  },
};

/** A manifest prop's type rendered as a short human/TS-ish string for the props table. */
function mapType(p: ManifestProp): string {
  if (p.type === "enum" && p.values) return p.values.map((v) => `"${v}"`).join(" | ");
  switch (p.type) {
    case "node": return "ReactNode";
    case "function": return "(…) => void";
    case "space": return "Space";
    case "fontSize": return "FontSize";
    case "tracks": return "Tracks";
    case "color": return "Color";
    case "style": return "CSSProperties";
    case "array": return "T[]";
    default: return p.type; // string | number | boolean
  }
}

const mapProps = (specs: readonly ManifestProp[]): PropSpec[] =>
  specs.map((p) => ({ name: p.name, type: mapType(p), req: !!p.required, desc: p.description }));

/** Variants: the overlay's set, else the `variant` enum's values (else "default"), plus "loading"
 *  when the component registers a `loading` prop (#2302). */
function deriveVariants(spec: PrimitiveSpec, g: Guidance): string[] {
  let base = g.variants;
  if (!base) {
    const variantProp = spec.props.find((p) => p.name === "variant" && p.type === "enum" && p.values);
    base = variantProp?.values ? [...variantProp.values] : ["default"];
  }
  const hasLoading = spec.props.some((p) => p.name === "loading");
  return hasLoading && !base.includes("loading") ? [...base, "loading"] : base;
}

/** A minimal, generated usage snippet for a component without an authored `srcText`. */
function stubSrc(spec: PrimitiveSpec): string {
  const req = spec.props.filter((p) => p.required && p.name !== "children");
  const attrs = req.map((p) => ` ${p.name}={…}`).join("");
  const hasChildren = spec.props.some((p) => p.name === "children");
  const body = hasChildren ? `<${spec.name}${attrs}>…</${spec.name}>` : `<${spec.name}${attrs} />`;
  return `import { ${spec.name} } from "${spec.importPath}";\n\n${body}`;
}

function toRecord(spec: PrimitiveSpec): ComponentRecord {
  const g = GUIDANCE[spec.name] ?? {};
  return {
    id: spec.name.toLowerCase(),
    name: spec.name,
    kitId: REACT_UI_KIT_ID,
    role: g.role ?? GROUP_ROLE[spec.group],
    version: g.version ?? "1.0.0",
    used: g.used ?? 0,
    tags: g.tags ?? [spec.group],
    variants: deriveVariants(spec, g),
    composes: g.composes ?? [],
    props: mapProps(spec.props),
    whenUse: g.whenUse ?? [],
    whenNot: g.whenNot ?? [],
    src: `${spec.importPath.replace(/^@\//, "")}.tsx`,
    srcText: g.srcText ?? stubSrc(spec),
    builtin: true,
    ...(g.wraps ? { wraps: g.wraps } : {}),
  };
}

/** The `react-ui` kit — the app's own shared-UI primitives. */
export const REACT_UI_KIT: Kit = {
  id: REACT_UI_KIT_ID, name: "react-ui", stack: "React · TypeScript", dot: "var(--info)", builtin: true,
};

/** Every registered primitive as a component record — generated from the manifest, so this is exactly
 *  `UI_KIT` (guarded by `reactUiKit.test.ts`), never a drifting hand-list. */
export const REACT_UI_COMPONENTS: ComponentRecord[] = UI_KIT.map(toRecord);
