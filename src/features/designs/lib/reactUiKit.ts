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
import type { ComponentRecord, DataShape, Kit, PropSpec, Role } from "./model";

export const REACT_UI_KIT_ID = "react-ui";

/** The packaged kit's GLOBAL-store identity (#2465): the publisher-scoped id + exact semver it is
 *  registered under in the versioned kit store (`~/.base-studio-code/kits/<id>/<version>/`). Stamped
 *  into the generated `react-ui.json` (+ its `react-ui-kit.meta.json` hash sidecar) by
 *  `reactUiKit.gen.test.ts`, embedded by the Rust `bsc ui kit` store as the packaged fallback entry,
 *  and default-pinned onto every newly-authored blueprint (`PACKAGED_UI_KIT_PIN`). A published
 *  `id@version` is immutable — changing the kit's content means bumping this version. */
export const REACT_UI_KIT_STORE_ID = "bsc/react-ui";
export const REACT_UI_KIT_VERSION = "1.0.0";

/** Default architectural role by manifest group (the overlay may override per component). */
const GROUP_ROLE: Record<PrimitiveGroup, Role> = {
  layout: "layout", typography: "primitive", controls: "primitive", data: "primitive", feedback: "primitive",
  layouts: "layout", pages: "page",
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
  /** The data shapes this component is an IDEAL rendering for (#2475) — stamped honestly from an
   *  audit of the real source, never guessed. Absent ⇒ not shape-indexed. In react-ui today `tree`
   *  and `linked-list` are deliberately UNCOVERED — the Tree (#2476) and Sequence (#2477) templates
   *  land separately and get stamped when they do; don't fake coverage with a near-fit. */
  shapes?: DataShape[];
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
    // Composes the (unregistered) Field stack; the in-kit edge is the loading Skeleton (Field.tsx).
    version: "1.2.0", used: 97, tags: ["form", "input"], wraps: "input", composes: ["Skeleton"],
    whenUse: ["Any single-line text input with a label.", "Controlled form fields (value + onChange)."],
    whenNot: ["Multi-line input — use TextArea.", "A boolean — use Toggle / Checkbox."],
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
    role: "composite", version: "1.3.2", used: 121, tags: ["surface"], // #2970: a container with chrome, not a positioner
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
  Slot: {
    tags: ["layout", "structure"],
    whenUse: ["Marking WHERE host-owned React goes inside a spec-authored layout.", "A feature component (hooks / queries / app state) a spec cannot express."],
    whenNot: ["Anything the kit can express — use the real primitive.", "A node-typed prop slot (a Card's header) — nest the node directly."],
  },
  Grid: {
    tags: ["layout"],
    whenUse: ["A 2-D layout with explicit column / row tracks.", "A responsive card or tile grid."],
    whenNot: ["A single row or column — use Row / Stack.", "One-off positioning — use Box."],
  },
  SectionHeader: {
    role: "composite", tags: ["chrome"], // #2970: a titled header row (title + control), not a positioner
    whenUse: ["A titled section heading with an optional trailing control.", "The head of a settings or card group."],
    whenNot: ["A page title — that's screen chrome.", "A bare eyebrow label — use SectionLabel."],
  },
  SectionLabel: {
    role: "primitive", tags: ["chrome"], // #2970: a styled eyebrow label atom, not a positioner
    whenUse: ["A small uppercase eyebrow labelling a group.", "A field-group or list-section caption."],
    whenNot: ["A full heading with actions — use SectionHeader.", "Body copy — use Text."],
  },
  Dialog: {
    role: "composite", tags: ["overlay"], composes: ["ModalScrim", "Card"],
    whenUse: ["A focused, blocking task (confirm or short form).", "Content that must be dismissed before continuing."],
    whenNot: ["Non-blocking info — use a Banner / toast.", "A large multi-step flow — use a page / stage."],
  },
  ModalScrim: {
    role: "composite", tags: ["overlay"], // #2970: an overlay backdrop with chrome, not a positioner
    whenUse: ["The dimmed, click-to-dismiss backdrop behind a modal surface.", "Trapping focus under a Dialog."],
    whenNot: ["A non-modal overlay — use a positioned Box.", "The whole modal — compose this inside a Dialog / ModalCard."],
  },
  ModalCard: {
    role: "composite", tags: ["overlay"], composes: ["ModalScrim", "IconBox", "IconButton"],
    whenUse: ["A rich titled modal — icon + title head, scrollable body, footer action row.", "A multi-section overlay (import/share flows, per-session pickers) that outgrows Dialog."],
    whenNot: ["A short confirm or one-field form — use Dialog.", "Non-blocking info — use a Banner / toast."],
  },

  // ── typography ──
  Text: {
    tags: ["typography"], wraps: "span", composes: ["Skeleton"], // loading renders a Skeleton line (#2302)
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
  TextArea: {
    tags: ["control", "form", "input"], wraps: "textarea", composes: ["Skeleton"], // loading state (Field.tsx)
    whenUse: ["Any multi-line text input with a label (prompts, bodies, notes).", "Controlled form fields (value + onChange) that span lines."],
    whenNot: ["Single-line input — use TextField.", "Read-only code / prompt display — use Code."],
  },
  SelectField: {
    tags: ["control", "form"], wraps: "select",
    whenUse: ["Choosing one option from a longer fixed list (>4).", "A labelled dropdown inside a form."],
    whenNot: ["2–4 options — use SegmentedControl.", "Free text — use TextField."],
  },
  Option: {
    tags: ["control", "form"], wraps: "option",
    whenUse: ["One choice inside a SelectField — the data-authorable <option>.", "A placeholder row in a dropdown (disabled)."],
    whenNot: ["Anywhere outside a SelectField — it is only meaningful as a select's child.", "A standalone choice control — use SegmentedControl or Checkbox."],
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
    tags: ["data"], composes: ["Skeleton"], // loading renders SkeletonText (the Skeleton family)
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
    // shapes: renders ONE homogeneous item of a flat collection (the card-list archetype, #1865).
    role: "composite", tags: ["data", "list"], composes: ["Card"], shapes: ["list"],
    whenUse: ["A selectable row in a card-style list.", "A master-list item with a leading glyph + trailing meta."],
    whenNot: ["A dense table row — use DataTableRow.", "A standalone card — use Card."],
  },
  DataTableRow: {
    // shapes: the columnar-row archetype — with DataTableHeader's shared `template` it renders
    // fixed, aligned columns over homogeneous records: the table rendering.
    tags: ["data", "table"], shapes: ["table"],
    whenUse: ["A row in a dense, column-aligned data table.", "Tabular records with fixed columns."],
    whenNot: ["A card-style list — use CardListRow.", "A single metric — use StatTile."],
  },
  KeyValueList: {
    // shapes: the key-value rendering (#2475) — added because NOTHING else in the kit renders a keyed
    // RECORD read-only: StatTile is a single KPI pair, the Field controls are editable inputs,
    // RoleTierChips is domain-fixed to the four permission axes.
    tags: ["data", "key-value"], composes: ["Skeleton"], shapes: ["key-value"],
    whenUse: ["A read-only label : value property list — a detail summary, config panel, or inspector facts block.", "Rendering one record's named fields in a fixed, aligned two-column grid."],
    whenNot: ["Editable fields — use TextField / SelectField.", "One headline metric — use StatTile.", "Many homogeneous records — use DataTableRow / CardListRow."],
  },
  RoleTierChips: {
    role: "composite", tags: ["data", "status"], composes: ["Chip", "Row"],
    whenUse: ["Showing a session role's permission floor (git · github · code · net) as pills.", "A persona/position clearance row in an editor or inspector."],
    whenNot: ["Arbitrary tags or categories — use Chip.", "A single live status — use StatusDot."],
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
    tags: ["feedback"], composes: ["Box"], // a toned Box wash (InlineError.tsx)
    whenUse: ["A short static error string on a danger wash.", "A field- or section-level failure note."],
    whenNot: ["A dismissible page notice — use Banner.", "A blocking error — use Dialog."],
  },
  PageBoundary: {
    tags: ["feedback", "resilience"],
    composes: ["Box", "Stack", "Text", "Button"], // the fallback is built from kit primitives
    whenUse: [
      "Around a PAGE composition's body, so a throwing child is contained to that page instead of blanking its host.",
      "Anywhere a subtree's failure must not take the surrounding navigation down with it.",
    ],
    whenNot: [
      "As a general try/catch — it only catches errors thrown during a child's RENDER, not in async callbacks.",
      "Around a whole app — an app-level crash screen is a different job, and a page boundary would hide which page failed.",
      "To show an expected empty or error RESULT — use EmptyState / InlineError / Banner; a boundary is for unexpected throws.",
    ],
  },
  Skeleton: {
    tags: ["feedback", "loading"], composes: ["Box"], // a Box with the shimmer atom (Skeleton.tsx)
    whenUse: ["A shape-matched loading placeholder while content loads.", "The loading state a content component renders for itself (#2302)."],
    whenNot: ["An empty (no-data) state — use EmptyState.", "An error — use InlineError / Banner."],
  },

  // ── charts (#2305 slice 3 remainder) ──
  // shapes (#3517): the four charting components claim `series` — an ordered label axis + one or more
  // ALIGNED numeric value series (the { labels, series } shape windowedTally produces). Bars/LineArea/
  // Spark/StackedDayBars all bind exactly that; the ranking/donut/legend charts do not (a ranked list,
  // a parts-of-whole proportion, and a color key are not a time-series).
  Bars: {
    role: "composite", tags: ["chart", "data-viz"], shapes: ["series"],
    whenUse: ["Comparing a value across a small set of categories.", "A discrete, labelled distribution (per-day, per-stream counts)."],
    whenNot: ["A trend over continuous time — use LineArea/Spark.", "Parts of a whole — use Donut."],
  },
  HBars: {
    role: "composite", tags: ["chart", "data-viz"],
    whenUse: ["Ranking categories with long labels (labels read left-to-right).", "A leaderboard or top-N breakdown."],
    whenNot: ["Many categories that scroll — use a table.", "A time series — use LineArea."],
  },
  StackedDayBars: {
    role: "composite", tags: ["chart", "data-viz"], shapes: ["series"],
    whenUse: ["A per-day total split into composition segments (a stacked column per day).", "Daily volume with a status/category breakdown."],
    whenNot: ["A single continuous line — use LineArea.", "One category only — use Bars."],
  },
  Spark: {
    role: "composite", tags: ["chart", "data-viz"], shapes: ["series"],
    whenUse: ["A tiny inline trend beside a metric (no axes).", "A dense row/tile where a full chart won't fit."],
    whenNot: ["A chart the user must read precisely — use LineArea with axes.", "Category comparison — use Bars."],
  },
  LineArea: {
    role: "composite", tags: ["chart", "data-viz"], shapes: ["series"],
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
  // Data-shape audit (#2475): MasterDetail's rail IS a list (select-a-row → detail) and GraphCanvas's
  // world IS a node/edge graph, so they stamp. SplitView (two HETEROGENEOUS panes) and PaneGrid
  // (hosts opaque workspace/pane cells, not data items) are honestly NOT shape-indexed. `tree` and
  // `linked-list` have no ideal in react-ui yet — the Tree (#2476) / Sequence (#2477) templates add them.
  MasterDetail: {
    version: "1.0.0", tags: ["layout", "page", "list-detail"], composes: ["Box", "Row", "Stack"],
    variants: ["default", "resizable"], shapes: ["list"],
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
    variants: ["default", "with-rail"], shapes: ["graph"],
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
  Sequence: {
    version: "1.0.0", tags: ["layout", "page", "linked-list"], composes: ["Box", "Row", "Stack"],
    shapes: ["linked-list"], // the ideal linked-list-shape layout — fills the gap the #2475 shape axis recorded
    variants: ["horizontal", "vertical"],
    whenUse: ["Linked-list-shaped data where the prev→next ORDER is the first-class thing (workflows, pipelines, wizards, timelines).", "A status-tracked stepper or timeline whose focused step drives a detail panel."],
    whenNot: ["An arbitrary node/edge graph — use GraphCanvas.", "An unordered list beside a detail view — use MasterDetail."],
    srcText: 'import { Sequence } from "@/shared/ui/layouts/Sequence";\n\n<Sequence\n  steps={[\n    { id: "plan", label: "Plan", status: "complete" },\n    { id: "build", label: "Build", status: "active" },\n    { id: "ship", label: "Ship" },\n  ]}\n  detail={(step) => <StepEditor step={step}/>}\n/>',
  },
  Tree: {
    version: "1.0.0", tags: ["layout", "page", "tree"], composes: ["MasterDetail", "GraphCanvas", "Box", "Row", "Stack", "Text", "IconButton"],
    shapes: ["tree"], // the ideal tree-shape layout — fills the gap the #2475 shape axis recorded
    variants: ["indented", "layered"],
    whenUse: ["Deep / navigational tree data (file systems, category hierarchies) — variant=\"indented\": collapsible depth-indented rows + a detail panel.", "A presentational top-down hierarchy (org chart, ownership map) — variant=\"layered\" rides the shared graph stack (layerDag + edge grammar + GraphCanvas pan/zoom)."],
    whenNot: ["A flat list beside a detail — use MasterDetail.", "A general (multi-parent / cyclic) graph — use GraphCanvas with layerDag directly."],
    srcText: 'import { Tree } from "@/shared/ui/layouts/Tree";\n\n<Tree\n  nodes={[{ id: "src", label: "src", children: [\n    { id: "app", label: "app" },\n  ] }]}\n  detail={(n) => <NodeDetail node={n}/>}\n  onSelect={setSelected}\n/>',
  },
  // ── #2421 gap-fill ──
  LabelChip: {
    role: "composite", tags: ["badge", "github"], composes: ["Chip"],
    whenUse: ["A GitHub issue/PR label with its dynamic 6-hex color.", "Label rows in issue drawers / project boards."],
    whenNot: ["A semantic status tag — use Chip with a tone.", "A clickable filter — use SegmentedControl."],
  },
  ActivityFeed: {
    // shapes: a striped feed of homogeneous event rows — a flat, ordered list rendering.
    role: "composite", tags: ["data", "feed"], composes: ["Avatar", "EmptyState", "Skeleton"], shapes: ["list"],
    whenUse: ["A \"Recent activity\" card of actor · action · target rows.", "Cross-repo / cross-project event feeds sharing one striped layout."],
    whenNot: ["A dense column-aligned table — use DataTableRow.", "A single event notice — use Banner."],
  },
  Pane: {
    role: "composite", tags: ["overlay", "editor"], composes: ["IconButton"], // #2970: a chrome container, not a positioner
    whenUse: ["A select-an-item → edit-its-fields surface: slide-over drawer or inline master-detail pane.", "Editors needing the standard draft/remove footer."],
    whenNot: ["A blocking decision or short form — use Dialog.", "Static grouped content — use Card."],
  },
  TelemetryPanel: {
    role: "composite", tags: ["chart", "data-viz"],
    whenUse: ["The framed panel around an analytics chart (title · hint · right slot).", "Analytics tabs sharing the telemetry card chrome."],
    whenNot: ["A KPI number — use StatCard.", "General grouped content — use Card."],
  },
  ItemBars: {
    role: "composite", tags: ["chart", "data-viz"], composes: ["FillBar"],
    whenUse: ["A labelled per-item meter list (calls per server, fires per hook).", "Ranked fractions where each row carries a label + value."],
    whenNot: ["An SVG ranked bar chart with a shared axis — use HBars.", "One fraction — use FillBar."],
  },
  SplitBar: {
    role: "composite", tags: ["chart", "data-viz"],
    whenUse: ["A two-way proportion with its counts (ok/err, allow/block).", "Per-item health rows in an analytics panel."],
    whenNot: ["More than two segments — use Donut / Bars.", "A single fill fraction — use FillBar."],
  },

  // ── pages (complete data-driven page compositions, #2505) ──
  // The top of the composition pyramid: each page composes ONLY kit components (layout template +
  // data composites + primitives), so the Design Studio graph shows finished UIs deriving from the
  // base components. Shapes (#2475): a page stamps the shape its WHOLE composition ideally renders —
  // the same shape its central layout template claims, one tier up (the layouts stay the structural
  // ideals; the page is the complete rendering of that shape). DashboardPage stamps NOTHING: it
  // renders a heterogeneous board (metrics + series + slices + events) with no single page shape.
  TablePage: {
    version: "1.0.0", tags: ["page", "table", "records"], shapes: ["table"],
    composes: ["SplitView", "DataTableRow", "KeyValueList", "EmptyState", "SectionHeader", "Box", "Stack", "Text"],
    whenUse: ["A complete records browser: columnar rows from typed columns × rows, with a selected-record inspector.", "Any dataset whose fields align under fixed column labels (runs, issues, sessions)."],
    whenNot: ["Card-styled list items with rich slots — use CollectionPage.", "Just the row primitive inside your own frame — use DataTableRow directly."],
    srcText: 'import { TablePage } from "@/shared/ui/pages/TablePage";\n\n<TablePage\n  title="Sessions" hint="today"\n  columns={[\n    { key: "name", label: "Session" },\n    { key: "state", label: "State", width: "90px" },\n  ]}\n  rows={sessions.map((s) => ({ id: s.id, cells: { name: s.name, state: s.state } }))}\n  onSelect={setSelected}\n/>',
  },
  TreeExplorerPage: {
    version: "1.0.0", tags: ["page", "tree", "explorer"], shapes: ["tree"],
    composes: ["Tree", "KeyValueList", "EmptyState", "SectionHeader", "Box", "Stack", "Text"],
    whenUse: ["A complete hierarchy explorer: collapsible indented rows beside a node-facts detail panel.", "Deep navigational trees (file systems, category hierarchies) that deserve a whole page."],
    whenNot: ["A presentational top-down chart — use Tree variant=\"layered\" (or NetworkPage for general graphs).", "Just the tree rail inside your own frame — use Tree directly."],
    srcText: 'import { TreeExplorerPage } from "@/shared/ui/pages/TreeExplorerPage";\n\n<TreeExplorerPage\n  title="Project files" hint="src/"\n  nodes={[{ id: "src", label: "src", children: [\n    { id: "app", label: "app", meta: "12 files" },\n  ] }]}\n  onSelect={setSelected}\n/>',
  },
  PipelinePage: {
    version: "1.0.0", tags: ["page", "linked-list", "workflow"], shapes: ["linked-list"],
    variants: ["horizontal", "vertical"],
    composes: ["Sequence", "Chip", "KeyValueList", "SectionHeader", "Box", "Row", "Stack", "Text"],
    whenUse: ["A complete pipeline/workflow page: the status-colored step strip driving a focused-step detail (status Chip + description + facts).", "Deploy pipelines, wizards, and timelines where prev→next order is the page's subject."],
    whenNot: ["An arbitrary node/edge graph — use NetworkPage.", "Just the step strip inside your own frame — use Sequence directly."],
    srcText: 'import { PipelinePage } from "@/shared/ui/pages/PipelinePage";\n\n<PipelinePage\n  title="Deploy" hint="release 1.0.5"\n  steps={[\n    { id: "build", label: "Build", status: "complete", facts: [{ k: "took", v: "41s" }] },\n    { id: "test", label: "Test", status: "active", description: "Running the vitest suite." },\n    { id: "ship", label: "Ship" },\n  ]}\n/>',
  },
  NetworkPage: {
    version: "1.0.0", tags: ["page", "graph", "network"], shapes: ["graph"],
    composes: ["GraphCanvas", "IconButton", "KeyValueList", "Box", "Spacer", "Stack", "Text"],
    whenUse: ["A complete graph workspace: pan/zoom node cards + directional edges from typed { nodes, edges }, with a selected-node inspector.", "Dependency / coordination networks laid out by the shared graph stack (cycles tolerated)."],
    whenNot: ["A strict single-parent hierarchy — use TreeExplorerPage (or Tree layered).", "A custom world (bespoke nodes, drag) — use GraphCanvas + the shared graph libs directly."],
    srcText: 'import { NetworkPage } from "@/shared/ui/pages/NetworkPage";\n\n<NetworkPage\n  title="Streams" hint="dependency graph"\n  nodes={[{ id: "api", label: "api" }, { id: "ui", label: "ui", meta: "3 issues" }]}\n  edges={[{ from: "api", to: "ui" }]}\n  onSelect={setSelected}\n/>',
  },
  DashboardPage: {
    // shapes: deliberately ABSENT — a dashboard is a heterogeneous BOARD (KPI tiles + a time series
    // + composition slices + an event feed); no single #2475 shape is "the page's shape", and the
    // feed region's `list` is the ActivityFeed's claim, not the page's. Stamping one would fake an ideal.
    version: "1.0.0", tags: ["page", "dashboard", "analytics"],
    composes: ["StatCard", "Spark", "LineArea", "Donut", "Legend", "ActivityFeed", "Card", "Grid", "Row", "Stack", "Box", "SectionHeader"],
    whenUse: ["A complete metrics board: KPI stat tiles (inline Spark trends), a LineArea trend card, a Donut breakdown card, and an activity column.", "Project / fleet health overviews rendered entirely from typed stats + series + slices + events."],
    whenNot: ["One metric or one chart — use StatCard / a chart primitive in a Card.", "Records the user drills into — use TablePage or CollectionPage."],
    srcText: 'import { DashboardPage } from "@/shared/ui/pages/DashboardPage";\n\n<DashboardPage\n  title="Fleet" hint="last 7 days"\n  stats={[{ k: "landed", v: 12, tone: "success", trend: [3, 5, 4, 8, 12] }]}\n  trend={{ title: "Throughput", labels: days, series: [{ name: "landed", color: "var(--success)", data }] }}\n  breakdown={{ title: "By state", slices: [{ name: "landed", value: 12, color: "var(--success)" }] }}\n  activity={{ hint: "all repos", items, tone: EVENT_TONE }}\n/>',
  },
  CollectionPage: {
    version: "1.0.0", tags: ["page", "list", "master-detail"], shapes: ["list"],
    composes: ["MasterDetail", "CardListRow", "Chip", "KeyValueList", "EmptyState", "SectionHeader", "Box", "Stack", "Text"],
    whenUse: ["A complete master→detail collection page: CardListRow items (badge Chip, subtitle, trailing meta) beside an item-facts detail.", "Libraries and registries (personas, skills, servers) whose items carry rich row slots."],
    whenNot: ["Field-aligned columnar records — use TablePage.", "Just the list rail inside your own frame — use MasterDetail + CardListRow directly."],
    srcText: 'import { CollectionPage } from "@/shared/ui/pages/CollectionPage";\n\n<CollectionPage\n  title="Personas" hint="library"\n  items={personas.map((p) => ({\n    id: p.id, title: p.name, subtitle: p.summary,\n    badge: p.role, facts: [{ k: "model", v: p.model }],\n  }))}\n  onSelect={setSelected}\n/>',
  },
  RecordPage: {
    // #2508 — the key-value shape's page, completing the page-per-shape set. Like DashboardPage it
    // has no single layout template edge: the KeyValueList composite (the key-value archetype, one
    // tier down) is the composition's centre; SectionLabel groups it, the header rides SectionHeader.
    version: "1.0.0", tags: ["page", "key-value", "record"], shapes: ["key-value"],
    composes: ["KeyValueList", "Chip", "EmptyState", "SectionHeader", "SectionLabel", "Box", "Row", "Stack"],
    whenUse: ["A complete record-detail page for ONE keyed record: an identity header (status Chip, subtitle, actions) over grouped label : value sections.", "Config/property inspectors, session or entity detail views whose subject is a single record's fields."],
    whenNot: ["Many records the user picks from — use CollectionPage (or TablePage for columnar fields).", "Just the property list inside your own frame — use KeyValueList directly."],
    srcText: 'import { RecordPage } from "@/shared/ui/pages/RecordPage";\n\n<RecordPage\n  title="api-builder" subtitle="stream api"\n  status="running" statusTone="success"\n  actions={<Button size="sm">Edit</Button>}\n  sections={[\n    { label: "Session", entries: [{ k: "model", v: "opus" }, { k: "role", v: "worker" }] },\n    { label: "Worktree", entries: [{ k: "branch", v: "2409-name-derived-key" }] },\n  ]}\n/>',
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
    ...(g.shapes ? { shapes: g.shapes } : {}),
    // Motion BINDING (#2942/#3451) — the manifest spec already carries NAME references; the defs
    // themselves are owned by the `base` kit (`shared/ui/kit/baseAnimations.ts`) and resolved from
    // there. Only emitted when present so animation-free records stay byte-identical.
    ...(spec.animations?.length ? { animations: [...spec.animations] } : {}),
  };
}

/** The `react-ui` kit — the app's own shared-UI primitives. `tech`/`style` are the #2487 rail
 *  hierarchy axes: react technology, and "studio" — the app's neutral house visual language (the
 *  structural component set; palettes/themes are a separate axis and never name a style).
 *
 *  Its motion library is deliberately EMPTY (#3451): the base motions its primitives play
 *  (`lift`/`fade-in`/`pulse`) are owned by the `base` kit (`shared/ui/kit/baseAnimations.ts`) and
 *  resolved from there by name, so ONE definition serves every consuming kit and a base-motion edit
 *  propagates to all of them. react-ui REFERENCES that shared motion; it no longer owns it. (A kit
 *  may still author its OWN motion here — the resolver prefers a kit's own def over the base one.) */
export const REACT_UI_KIT: Kit = {
  id: REACT_UI_KIT_ID, name: "react-ui", tech: "react", style: "studio", stack: "React · TypeScript",
  dot: "var(--info)", builtin: true, animations: [],
};

/** Every registered primitive as a component record — generated from the manifest, so this is exactly
 *  `UI_KIT` (guarded by `reactUiKit.test.ts`), never a drifting hand-list. */
export const REACT_UI_COMPONENTS: ComponentRecord[] = UI_KIT.map(toRecord);
