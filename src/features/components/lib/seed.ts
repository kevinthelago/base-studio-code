// The typed seed for the Component Library (#2269) — ported from the design prototype
// (`design/Component Library Kickoff/Component Library Pane.dc.html`). This is what the library shows
// until the global `bsc component` store lands (then `hydrateComponents` replaces it). The `react-ui`
// kit mirrors this app's real shared primitives; the `spring-kotlin` / `tauri-rust` kits show that a
// kit is technology-scoped, not React-only. Kit dots use app tokens, not the prototype's raw palette.
import type { ComponentRecord, Kit, PropSpec } from "./model";

export const SEED_KITS: Kit[] = [
  { id: "react-ui", name: "react-ui", stack: "React · TypeScript", dot: "var(--info)", builtin: true },
  { id: "spring-kotlin", name: "spring-kotlin", stack: "Spring · Kotlin", dot: "var(--success)", builtin: true },
  { id: "tauri-rust", name: "tauri-rust", stack: "Tauri · Rust", dot: "var(--state-wait)", builtin: true },
];

const p = (name: string, type: string, req: boolean, desc: string): PropSpec => ({ name, type, req, desc });

/** The seed components. `id` is the lowercased name (names are unique). */
const RAW: Omit<ComponentRecord, "id">[] = [
  {
    name: "Button", kitId: "react-ui", role: "primitive", version: "2.3.0", used: 214, tags: ["control", "form"],
    variants: ["primary", "ghost", "danger", "sm"], composes: [], src: "shared/ui/controls/Button.tsx", wraps: "button",
    props: [
      p("variant", '"primary"|"ghost"|"danger"', false, "Visual style. Defaults to secondary."),
      p("size", '"sm"|"md"', false, "Control height."),
      p("disabled", "boolean", false, "Dim + block clicks."),
      p("onClick", "() => void", true, "Click handler."),
      p("children", "ReactNode", true, "Label content."),
    ],
    whenUse: [
      "A single, discrete action the user can take.",
      'Form submit / primary CTA (use variant="primary", one per view).',
      'Inline row actions (use variant="ghost").',
    ],
    whenNot: ["Navigating between views — use a link.", "Toggling a persistent on/off state — use Toggle."],
    srcText: "export function Button({ variant, size, ...rest }: ButtonProps) {\n  return (\n    <button\n      className={cx(\"btn\", variant, size)}\n      {...rest}\n    />\n  );\n}",
  },
  {
    name: "Chip", kitId: "react-ui", role: "primitive", version: "1.4.1", used: 168, tags: ["badge", "status"],
    variants: ["neutral", "accent", "success", "info", "danger"], composes: ["StatusDot"], src: "shared/ui/data/Chip.tsx",
    props: [
      p("tone", "ChipTone", false, "Semantic color. Ignored when color is set."),
      p("color", "string", false, "Explicit color → translucent color-mix pill."),
      p("dot", "boolean", false, "Leading status dot."),
      p("size", '"xs"|"sm"|"md"', false, "Pill size."),
    ],
    whenUse: ["A short, non-interactive status or category label.", "Dynamic colors (GitHub labels) via the color prop."],
    whenNot: ["A clickable filter — use SegmentedControl.", "Long text — chips are single-line."],
    srcText: "export function Chip({ tone = \"neutral\", color, dot, children }: ChipProps) {\n  if (color) return <span style={mix(color)}>{children}</span>;\n  return <span className={`chip tone-${tone}`}>{children}</span>;\n}",
  },
  {
    name: "Field", kitId: "react-ui", role: "primitive", version: "1.2.0", used: 97, tags: ["form", "input"],
    variants: ["default", "error", "disabled"], composes: [], src: "shared/ui/controls/Field.tsx", wraps: "input",
    props: [
      p("label", "ReactNode", true, "Field label above the input."),
      p("value", "string", true, "Controlled value."),
      p("onChange", "(v: string) => void", true, "Change handler (value, not event)."),
      p("error", "string", false, "Error text; red border."),
      p("disabled", "boolean", false, "Non-editable state."),
    ],
    whenUse: ["Any single-line text input with a label.", "Controlled form fields (value + onChange)."],
    whenNot: ["Multi-line input — use a textarea.", "A boolean — use Toggle / Checkbox."],
    srcText: "export function Field({ label, value, onChange, error }: FieldProps) {\n  return (\n    <label className=\"field\">\n      <span>{label}</span>\n      <input className={cx(\"input\", error && \"err\")} value={value}\n        onChange={(e) => onChange(e.target.value)} />\n      {error && <span className=\"hint err\">{error}</span>}\n    </label>\n  );\n}",
  },
  {
    name: "StatusDot", kitId: "react-ui", role: "primitive", version: "1.0.3", used: 142, tags: ["status"],
    variants: ["run", "wait", "idle", "stopped"], composes: [], src: "shared/ui/feedback/StatusDot.tsx",
    props: [
      p("state", '"run"|"wait"|"idle"|"stopped"', false, "Maps to a --state-* token."),
      p("color", "string", false, "Explicit color (overrides state)."),
      p("size", "number", false, "Diameter px (default 6)."),
      p("pulse", "boolean", false, "Animate for a live indicator."),
    ],
    whenUse: ["A tiny live activity indicator beside a label.", "Session / build state in a dense row."],
    whenNot: ["Conveying state by color alone — pair with text.", "A large status graphic — use a Banner."],
    srcText: "export function StatusDot({ state, color, size = 6, pulse }: StatusDotProps) {\n  const bg = color ?? STATE_COLOR[state];\n  return <span style={{ width: size, height: size, background: bg,\n    borderRadius: \"50%\", animation: pulse ? \"pulse 1.4s infinite\" : undefined }} />;\n}",
  },
  {
    name: "SegmentedControl", kitId: "react-ui", role: "composite", version: "1.1.0", used: 63, tags: ["control"],
    variants: ["padded", "joined"], composes: ["Button"], src: "shared/ui/controls/SegmentedControl.tsx",
    props: [
      p("options", "SegOption[]", true, "Each owns its label, on-state, onClick."),
      p("variant", '"padded"|"joined"', false, "Gapped pills vs shared-border bar."),
      p("size", '"sm"|"md"', false, "Button height."),
      p("label", "ReactNode", false, "Leading group label."),
    ],
    whenUse: ["2–4 mutually-exclusive options (mode / scope).", "A multi-toggle where each option holds its own state."],
    whenNot: ["Many options (>5) — use a select.", "A single on/off — use Toggle."],
    srcText: "export function SegmentedControl({ options, variant = \"padded\" }: Props) {\n  return (\n    <div className={`seg-grp ${variant}`}>\n      {options.map((o, i) => (\n        <button key={i} className={cx(\"seg-btn\", o.on && \"on\")}\n          onClick={o.onClick}>{o.label}</button>\n      ))}\n    </div>\n  );\n}",
  },
  {
    name: "Card", kitId: "react-ui", role: "layout", version: "1.3.2", used: 121, tags: ["surface"],
    variants: ["default", "interactive", "tone"], composes: [], src: "shared/ui/data/Card.tsx",
    props: [
      p("title", "ReactNode", false, "Canonical head (h3) above the body."),
      p("tone", "string", false, "Border accent color."),
      p("interactive", "boolean", false, "Hover/press affordance."),
      p("onClick", "(e) => void", false, "Click handler (implies interactive)."),
      p("pad", '"sm"', false, "Compact body density."),
    ],
    whenUse: ["Group related content in a framed surface.", "A selectable item in a list (interactive)."],
    whenNot: ["Full-bleed page sections — cards imply containment.", "A modal — use Dialog."],
    srcText: "export function Card({ title, tone, interactive, children }: CardProps) {\n  return (\n    <div className=\"card\" style={tone ? { borderColor: mix(tone) } : undefined}>\n      {title && <h3>{title}</h3>}\n      {children}\n    </div>\n  );\n}",
  },
  {
    name: "EmptyState", kitId: "react-ui", role: "composite", version: "1.0.5", used: 38, tags: ["feedback"],
    variants: ["solid", "dashed"], composes: ["Button", "Card"], src: "shared/ui/feedback/EmptyState.tsx",
    props: [
      p("icon", "ReactNode", false, "Glyph in the icon box."),
      p("title", "ReactNode", true, "Headline."),
      p("description", "ReactNode", false, "Supporting copy."),
      p("actions", "ReactNode", false, "CTA button(s)."),
      p("variant", '"inline"|"card"', false, "In-page vs standalone panel."),
    ],
    whenUse: ["A list / view with nothing in it yet.", "An onboarding / connect prompt with a CTA."],
    whenNot: ["A transient loading state — use a skeleton.", "An error — use InlineError / Banner."],
    srcText: "export function EmptyState({ icon, title, description, actions }: Props) {\n  return (\n    <div className=\"empty\">\n      {icon && <div className=\"empty-icon\">{icon}</div>}\n      <h2>{title}</h2>\n      {description && <p>{description}</p>}\n      {actions && <div className=\"empty-actions\">{actions}</div>}\n    </div>\n  );\n}",
  },
  {
    name: "Dialog", kitId: "react-ui", role: "composite", version: "1.2.1", used: 44, tags: ["overlay"],
    variants: ["default"], composes: ["Card", "Button"], src: "shared/ui/overlay/Dialog.tsx",
    props: [
      p("open", "boolean", true, "Visibility."),
      p("title", "ReactNode", false, "Header title."),
      p("onClose", "() => void", true, "Dismiss handler (scrim / esc)."),
      p("children", "ReactNode", false, "Body content."),
    ],
    whenUse: ["A focused, blocking task (confirm / short form).", "Content that must be dismissed before continuing."],
    whenNot: ["Non-blocking info — use a Banner / toast.", "A large multi-step flow — use a page/stage."],
    srcText: "export function Dialog({ open, title, onClose, children }: DialogProps) {\n  if (!open) return null;\n  return (\n    <ModalScrim onClose={onClose}>\n      <Card title={title}>{children}</Card>\n    </ModalScrim>\n  );\n}",
  },
  {
    name: "Toolbar", kitId: "react-ui", role: "layout", version: "0.9.0", used: 29, tags: ["layout", "control"],
    variants: ["default"], composes: ["IconButton"], src: "shared/ui/layout/Toolbar.tsx",
    props: [
      p("items", "Action[]", true, "Icon actions, left-to-right."),
      p("align", '"start"|"between"', false, "Distribution."),
      p("title", "ReactNode", false, "Leading title slot."),
    ],
    whenUse: ["A row of compact icon actions above content.", "A pane / editor header strip."],
    whenNot: ["Primary page actions — use full Buttons.", "A navigation bar — use the Rail."],
    srcText: "export function Toolbar({ items, title }: ToolbarProps) {\n  return (\n    <div className=\"toolbar\">\n      {title && <span className=\"toolbar-title\">{title}</span>}\n      {items.map((a) => <IconButton key={a.id} {...a} />)}\n    </div>\n  );\n}",
  },
  {
    name: "PersonasPanel", kitId: "react-ui", role: "page", version: "0.7.0", used: 3, tags: ["screen", "library"],
    variants: ["default"], composes: ["Card", "Chip", "Button", "Field", "SegmentedControl"], src: "features/personas/PersonasPanel.tsx",
    props: [],
    whenUse: ["The full CRUD surface for the persona library.", "Mounted as a planner-workspace tab or pane."],
    whenNot: ["Picking a persona inline — use a compact dropdown.", "Read-only display — pass a lighter view."],
    srcText: "export function PersonasPanel() {\n  const personas = useAppStore((s) => s.personas);\n  const [id, setId] = useState(personas[0]?.id);\n  // list rail + editor — reads/writes the GLOBAL store via the bsc bridge\n  return <Row><List .../><Editor .../></Row>;\n}",
  },
  {
    name: "PersonaService", kitId: "spring-kotlin", role: "service", version: "1.1.0", used: 12, tags: ["store", "bridge"],
    variants: ["default"], composes: [], src: "store/PersonaService.kt",
    props: [
      p("list()", "List<Persona>", true, "All personas from the global store."),
      p("set(p)", "Persona", true, "Upsert; written verbatim (no schema)."),
      p("remove(id)", "Unit", true, "Delete a user persona."),
    ],
    whenUse: ["Reading/writing the shared persona store.", "Behind the `bsc persona` CLI verbs."],
    whenNot: ["Per-project data — services here are global.", "UI state — that belongs in the store slice."],
    srcText: "@Service\nclass PersonaService(private val store: JsonStore) {\n  fun list(): List<Persona> = store.readAll(\"personas\")\n  fun set(p: Persona) = store.write(\"personas/${p.id}\", p)\n  fun remove(id: String) = store.delete(\"personas/$id\")\n}",
  },
  {
    name: "BscBridge", kitId: "spring-kotlin", role: "service", version: "2.0.0", used: 51, tags: ["cli", "bridge"],
    variants: ["default"], composes: [], src: "core/BscBridge.kt",
    props: [
      p("run(argv)", "String", true, "Invoke a `bsc` subcommand, capture stdout."),
      p("write(argv, body)", "Unit", true, "Invoke with a JSON body on stdin."),
      p("projectKey", "String?", false, "null = a global store (personas, components)."),
    ],
    whenUse: ["The single choke-point for every `bsc …` call.", "Global stores (projectKey = null)."],
    whenNot: ["Direct Tauri commands — everything goes via bsc.", "Streaming output — this captures once."],
    srcText: "@Service\nclass BscBridge {\n  fun run(argv: List<String>, projectKey: String? = null): String =\n    exec(listOf(\"bsc\") + keyArgs(projectKey) + argv).stdout\n  fun write(argv: List<String>, body: Any) =\n    exec(listOf(\"bsc\") + argv, stdin = json(body))\n}",
  },
  {
    name: "CommandRouter", kitId: "tauri-rust", role: "service", version: "1.4.0", used: 33, tags: ["ipc"],
    variants: ["default"], composes: [], src: "src-tauri/src/router.rs",
    props: [
      p("register(name, h)", "()", true, "Bind an IPC command to a handler."),
      p("dispatch(msg)", "Result<Value>", true, "Route a frontend invoke to its handler."),
    ],
    whenUse: ["Wiring frontend invoke() calls to Rust handlers.", "One registry for all IPC commands."],
    whenNot: ["Global store access — that goes through bsc.", "Long-running streams — use an event channel."],
    srcText: "pub struct CommandRouter { handlers: HashMap<String, Handler> }\nimpl CommandRouter {\n  pub fn register(&mut self, name: &str, h: Handler) {\n    self.handlers.insert(name.into(), h);\n  }\n}",
  },
  {
    name: "FsWatcher", kitId: "tauri-rust", role: "service", version: "0.6.0", used: 8, tags: ["fs", "events"],
    variants: ["default"], composes: [], src: "src-tauri/src/fs_watcher.rs",
    props: [
      p("watch(path)", "()", true, "Start watching a path recursively."),
      p("on_change", "Fn(Event)", true, "Debounced change callback."),
      p("stop()", "()", false, "Tear down the watcher."),
    ],
    whenUse: ["Reacting to on-disk changes (store / repo).", "Emitting debounced fs events to the frontend."],
    whenNot: ["Polling on an interval — prefer native events.", "One-shot reads — just read the file."],
    srcText: "pub fn watch(path: &Path, on_change: impl Fn(Event)) -> Result<()> {\n  let mut w = notify::recommended_watcher(move |ev| on_change(ev))?;\n  w.watch(path, RecursiveMode::Recursive)?;\n  Ok(())\n}",
  },
];

export const SEED_COMPONENTS: ComponentRecord[] = RAW.map((c) => ({ ...c, id: c.name.toLowerCase(), builtin: true }));

/** Reconcile the store's loaded components with the packaged built-ins: the store wins for records it
 *  has (so a user edit to a built-in is preserved), and any built-in the store LACKS is re-added — the
 *  same seed-and-keep pattern as personas/orgs. `hydrateComponents` re-pushes the re-added built-ins so
 *  the store converges. */
export function reconcileComponents(loaded: ComponentRecord[]): ComponentRecord[] {
  const have = new Set(loaded.map((c) => c.id));
  return [...loaded, ...SEED_COMPONENTS.filter((b) => !have.has(b.id))];
}

/** Reconcile loaded kits with the packaged built-in kits (see {@link reconcileComponents}). */
export function reconcileKits(loaded: Kit[]): Kit[] {
  const have = new Set(loaded.map((k) => k.id));
  return [...loaded, ...SEED_KITS.filter((b) => !have.has(b.id))];
}
