// project-pane.jsx — assembled base-studio-code planning page
// Project pane = Files (variety C) + Permissions (variety C) + Repository (variety A)
// Depends on bs-ui.jsx (Icon, Switch, Seg, TriState)

const { useState, useMemo } = React;

/* ─────────────────────────── data ─────────────────────────── */
const MD_FILES = [
  { name: 'CLAUDE.md',          tok: '1.2k' },
  { name: 'PLAN.md',            tok: '3.0k' },
  { name: 'ARCHITECTURE.md',    tok: '5.1k' },
  { name: 'README.md',          tok: '1.6k' },
  { name: 'specs/auth-flow.md', tok: '1.5k' },
  { name: 'notes/decisions.md', tok: '0.7k' },
];
const PREVIEW = {
  'CLAUDE.md': [
    { t: 'h', s: 'Project conventions' },
    { t: 'p', s: 'TypeScript everywhere. Prefer composition over inheritance.' },
    { t: 'li', s: 'Run `pnpm check` before every commit' },
    { t: 'li', s: 'No default exports in shared packages' },
  ],
  'PLAN.md': [
    { t: 'h', s: 'Auth refactor · current milestone' },
    { t: 'li', s: 'Phase 1 — magic-link issuance + verify' },
    { t: 'li', s: 'Phase 2 — OAuth fallback (`github`, `google`)' },
    { t: 'li', s: 'Phase 3 — session migration & cutover' },
  ],
};

const CAPS = [
  { k: 'read', label: 'Read files',      icon: 'eye' },
  { k: 'edit', label: 'Edit files',      icon: 'pencil' },
  { k: 'make', label: 'Create & delete', icon: 'file' },
  { k: 'cmd',  label: 'Run commands',    icon: 'terminal' },
  { k: 'net',  label: 'Network access',  icon: 'globe' },
  { k: 'git',  label: 'Commit & push',   icon: 'branch' },
  { k: 'pkg',  label: 'Install packages',icon: 'package' },
];
const PRESETS = {
  plan:     { read: 'allow', edit: 'deny',  make: 'deny',  cmd: 'deny',  net: 'deny', git: 'deny',  pkg: 'deny' },
  balanced: { read: 'allow', edit: 'ask',   make: 'ask',   cmd: 'ask',   net: 'deny', git: 'ask',   pkg: 'deny' },
  trusted:  { read: 'allow', edit: 'allow', make: 'allow', cmd: 'allow', net: 'ask',  git: 'allow', pkg: 'ask'  },
};

const REPO_TREE = [
  { type: 'dir', name: 'src', children: [
    { type: 'dir', name: 'auth', children: [
      { type: 'file', name: 'session.ts', git: 'M' },
      { type: 'file', name: 'oauth.ts', git: 'A' },
      { type: 'file', name: 'magic-link.ts' },
    ]},
    { type: 'dir', name: 'components', children: [
      { type: 'file', name: 'ProjectPane.tsx', git: 'M' },
      { type: 'file', name: 'FileTree.tsx' },
    ]},
    { type: 'file', name: 'index.ts' },
  ]},
  { type: 'dir', name: 'docs', children: [
    { type: 'file', name: 'PLAN.md' },
    { type: 'file', name: 'ARCHITECTURE.md' },
  ]},
  { type: 'file', name: 'package.json', git: 'M' },
  { type: 'file', name: 'README.md' },
];
const EXT_COLOR = { ts: 'var(--blue)', tsx: 'var(--blue)', js: 'var(--amber)', json: 'var(--amber)', md: 'var(--accent)', css: 'var(--violet)' };
const extOf = (n) => n.slice(n.lastIndexOf('.') + 1);

