// markdown.jsx — Section 1: Project markdown files (3 varieties)
// MarkdownA (dense list), MarkdownB (context cards), MarkdownC (pinned + inline preview)

const MD_FILES = [
  { name: 'CLAUDE.md',           lines: 48,  tok: '1.2k', primary: true,
    blurb: 'Project conventions, tech stack, and house rules the agent must follow.' },
  { name: 'PLAN.md',             lines: 126, tok: '3.0k',
    blurb: 'Active milestone plan — phases, open questions, and acceptance criteria.' },
  { name: 'ARCHITECTURE.md',     lines: 210, tok: '5.1k',
    blurb: 'Service boundaries, data flow, and the auth + billing domain model.' },
  { name: 'README.md',           lines: 73,  tok: '1.6k',
    blurb: 'Getting started, local setup, and the contribution workflow.' },
  { name: 'specs/auth-flow.md',  lines: 64,  tok: '1.5k',
    blurb: 'Magic-link + OAuth sequence, session lifetime, and edge cases.' },
  { name: 'notes/decisions.md',  lines: 31,  tok: '0.7k',
    blurb: 'Running log of architecture decisions and the reasoning behind them.' },
];

function FileName({ name, size = 13 }) {
  const i = name.lastIndexOf('/');
  const dir = i >= 0 ? name.slice(0, i + 1) : '';
  const base = i >= 0 ? name.slice(i + 1) : name;
  return <span className="fname" style={{ fontSize: size }}><span className="dim">{dir}</span>{base}</span>;
}

/* ════════════════════════ A · Dense list ════════════════════════ */
function MarkdownA() {
  const [ctx, setCtx] = React.useState({ 'CLAUDE.md': true, 'PLAN.md': true, 'ARCHITECTURE.md': true, 'notes/decisions.md': true });
  const inCount = MD_FILES.filter((f) => ctx[f.name]).length;
  return (
    <div className="pane">
      <SecHead icon="file" title="Project Files" count={MD_FILES.length}
        actions={<button className="icon-btn" title="New file"><Icon name="plus" size={15} /></button>} />
      <div className="divider" />
      <div style={{ padding: '4px 0' }}>
        {MD_FILES.map((f) => (
          <div className="row" key={f.name}>
            <span className="ftype md">MD</span>
            <FileName name={f.name} />
            <span className="spacer" style={{ flex: 1 }} />
            <span className="fmeta">{f.lines} ln</span>
            <Switch on={!!ctx[f.name]} onChange={(v) => setCtx({ ...ctx, [f.name]: v })} />
          </div>
        ))}
      </div>
      <div className="foot">
        <div className="divider" />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '11px 16px' }}>
          <span className="dotpill" style={{ background: 'var(--accent)' }} />
          <span style={{ fontSize: 12, color: 'var(--tx-mid)' }}>
            <span style={{ color: 'var(--tx-hi)', fontWeight: 600 }} className="tnum">{inCount}</span> of {MD_FILES.length} in context
          </span>
          <span className="spacer" style={{ flex: 1 }} />
          <span className="fmeta">~10.4k tokens</span>
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════ B · Context cards ═════════════════════ */
function MarkdownB() {
  const [on, setOn] = React.useState({ 'CLAUDE.md': true, 'PLAN.md': true, 'ARCHITECTURE.md': false, 'README.md': false });
  const show = MD_FILES.slice(0, 4);
  return (
    <div className="pane">
      <SecHead icon="file" title="Project Files" count={MD_FILES.length}
        actions={<button className="btn ghost" style={{ padding: '4px 9px' }}><Icon name="plus" size={13} />New</button>} />
      <div style={{ padding: '2px 12px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {show.map((f) => {
          const active = on[f.name];
          return (
            <div key={f.name} style={{
              border: `1px solid ${active ? 'var(--accent-line)' : 'var(--border-soft)'}`,
              background: active ? 'var(--bg-2)' : 'var(--bg-inset)',
              borderRadius: 'var(--r-md)', padding: '11px 12px', transition: '.15s',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <span className="ftype md">MD</span>
                <FileName name={f.name} />
                <span className="spacer" style={{ flex: 1 }} />
                <Switch on={active} onChange={(v) => setOn({ ...on, [f.name]: v })} />
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--tx-lo)', lineHeight: 1.5, marginTop: 8, textWrap: 'pretty' }}>{f.blurb}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 9 }}>
                <span className="fmeta">{f.lines} lines</span>
                <span className="fmeta">{f.tok} tokens</span>
                <span className="spacer" style={{ flex: 1 }} />
                <span style={{ fontFamily: 'var(--mono)', fontSize: 9.5, fontWeight: 600, letterSpacing: '.04em',
                  color: active ? 'var(--accent)' : 'var(--tx-dim)', textTransform: 'uppercase' }}>
                  {active ? 'In context' : 'Excluded'}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ════════════════════════ C · Pinned + inline preview ═══════════ */
const PREVIEW = {
  'CLAUDE.md': [
    { t: 'h', s: 'Project conventions' },
    { t: 'p', s: 'TypeScript everywhere. Prefer composition over inheritance.' },
    { t: 'li', s: 'Run `pnpm check` before every commit' },
    { t: 'li', s: 'No default exports in shared packages' },
  ],
};
function MarkdownC() {
  const [open, setOpen] = React.useState('CLAUDE.md');
  const pinned = MD_FILES.slice(0, 3);
  const library = MD_FILES.slice(3);
  const Group = ({ label, items, pin }) => (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '9px 16px 5px' }}>
        <span className="sec-eyebrow">{label}</span>
        <span className="sec-count tnum" style={{ fontSize: 10 }}>{items.length}</span>
      </div>
      {items.map((f) => {
        const isOpen = open === f.name;
        return (
          <div key={f.name}>
            <div className="row" onClick={() => setOpen(isOpen ? null : f.name)} style={{ background: isOpen ? 'var(--bg-2)' : undefined }}>
              <Icon name="caret" size={13} color="var(--tx-lo)" style={{ transform: isOpen ? 'none' : 'rotate(-90deg)', transition: '.15s' }} />
              <span className="ftype md">MD</span>
              <FileName name={f.name} size={12.5} />
              <span className="spacer" style={{ flex: 1 }} />
              {pin && <Icon name="star" size={12} color="var(--accent)" />}
              <span className="fmeta">{f.tok}</span>
            </div>
            {isOpen && PREVIEW[f.name] && (
              <div style={{ margin: '2px 16px 10px 42px', padding: '12px 14px', background: 'var(--bg-inset)',
                border: '1px solid var(--border-soft)', borderRadius: 'var(--r-md)' }}>
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
      })}
    </>
  );
  return (
    <div className="pane">
      <SecHead icon="file" title="Project Files" count={MD_FILES.length}
        actions={<button className="icon-btn" title="New file"><Icon name="plus" size={15} /></button>} />
      <div className="divider" />
      <Group label="Pinned to context" items={pinned} pin />
      <div className="divider" style={{ margin: '6px 16px' }} />
      <Group label="Library" items={library} />
    </div>
  );
}

Object.assign(window, { MarkdownA, MarkdownB, MarkdownC });
