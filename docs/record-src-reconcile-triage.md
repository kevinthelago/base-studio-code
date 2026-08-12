# record-src-reconcile — the records still needing a per-record verdict

Regenerate with `node scripts/reconcile-record-src.cjs`; this file is a snapshot of what that reports
plus the per-record evidence a verdict needs.

**Every by-construction class is already annotated and excluded.** What reaches this file is what none
of them explains, so it is where genuine staleness lives. Two records started here and were MERGED
(`tabstrip`, `collapsiblecard`) — both were rendering an older design or silently ignoring declared
props, and both kept their demo defaults through the merge.

Classes already resolved, for context:
- **preview parameterization** — the record defaults its params so it renders with no props.
- **preview data substitution** — the record swaps live data (`invoke`, `useAppStore`) for samples,
  and ONLY where the render layer still matches (≥60% shared markup).
- **self-declared** — 12 records documented the reason in their own header; it was read, confirmed and
  lifted into `srcDivergence` where the sweep reads it.

**`refresh` never means "copy the file".** Take the file's newer logic, KEEP the record's preview
affordances, and keep the record self-standing — the loader resolves only registered modules and sibling
records, so a helper the file imports relatively must be vendored or imported by a registered path.

Both columns matter. `FILE has, record lacks` is the candidate staleness; `RECORD has, file lacks` is
what a naive refresh would destroy.

## debugsessioncard  (region 0.08)
`src/features/settings/cards/DebugSessionCard.tsx` — record 16 lines / file 27 lines

FILE has, record lacks (16 lines) — the candidate staleness:
  + const { debugSession, setDebugSession, autoSpawnDebugSessions, setAutoSpawnDebugSessions } = useAppStore();
  + <ToggleRow on={debugSession} onToggle={() => setDebugSession(!debugSession)} title="Show the debug session in the base-studio-code graph">
  + Adds the <b>debugger</b> node to the base-studio-code project in the Glance graph — a
  + <b> full-capability Claude session in this app's source tree</b> that works the <code>bsc request</code>{" "}
  + queue (the improvement requests the Design Studio's designer files when it hits a missing{" "}
  + <code>bsc ui</code> capability), reproducing each, fixing it in <code>crates/bsc-ui</code> on a

RECORD has, file lacks (6 lines) — what a naive refresh would DESTROY:
  - const [debugSession, setDebugSession] = useState(false);
  - const [autoSpawnDebugSessions, setAutoSpawnDebugSessions] = useState(false);
  - <ToggleRow on={debugSession} onToggle={() => setDebugSession(!debugSession)} title="Enable debug session">
  - Spins up a local debug session for inspecting live app state.

## logsinventorycard  (region 0.23)
`src/features/settings/cards/LogsInventoryCard.tsx` — record 35 lines / file 59 lines

FILE has, record lacks (24 lines) — the candidate staleness:
  + selectedStream,
  + refreshTrigger = 0,
  + selectedStream: string | null;
  + onViewStream: (stream: string) => void;
  + flash: (msg: string) => void;
  + refreshTrigger?: number;

RECORD has, file lacks (10 lines) — what a naive refresh would DESTROY:
  - selectedStream = null,
  - onViewStream = () => {},
  - flash = () => {},
  - selectedStream?: string | null;

## tablepage  (region 0.26)
`src/shared/ui/pages/TablePage.tsx` — record 66 lines / file 52 lines

FILE has, record lacks (16 lines) — the candidate staleness:
  + title, hint, toolbar,
  + selectedId, defaultSelectedId, onSelect,
  + detail, detailWidth = 320, className,
  + const { selected, select } = usePageSelection(selectedId, defaultSelectedId, onSelect);
  + toolbar={<PageHeader title={title} hint={hint} toolbar={toolbar} meta={`${rows.length}`} />}
  + <Box pad={[12, 16]} style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: "auto" }}>