/* ─────────────────── collapsible section shell ─────────────── */
function Group({ icon, title, count, actions, defaultOpen = true, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="pgroup">
      <div className="pgroup-head" onClick={() => setOpen((o) => !o)}>
        <Icon name="caret" size={13} color="var(--tx-lo)" style={{ transform: open ? 'none' : 'rotate(-90deg)', transition: '.15s' }} />
        <Icon name={icon} size={15} color="var(--accent)" />
        <span className="sec-title">{title}</span>
        {count != null && <span className="sec-count tnum">{count}</span>}
        <span className="spacer" style={{ flex: 1 }} />
        <div onClick={(e) => e.stopPropagation()} style={{ display: 'flex', gap: 2 }}>{actions}</div>
      </div>
      <div style={{ display: open ? 'block' : 'none', paddingBottom: 8 }}>{children}</div>
    </div>
  );
}

/* ───────────────────── 1 · Files (variety C) ───────────────── */
function FileName({ name, size = 12.5 }) {
  const i = name.lastIndexOf('/');
  const dir = i >= 0 ? name.slice(0, i + 1) : '';
  const base = i >= 0 ? name.slice(i + 1) : name;
  return <span className="fname" style={{ fontSize: size }}><span className="dim">{dir}</span>{base}</span>;
}
function FilesSection() {
  const [open, setOpen] = useState('CLAUDE.md');
  const pinned = MD_FILES.slice(0, 3);
  const library = MD_FILES.slice(3);
  const SubHead = ({ label, n }) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '8px 16px 5px' }}>
      <span className="sec-eyebrow">{label}</span>
      <span className="sec-count tnum" style={{ fontSize: 10 }}>{n}</span>
    </div>
  );
  const FileRow = (f, pin) => {
    const isOpen = open === f.name;
    return (
      <div key={f.name}>
        <div className="row" style={{ padding: '7px 16px', background: isOpen ? 'var(--bg-2)' : undefined }} onClick={() => setOpen(isOpen ? null : f.name)}>
          <Icon name="caret" size={13} color="var(--tx-lo)" style={{ transform: isOpen ? 'none' : 'rotate(-90deg)', transition: '.15s' }} />
          <span className="ftype md">MD</span>
          <FileName name={f.name} />
          <span className="spacer" style={{ flex: 1 }} />
          {pin && <Icon name="star" size={12} color="var(--accent)" />}
          <span className="fmeta">{f.tok}</span>
        </div>
        {isOpen && PREVIEW[f.name] && (
          <div style={{ margin: '2px 16px 10px 42px', padding: '12px 14px', background: 'var(--bg-inset)', border: '1px solid var(--border-soft)', borderRadius: 'var(--r-md)' }}>
            {PREVIEW[f.name].map((b, i) => b.t === 'h'
              ? <div key={i} style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--tx-hi)', marginBottom: 6 }}>{b.s}</div>
              : b.t === 'p'
              ? <div key={i} style={{ fontSize: 11.5, color: 'var(--tx-mid)', lineHeight: 1.5, marginBottom: 7 }}>{b.s}</div>
              : <div key={i} style={{ display: 'flex', gap: 8, fontSize: 11.5, color: 'var(--tx-mid)', lineHeight: 1.5, marginBottom: 4 }}>
                  <span style={{ color: 'var(--accent)' }}>•</span>
                  <span dangerouslySetInnerHTML={{ __html: b.s.replace(/`([^`]+)`/g, '<code style="font-family:var(--mono);font-size:10.5px;background:var(--bg-3);padding:1px 4px;border-radius:3px;color:var(--tx-hi)">$1</code>') }} />
                </div>)}
            <button className="btn ghost" style={{ marginTop: 8, padding: '4px 9px', fontSize: 11 }}><Icon name="pencil" size={11} />Edit</button>
          </div>
        )}
      </div>
    );
  };
  return (
    <Group icon="file" title="Project Files" count={MD_FILES.length}
      actions={<button className="icon-btn" title="New file"><Icon name="plus" size={15} /></button>}>
      <SubHead label="Pinned to context" n={pinned.length} />
      {pinned.map((f) => FileRow(f, true))}
      <div className="divider" style={{ margin: '6px 16px' }} />
      <SubHead label="Library" n={library.length} />
      {library.map((f) => FileRow(f, false))}
    </Group>
  );
}

/* ─────────────── 2 · Permissions (variety C) ───────────────── */
function PermissionsSection() {
  const [preset, setPreset] = useState('balanced');
  const [state, setState] = useState(PRESETS.balanced);
  const apply = (p) => { setPreset(p); setState(PRESETS[p]); };
  const set = (k, v) => { setState((s) => ({ ...s, [k]: v })); setPreset('custom'); };
  return (
    <Group icon="shield" title="Agent Permissions">
      <div style={{ padding: '2px 16px 10px' }}>
        <Seg value={preset}
          options={[{ value: 'plan', label: 'Plan' }, { value: 'balanced', label: 'Balanced' }, { value: 'trusted', label: 'Trusted' }, { value: 'custom', label: 'Custom' }]}
          onChange={(v) => v !== 'custom' && apply(v)} />
      </div>
      {CAPS.map((c) => (
        <div key={c.k} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 16px' }}>
          <Icon name={c.icon} size={14} color="var(--tx-mid)" />
          <span style={{ fontSize: 12.5, color: 'var(--tx-hi)', whiteSpace: 'nowrap' }}>{c.label}</span>
          <span className="spacer" style={{ flex: 1 }} />
          <TriState value={state[c.k]} onChange={(v) => set(c.k, v)} />
        </div>
      ))}
    </Group>
  );
}

/* ─────────────────── 3 · Repository (variety A) ────────────── */
function TreeView({ data, openInit = [] }) {
  const [open, setOpen] = useState(new Set(openInit));
  const toggle = (p) => setOpen((s) => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n; });
  const Node = ({ node, depth, base }) => {
    const path = base ? base + '/' + node.name : node.name;
    const isOpen = open.has(path);
    const isDir = node.type === 'dir';
    return (
      <>
        <div className="tree-row" onClick={() => isDir && toggle(path)} style={{ paddingLeft: 16 + depth * 16 }}>
          {Array.from({ length: depth }).map((_, i) => <span key={i} className="guide" style={{ left: 16 + 6 + i * 16 }} />)}
          {isDir
            ? <Icon name="caret" size={12} color="var(--tx-lo)" style={{ transform: isOpen ? 'none' : 'rotate(-90deg)', transition: '.15s' }} />
            : <span style={{ width: 12, flex: '0 0 auto' }} />}
          {isDir
            ? <Icon name="folder" size={14} color={isOpen ? 'var(--accent)' : 'var(--tx-mid)'} />
            : <span className="dotpill" style={{ background: EXT_COLOR[extOf(node.name)] || 'var(--tx-dim)', width: 6, height: 6, marginLeft: 3, marginRight: 1 }} />}
          <span className={'tw-name' + (isDir ? ' dir' : '')} style={{ fontFamily: isDir ? 'var(--sans)' : 'var(--mono)', fontSize: isDir ? 12.5 : 11.5 }}>{node.name}</span>
        </div>
        {isDir && isOpen && node.children.map((c) => <Node key={c.name} node={c} depth={depth + 1} base={path} />)}
      </>
    );
  };
  return <div style={{ padding: '2px 0' }}>{data.map((n) => <Node key={n.name} node={n} depth={0} base="" />)}</div>;
}
function RepositorySection() {
  return (
    <Group icon="github" title="Repository"
      actions={<button className="icon-btn" title="Refresh"><Icon name="refresh" size={14} /></button>}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 16px 12px' }}>
        <span style={{ width: 30, height: 30, flex: '0 0 auto', borderRadius: 8, background: 'var(--bg-3)', border: '1px solid var(--border)', display: 'grid', placeItems: 'center' }}>
          <Icon name="github" size={17} color="var(--tx-hi)" />
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--tx-hi)' }}>acme<span style={{ color: 'var(--tx-lo)' }}>/</span>base-studio</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 2 }}>
            <Icon name="branch" size={11} color="var(--tx-lo)" />
            <span className="mono" style={{ fontSize: 10.5, color: 'var(--tx-mid)' }}>main</span>
            <span style={{ width: 3, height: 3, borderRadius: '50%', background: 'var(--green)', margin: '0 2px' }} />
            <span className="mono" style={{ fontSize: 10.5, color: 'var(--tx-lo)' }}>synced</span>
          </span>
        </span>
      </div>
      <div className="divider" />
      <TreeView data={REPO_TREE} openInit={['src', 'src/auth']} />
    </Group>
  );
}

/* ─────────────────────── the project pane ──────────────────── */
function ProjectPane() {
  return (
    <aside className="project-pane">
      <div className="pp-head">
        <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--tx-hi)' }}>Project</span>
        <span className="spacer" style={{ flex: 1 }} />
        <button className="icon-btn" title="Collapse pane"><Icon name="external" size={14} /></button>
      </div>
      <div className="pp-scroll">
        <FilesSection />
        <div className="divider" style={{ margin: '4px 16px' }} />
        <PermissionsSection />
        <div className="divider" style={{ margin: '4px 16px' }} />
        <RepositorySection />
      </div>
    </aside>
  );
}

/* ─────────────────── framing: Claude session ───────────────── */
function ClaudeSession() {
  const [val, setVal] = useState('');
  return (
    <section className="session">
      <div className="session-head">
        <span style={{ width: 22, height: 22, borderRadius: 6, background: 'var(--accent)', display: 'grid', placeItems: 'center', flex: '0 0 auto' }}>
          <span style={{ width: 9, height: 9, borderRadius: '50%', border: '2px solid #1a0f0a' }} />
        </span>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--tx-hi)' }}>Auth refactor</span>
        <span className="chip neutral" style={{ marginLeft: 2 }}>claude-sonnet</span>
        <span className="spacer" style={{ flex: 1 }} />
        <button className="icon-btn" title="History"><Icon name="history" size={15} /></button>
      </div>

      <div className="msgs">
        <div className="msg">
          <div className="msg-role">You</div>
          <div className="msg-body user">Refactor auth to support magic-link sign-in with an OAuth fallback. Start with a plan before touching any files.</div>
        </div>

        <div className="msg">
          <div className="msg-role claude"><span className="dotpill" style={{ background: 'var(--accent)' }} />Claude</div>
          <div className="msg-body">
            <p>Read <code>ARCHITECTURE.md</code> and the current <code>src/auth</code> module. Here's the plan I'd propose:</p>
            <div className="md-h">Plan</div>
            <ul className="md-ul">
              <li><b>Phase 1</b> — issue + verify magic links (<code>magic-link.ts</code>)</li>
              <li><b>Phase 2</b> — OAuth fallback for <code>github</code> &amp; <code>google</code></li>
              <li><b>Phase 3</b> — migrate sessions, then cut over</li>
            </ul>
            <p>New session helper to anchor phase 1:</p>
            <pre className="code"><span className="c-kw">export function</span> <span className="c-fn">issueMagicLink</span>(<span className="c-var">email</span>: <span className="c-ty">string</span>): <span className="c-ty">Promise</span>&lt;<span className="c-ty">Token</span>&gt;</pre>
            <p>I've scoped this to <code>src/auth</code> only. Ready to start phase 1?</p>
          </div>
        </div>
      </div>

      <div className="composer">
        <div className="composer-box">
          <textarea value={val} onChange={(e) => setVal(e.target.value)} rows={1} placeholder="Reply to Claude…" />
          <div className="composer-foot">
            <span className="chip neutral"><Icon name="shield" size={11} />Balanced</span>
            <span className="chip neutral"><Icon name="branch" size={11} />main</span>
            <span className="spacer" style={{ flex: 1 }} />
            <button className="btn primary" style={{ padding: '6px 12px' }}>Send<Icon name="chevron" size={13} color="#1a0f0a" /></button>
          </div>
        </div>
      </div>
    </section>
  );
}

function App() {
  return (
    <div className="studio">
      <ClaudeSession />
      <ProjectPane />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
