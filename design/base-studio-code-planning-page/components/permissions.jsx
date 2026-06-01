// permissions.jsx — Section 2: Agent permissions (3 varieties)
// PermissionsA (preset modes), PermissionsB (granular + risk), PermissionsC (allow/ask/deny matrix)

const CAPS = [
  { k: 'read', label: 'Read files',       desc: 'View any file in the project',    icon: 'eye',      risk: 'low'  },
  { k: 'edit', label: 'Edit files',        desc: 'Modify existing files',           icon: 'pencil',   risk: 'med'  },
  { k: 'make', label: 'Create & delete',   desc: 'Add or remove files',             icon: 'file',     risk: 'med'  },
  { k: 'cmd',  label: 'Run commands',      desc: 'Execute shell in the sandbox',    icon: 'terminal', risk: 'high' },
  { k: 'net',  label: 'Network access',    desc: 'Fetch from external URLs',        icon: 'globe',    risk: 'high' },
  { k: 'git',  label: 'Commit & push',     desc: 'Write to the connected repo',     icon: 'branch',   risk: 'high' },
  { k: 'pkg',  label: 'Install packages',  desc: 'Add project dependencies',        icon: 'package',  risk: 'high' },
];

const RISK = {
  low:  { c: 'var(--blue)',  s: 'var(--blue-soft)',  label: 'Low'  },
  med:  { c: 'var(--amber)', s: 'var(--amber-soft)', label: 'Med'  },
  high: { c: 'var(--red)',   s: 'var(--red-soft)',   label: 'High' },
};

function StateMark({ state }) {
  if (state === 'allow') return <Icon name="check" size={13} color="var(--green)" stroke={1.9} />;
  if (state === 'ask')   return <span className="dotpill" style={{ background: 'var(--amber)', width: 7, height: 7 }} />;
  return <span style={{ width: 9, height: 1.5, background: 'var(--tx-dim)', borderRadius: 2 }} />;
}

