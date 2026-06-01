// github.jsx — Section 3: GitHub structure (3 varieties)
// GithubA (repo + tree), GithubB (status + change badges), GithubC (scoped access)

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
function FileDot({ name }) {
  return <span className="dotpill" style={{ background: EXT_COLOR[extOf(name)] || 'var(--tx-dim)', width: 6, height: 6, marginLeft: 3, marginRight: 1 }} />;
}

const flattenPaths = (node, base) => {
  const p = base ? base + '/' + node.name : node.name;
  let out = [p];
  if (node.children) node.children.forEach((c) => { out = out.concat(flattenPaths(c, p)); });
  return out;
};

// Generic recursive tree. trailing(node,path) renders the right side;
// leading(node,path) optionally renders before the icon (checkbox).
function TreeView({ data, openInit = [], trailing, leading, rowBg }) {
  const [open, setOpen] = React.useState(new Set(openInit));
  const toggle = (p) => setOpen((s) => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n; });

  const Node = ({ node, depth, base }) => {
    const path = base ? base + '/' + node.name : node.name;
    const isOpen = open.has(path);
    const isDir = node.type === 'dir';
    return (
      <>
        <div className="tree-row" onClick={() => isDir && toggle(path)} style={{ paddingLeft: 16 + depth * 16, background: rowBg && rowBg(node, path) }}>
          {Array.from({ length: depth }).map((_, i) => <span key={i} className="guide" style={{ left: 16 + 6 + i * 16 }} />)}
          {leading && leading(node, path)}
          {isDir
            ? <Icon name="caret" size={12} color="var(--tx-lo)" style={{ transform: isOpen ? 'none' : 'rotate(-90deg)', transition: '.15s' }} />
            : <span style={{ width: 12, flex: '0 0 auto' }} />}
          {isDir
            ? <Icon name="folder" size={14} color={isOpen ? 'var(--accent)' : 'var(--tx-mid)'} />
            : <FileDot name={node.name} />}
          <span className={'tw-name' + (isDir ? ' dir' : '')} style={{ fontFamily: isDir ? 'var(--sans)' : 'var(--mono)', fontSize: isDir ? 12.5 : 11.5 }}>{node.name}</span>
          <span className="spacer" style={{ flex: 1 }} />
          {trailing && trailing(node, path)}
        </div>
        {isDir && isOpen && node.children.map((c) => <Node key={c.name} node={c} depth={depth + 1} base={path} />)}
      </>
    );
  };
  return <div style={{ padding: '4px 0' }}>{data.map((n) => <Node key={n.name} node={n} depth={0} base="" />)}</div>;
}

function RepoHeader({ extra }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '13px 16px' }}>
      <span style={{ width: 30, height: 30, flex: '0 0 auto', borderRadius: 8, background: 'var(--bg-3)', border: '1px solid var(--border)', display: 'grid', placeItems: 'center' }}>
        <Icon name="github" size={17} color="var(--tx-hi)" />
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--tx-hi)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          acme<span style={{ color: 'var(--tx-lo)' }}>/</span>base-studio
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 2 }}>
          <Icon name="branch" size={11} color="var(--tx-lo)" />
          <span className="mono" style={{ fontSize: 10.5, color: 'var(--tx-mid)' }}>main</span>
          <span style={{ width: 3, height: 3, borderRadius: '50%', background: 'var(--green)', margin: '0 2px' }} />
          <span className="mono" style={{ fontSize: 10.5, color: 'var(--tx-lo)' }}>synced</span>
        </span>
      </span>
      {extra}
    </div>
  );
}

/* ════════════════════════ A · Repo + tree ══════════════════════ */
function GithubA() {
  return (
    <div className="pane">
      <SecHead icon="github" title="Repository" />
      <div className="divider" />
      <RepoHeader extra={<button className="icon-btn" title="Refresh"><Icon name="refresh" size={14} /></button>} />
      <div className="divider" />
      <TreeView data={REPO_TREE} openInit={['src', 'src/auth']} />
    </div>
  );
}