RECORD has, file lacks (23 lines) — what a naive refresh would DESTROY:
  - title = "Sessions", hint, toolbar,
  - columns = DEMO_COLUMNS, rows = DEMO_ROWS,
  - selectedId, defaultSelectedId = "a", onSelect,
  - detail, detailWidth = 320, className, loading = false,

## issuesecuritycard  (region 0.31)
`src/features/settings/cards/IssueSecurityCard.tsx` — record 16 lines / file 20 lines

FILE has, record lacks (6 lines) — the candidate staleness:
  + const { restrictToBscIssues, setRestrictToBscIssues } = useAppStore();
  + title="Only act on base-studio-code-authored issues"
  + GitHub issues are an untrusted input channel. When on (recommended), triage and any
  + agent that pulls live issues work <b>only</b> issues base-studio-code created (the{" "}
  + <code>bsc-generated</code> label) — a hand-created or injected issue is ignored, so a
  + malicious issue can't drive a worker. Turn off to triage every open issue.

RECORD has, file lacks (3 lines) — what a naive refresh would DESTROY:
  - const [restrictToBscIssues, setRestrictToBscIssues] = useState(true);
  - title="Restrict to base-studio-code issues"
  - Only fetch and act on issues from the base-studio-code repository.

## glancechatdock  (region 0.32)
`src/features/glance/GlanceChatDock.tsx` — record 52 lines / file 85 lines