/* ════════════════════════ A · Preset modes ═════════════════════ */
const MODES = [
  { id: 'plan',    name: 'Plan only',         desc: 'Reads & analyzes. Proposes a plan, changes nothing.', icon: 'eye' },
  { id: 'suggest', name: 'Suggest edits',     desc: 'Drafts each edit and waits for your approval.',       icon: 'pencil' },
  { id: 'auto',    name: 'Auto-accept edits', desc: 'Applies edits automatically. Asks before commands.',  icon: 'check' },
  { id: 'full',    name: 'Full access',       desc: 'Edits, runs commands, and pushes without asking.',    icon: 'command' },
];
const MODE_MATRIX = {
  plan:    { read: 'allow', edit: 'deny',  cmd: 'deny',  net: 'deny',  git: 'deny'  },
  suggest: { read: 'allow', edit: 'ask',   cmd: 'ask',   net: 'deny',  git: 'deny'  },
  auto:    { read: 'allow', edit: 'allow', cmd: 'ask',   net: 'ask',   git: 'deny'  },
  full:    { read: 'allow', edit: 'allow', cmd: 'allow', net: 'allow', git: 'allow' },
};
const SUMMARY = [
  { k: 'read', label: 'Read files',   icon: 'eye' },
  { k: 'edit', label: 'Edit files',   icon: 'pencil' },
  { k: 'cmd',  label: 'Run commands', icon: 'terminal' },
  { k: 'net',  label: 'Network',      icon: 'globe' },
  { k: 'git',  label: 'Git push',icon: 'branch' },
];
function PermissionsA() {
  const [mode, setMode] = React.useState('suggest');
  const m = MODE_MATRIX[mode];
  return (
    <div className="pane">
      <SecHead icon="shield" title="Agent Permissions" />
      <div style={{ padding: '2px 12px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {MODES.map((md) => {
          const on = mode === md.id;
          return (
            <button key={md.id} onClick={() => setMode(md.id)} style={{
              textAlign: 'left', cursor: 'pointer', width: '100%', display: 'flex', gap: 11, alignItems: 'flex-start',
              padding: '11px 12px', borderRadius: 'var(--r-md)', transition: '.14s',
              border: `1px solid ${on ? 'var(--accent-line)' : 'var(--border-soft)'}`,
              background: on ? 'var(--accent-soft)' : 'transparent',
            }}>
              <span style={{ width: 26, height: 26, flex: '0 0 auto', borderRadius: 7, display: 'grid', placeItems: 'center',
                background: on ? 'var(--accent)' : 'var(--bg-3)', color: on ? '#1a0f0a' : 'var(--tx-mid)' }}>
                <Icon name={md.icon} size={14} stroke={1.7} />
              </span>
              <span style={{ flex: 1 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--tx-hi)' }}>{md.name}</span>
                  {on && <span style={{ fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 600, letterSpacing: '.05em',
                    color: 'var(--accent)', textTransform: 'uppercase' }}>active</span>}
                </span>
                <span style={{ display: 'block', fontSize: 11.5, color: 'var(--tx-lo)', lineHeight: 1.45, marginTop: 2, textWrap: 'pretty' }}>{md.desc}</span>
              </span>
              <span style={{ width: 15, height: 15, flex: '0 0 auto', marginTop: 1, borderRadius: '50%',
                border: `1.5px solid ${on ? 'var(--accent)' : 'var(--border)'}`, background: on ? 'var(--accent)' : 'transparent',
                display: 'grid', placeItems: 'center' }}>
                {on && <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#1a0f0a' }} />}
              </span>
            </button>
          );
        })}
      </div>
      <div className="foot">
        <div className="divider" />
        <div style={{ padding: '11px 16px 14px' }}>
          <div className="sec-eyebrow" style={{ marginBottom: 9 }}>This mode allows</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {SUMMARY.map((c) => (
              <div key={c.k} style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <Icon name={c.icon} size={13} color="var(--tx-lo)" />
                <span style={{ fontSize: 12, color: m[c.k] === 'deny' ? 'var(--tx-dim)' : 'var(--tx-mid)' }}>{c.label}</span>
                <span className="spacer" style={{ flex: 1 }} />
                <StateMark state={m[c.k]} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════ B · Granular + risk ══════════════════ */
function PermissionsB() {
  const [on, setOn] = React.useState({ read: true, edit: true, make: true, cmd: false, net: false, git: false, pkg: false });
  const enabled = Object.values(on).filter(Boolean).length;
  return (
    <div className="pane">
      <SecHead icon="shield" title="Agent Permissions"
        actions={<span className="fmeta">{enabled}/{CAPS.length} enabled</span>} />
      <div className="divider" />
      <div style={{ padding: '4px 0' }}>
        {CAPS.map((c) => {
          const r = RISK[c.risk];
          return (
            <div className="row" key={c.k} style={{ padding: '10px 16px' }}>
              <span style={{ width: 28, height: 28, flex: '0 0 auto', borderRadius: 7, display: 'grid', placeItems: 'center',
                background: on[c.k] ? 'var(--bg-3)' : 'var(--bg-inset)', color: on[c.k] ? 'var(--tx-hi)' : 'var(--tx-dim)',
                border: '1px solid var(--border-soft)', transition: '.15s' }}>
                <Icon name={c.icon} size={14} />
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--tx-hi)' }}>{c.label}</span>
                  <span className="chip" style={{ color: r.c, background: r.s }}>{r.label}</span>
                </span>
                <span style={{ display: 'block', fontSize: 11, color: 'var(--tx-lo)', marginTop: 1 }}>{c.desc}</span>
              </span>
              <Switch on={on[c.k]} onChange={(v) => setOn({ ...on, [c.k]: v })} />
            </div>
          );
        })}
      </div>
      <div className="foot">
        <div className="divider" />
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '11px 16px' }}>
          <Icon name="lock" size={13} color="var(--tx-lo)" />
          <span style={{ fontSize: 11.5, color: 'var(--tx-lo)', lineHeight: 1.4 }}>High-risk actions always ask once per session.</span>
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════ C · Allow / Ask / Deny ═══════════════ */
const PRESETS = {
  plan:     { read: 'allow', edit: 'deny',  make: 'deny',  cmd: 'deny',  net: 'deny',  git: 'deny',  pkg: 'deny'  },
  balanced: { read: 'allow', edit: 'ask',   make: 'ask',   cmd: 'ask',   net: 'deny',  git: 'ask',   pkg: 'deny'  },
  trusted:  { read: 'allow', edit: 'allow', make: 'allow', cmd: 'allow', net: 'ask',   git: 'allow', pkg: 'ask'   },
};
function PermissionsC() {
  const [preset, setPreset] = React.useState('balanced');
  const [state, setState] = React.useState(PRESETS.balanced);
  const apply = (p) => { setPreset(p); setState(PRESETS[p]); };
  const set = (k, v) => { setState((s) => ({ ...s, [k]: v })); setPreset('custom'); };
  return (
    <div className="pane">
      <SecHead icon="shield" title="Agent Permissions" />
      <div style={{ padding: '0 16px 12px' }}>
        <Seg value={preset}
          options={[{ value: 'plan', label: 'Plan' }, { value: 'balanced', label: 'Balanced' }, { value: 'trusted', label: 'Trusted' }, { value: 'custom', label: 'Custom' }]}
          onChange={(v) => v !== 'custom' && apply(v)} />
      </div>
      <div className="divider" />
      <div style={{ padding: '6px 0' }}>
        {CAPS.map((c) => (
          <div key={c.k} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 16px' }}>
            <Icon name={c.icon} size={14} color="var(--tx-mid)" />
            <span style={{ fontSize: 12.5, color: 'var(--tx-hi)', whiteSpace: 'nowrap' }}>{c.label}</span>
            <span className="spacer" style={{ flex: 1 }} />
            <TriState value={state[c.k]} onChange={(v) => set(c.k, v)} />
          </div>
        ))}
      </div>
    </div>
  );
}

Object.assign(window, { PermissionsA, PermissionsB, PermissionsC });
