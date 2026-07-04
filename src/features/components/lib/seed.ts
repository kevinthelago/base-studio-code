// The typed seed for the Component Library (#2269). The `react-ui` kit is the app's OWN shared-UI
// primitives, GENERATED from the introspection manifest (`reactUiKit.ts`, #2305) so it's complete and
// never drifts. Alongside it, a small `examples` kit holds the non-React / page-level DEMO records
// (formerly the fake `react-ui` rows + the `spring-kotlin`/`tauri-rust` demos) — kept only to show that
// a kit is technology-scoped, not React-only. This is what the library shows until the global
// `bsc component` store lands (then `hydrateComponents` replaces it).
import type { ComponentRecord, Kit, PropSpec } from "./model";
import { REACT_UI_KIT, REACT_UI_COMPONENTS } from "./reactUiKit";

/** The demo kit — deliberately non-React and page-level records, to show a kit is tech-scoped. */
const EXAMPLES_KIT_ID = "examples";
const EXAMPLES_KIT: Kit = { id: EXAMPLES_KIT_ID, name: "examples", stack: "demo · multi-stack", dot: "var(--state-wait)", builtin: true };

export const SEED_KITS: Kit[] = [REACT_UI_KIT, EXAMPLES_KIT];

const p = (name: string, type: string, req: boolean, desc: string): PropSpec => ({ name, type, req, desc });

/** The demo records — NOT the app's real components; they populate the `examples` kit only. */
const EXAMPLES_RAW: Omit<ComponentRecord, "id">[] = [
  {
    name: "PersonasPanel", kitId: EXAMPLES_KIT_ID, role: "page", version: "0.7.0", used: 3, tags: ["screen", "library"],
    variants: ["default"], composes: ["Card", "Chip", "Button", "TextField", "SegmentedControl"], src: "features/personas/PersonasPanel.tsx",
    props: [],
    whenUse: ["The full CRUD surface for the persona library.", "Mounted as a planner-workspace tab or pane."],
    whenNot: ["Picking a persona inline — use a compact dropdown.", "Read-only display — pass a lighter view."],
    srcText: "export function PersonasPanel() {\n  const personas = useAppStore((s) => s.personas);\n  const [id, setId] = useState(personas[0]?.id);\n  // list rail + editor — reads/writes the GLOBAL store via the bsc bridge\n  return <Row><List .../><Editor .../></Row>;\n}",
  },
  {
    name: "PersonaService", kitId: EXAMPLES_KIT_ID, role: "service", version: "1.1.0", used: 12, tags: ["store", "bridge", "kotlin"],
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
    name: "BscBridge", kitId: EXAMPLES_KIT_ID, role: "service", version: "2.0.0", used: 51, tags: ["cli", "bridge", "kotlin"],
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
    name: "CommandRouter", kitId: EXAMPLES_KIT_ID, role: "service", version: "1.4.0", used: 33, tags: ["ipc", "rust"],
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
    name: "FsWatcher", kitId: EXAMPLES_KIT_ID, role: "service", version: "0.6.0", used: 8, tags: ["fs", "events", "rust"],
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

const EXAMPLES_COMPONENTS: ComponentRecord[] = EXAMPLES_RAW.map((c) => ({ ...c, id: c.name.toLowerCase(), builtin: true }));

/** The packaged built-in components: the generated `react-ui` kit + the `examples` demo kit. */
export const SEED_COMPONENTS: ComponentRecord[] = [...REACT_UI_COMPONENTS, ...EXAMPLES_COMPONENTS];

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