FILE has, record lacks (34 lines) — the candidate staleness:
  + paneId, name, role, plan, onClose, onEnd,
  + paneId: string;
  + plan?: DockPlan;
  + onClose: () => void;
  + <Text mono size="xs" tone="dim" style={{ flex: "none" }}>· live</Text>
  + {/* Plan sits beside Stream and Logs only when this node HAS a plan — a studio or debug

RECORD has, file lacks (12 lines) — what a naive refresh would DESTROY:
  - paneId = "p1", name = "builder-1", role, onClose = () => {}, onEnd,
  - paneId?: string;
  - onClose?: () => void;
  - <Text mono size="xs" tone="dim" style={{ flex: "none" }}>live</Text>

## collectionpage  (region 0.36)
`src/shared/ui/pages/CollectionPage.tsx` — record 66 lines / file 52 lines

FILE has, record lacks (12 lines) — the candidate staleness:
  + title, hint, toolbar,
  + detail, railWidth = 280, className,
  + const { selected, select } = usePageSelection(selectedId, defaultSelectedId, onSelect);
  + <Text size="md" weight={600}>{it.title}</Text>
  + {it.subtitle != null && <Text size="sm" tone="muted">{it.subtitle}</Text>}
  + toolbar={<PageHeader title={title} hint={hint} toolbar={toolbar} meta={`${items.length}`} />}

RECORD has, file lacks (20 lines) — what a naive refresh would DESTROY:
  - title = "Personas", hint, toolbar,
  - items = DEMO_ITEMS,
  - detail, railWidth = 280, className, loading = false,
  - const controlled = selectedId !== undefined;

## toolpermissionspanel  (region 0.40)
`src/features/settings/cards/ToolPermissionsPanel.tsx` — record 88 lines / file 97 lines

FILE has, record lacks (24 lines) — the candidate staleness:
  + allow, setAllow, deny, setDeny,
  + allowInput, setAllowInput, denyInput, setDenyInput,
  + applyPreset, addToAllow, addToDeny,
  + allow: string[];
  + setAllow: Dispatch<SetStateAction<string[]>>;
  + deny: string[];

RECORD has, file lacks (20 lines) — what a naive refresh would DESTROY:
  - allow: allowProp, setAllow: setAllowProp, deny: denyProp, setDeny: setDenyProp,
  - allowInput: allowInputProp, setAllowInput: setAllowInputProp, denyInput: denyInputProp, setDenyInput: setDenyInputProp,
  - applyPreset: applyPresetProp, addToAllow: addToAllowProp, addToDeny: addToDenyProp,
  - const [localAllow, setLocalAllow] = useState(["Read", "Glob", "Grep"]);

## workspacecard  (region 0.43)
`src/features/settings/cards/WorkspaceCard.tsx` — record 28 lines / file 27 lines

FILE has, record lacks (7 lines) — the candidate staleness:
  + const { bscBaseDir, setBscBaseDir } = useAppStore();
  + async function chooseBaseDir() {
  + const dir = await invoke<string | null>("pick_directory");
  + if (dir) setBscBaseDir(dir);
  + <SettingsTextField
  + trailing={<Button onClick={chooseBaseDir}>Choose…</Button>}

RECORD has, file lacks (5 lines) — what a naive refresh would DESTROY:
  - const [bscBaseDir, setBscBaseDir] = useState("");
  - function chooseBaseDir() {
  - setBscBaseDir("C:\\Users\\dev\\.base-studio-code");
  - trailing={<Button onClick={chooseBaseDir}>Choose...</Button>}

## consolepagecard  (region 0.54)
`src/features/settings/cards/ConsolePageCard.tsx` — record 19 lines / file 18 lines

FILE has, record lacks (3 lines) — the candidate staleness:
  + const { showConsolePage, setShowConsolePage } = useAppStore();
  + The tabbed <b>Console</b> is being retired — <b>Glance</b> is becoming the execution surface,
  + keep running either way — this only controls whether the page is reachable.

RECORD has, file lacks (3 lines) — what a naive refresh would DESTROY:
  - const [showConsolePage, setShowConsolePage] = useState(false);
  - The tabbed <b>Console</b> is being retired {"\u2014"} <b>Glance</b> is becoming the execution surface,
  - keep running either way {"\u2014"} this only controls whether the page is reachable.

## sandboxedconsolescard  (region 0.57)
`src/features/settings/cards/SandboxedConsolesCard.tsx` — record 20 lines / file 19 lines

FILE has, record lacks (3 lines) — the candidate staleness:
  + const { sandboxConsoles, setSandboxConsoles } = useAppStore();
  + distro</b> (no <code>/mnt/c</code>, no Windows interop) instead of on the host — so whatever
  + (Settings → General → Required dependencies). Your Windows repos aren't mounted in yet, so this

RECORD has, file lacks (3 lines) — what a naive refresh would DESTROY:
  - const [sandboxConsoles, setSandboxConsoles] = useState(false);
  - distro</b> (no <code>/mnt/c</code>, no Windows interop) instead of on the host {"\u2014"} so whatever
  - (Settings {"\u2192"} General {"\u2192"} Required dependencies). Your Windows repos aren't mounted in yet, so this

## claudeconfigcard  (region 0.67)
`src/features/settings/cards/ClaudeConfigCard.tsx` — record 175 lines / file 197 lines

FILE has, record lacks (31 lines) — the candidate staleness:
  + projectLocalRepos, bscBaseDir,
  + configProfiles, addConfigProfile, updateConfigProfile, removeConfigProfile,
  + } = useAppStore();
  + const allRepos = useMemo(
  + () => deriveAllRepos(projectLocalRepos, bscBaseDir),
  + [projectLocalRepos, bscBaseDir],

RECORD has, file lacks (22 lines) — what a naive refresh would DESTROY:
  - const allRepos = SAMPLE_REPOS;
  - const [configProfiles, setConfigProfiles] = useState(SAMPLE_PROFILES);
  - const [allow, setAllow]                   = useState([]);
  - const [deny, setDeny]                     = useState([]);

## accessibilitypage  (region 0.67)
`src/features/settings/pages/AccessibilityPage.tsx` — record 12 lines / file 12 lines

FILE has, record lacks (1 lines) — the candidate staleness:
  + description="The app ships a keyboard + screen-reader baseline. On top of that, it can speak the fleet coordination stream aloud so you can drive the 

RECORD has, file lacks (1 lines) — what a naive refresh would DESTROY:
  - description="The app ships a keyboard and screen-reader baseline. On top of that, it can speak the fleet coordination stream aloud so you can drive th