/* ════════════════════════ B · Status + changes ═════════════════ */
const GITLABEL = { M: 'git-m', A: 'git-a', U: 'git-u', D: 'git-d' };
function GithubB() {
  return (
    <div className="pane">
      <SecHead icon="github" title="Repository"
        actions={<span className="chip neutral"><Icon name="branch" size={11} />main</span>} />
      <div style={{ margin: '2px 12px 10px', padding: '12px', borderRadius: 'var(--r-md)', background: 'var(--bg-inset)', border: '1px solid var(--border-soft)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Icon name="history" size={14} color="var(--tx-mid)" />
          <span style={{ fontSize: 12, color: 'var(--tx-hi)', fontWeight: 500, flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            Add OAuth provider fallback
          </span>
          <span className="fmeta">2h ago</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border-soft)' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span className="dotpill" style={{ background: 'var(--green)' }} />
            <span className="fmeta" style={{ color: 'var(--tx-mid)' }}>3 changed</span>
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span className="mono" style={{ fontSize: 10.5, color: 'var(--green)' }}>↑2</span>
            <span className="mono" style={{ fontSize: 10.5, color: 'var(--tx-lo)' }}>ahead</span>
          </span>
          <span className="spacer" style={{ flex: 1 }} />
          <button className="btn ghost" style={{ padding: '3px 9px', fontSize: 11 }}>Sync</button>
        </div>
      </div>
      <div className="divider" />
      <TreeView data={REPO_TREE} openInit={['src', 'src/auth', 'src/components']}
        trailing={(node) => node.git
          ? <span className={'chip ' + GITLABEL[node.git]}>{node.git}</span>
          : null}
        rowBg={(node) => node.git ? 'rgba(214,168,90,.04)' : undefined} />
    </div>
  );
}

/* ════════════════════════ C · Scoped access ════════════════════ */
function GithubC() {
  const allPaths = React.useMemo(() => REPO_TREE.flatMap((n) => flattenPaths(n, '')), []);
  // start with docs/ excluded
  const [denied, setDenied] = React.useState(new Set(['docs', 'docs/PLAN.md', 'docs/ARCHITECTURE.md', 'README.md']));

  const descendants = (node, path) => flattenPaths(node, path.slice(0, path.lastIndexOf('/') >= 0 ? path.lastIndexOf('/') : 0)).filter((p) => p === path || p.startsWith(path + '/'));
  const subtreePaths = (node, path) => {
    let out = [path];
    if (node.children) node.children.forEach((c) => { out = out.concat(subtreePaths(c, path + '/' + c.name)); });
    return out;
  };
  const toggle = (node, path) => {
    const paths = subtreePaths(node, path);
    setDenied((s) => {
      const n = new Set(s);
      const anyAllowed = paths.some((p) => !n.has(p));
      paths.forEach((p) => anyAllowed ? n.add(p) : n.delete(p));
      return n;
    });
  };
  const allowedCount = allPaths.filter((p) => !denied.has(p)).length;

  const Check = (node, path) => {
    const paths = subtreePaths(node, path);
    const allDenied = paths.every((p) => denied.has(p));
    const someDenied = paths.some((p) => denied.has(p));
    const indet = someDenied && !allDenied;
    const checked = !allDenied;
    return (
      <span onClick={(e) => { e.stopPropagation(); toggle(node, path); }} style={{
        width: 15, height: 15, flex: '0 0 auto', borderRadius: 4, cursor: 'pointer', display: 'grid', placeItems: 'center',
        border: `1.5px solid ${checked ? 'var(--accent)' : 'var(--border)'}`,
        background: checked && !indet ? 'var(--accent)' : 'transparent', transition: '.12s' }}>
        {checked && !indet && <Icon name="check" size={10} color="#1a0f0a" stroke={2.2} />}
        {indet && <span style={{ width: 7, height: 2, background: 'var(--accent)', borderRadius: 2 }} />}
      </span>
    );
  };

  return (
    <div className="pane">
      <SecHead icon="github" title="Repository Scope" />
      <div style={{ padding: '0 16px 11px' }}>
        <div style={{ fontSize: 11.5, color: 'var(--tx-lo)', lineHeight: 1.5, textWrap: 'pretty' }}>
          Choose which paths the agent may read and edit. Unchecked paths stay hidden from context.
        </div>
      </div>
      <div className="divider" />
      <TreeView data={REPO_TREE} openInit={['src', 'src/auth']} leading={Check}
        rowBg={(node, path) => denied.has(path) ? undefined : undefined} />
      <div className="foot">
        <div className="divider" />
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '11px 16px' }}>
          <span className="dotpill" style={{ background: 'var(--accent)' }} />
          <span style={{ fontSize: 12, color: 'var(--tx-mid)' }}>
            Agent can access <span className="tnum" style={{ color: 'var(--tx-hi)', fontWeight: 600 }}>{allowedCount}</span> of {allPaths.length} paths
          </span>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { GithubA, GithubB, GithubC });
