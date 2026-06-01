// bs-ui.jsx — shared primitives for the base-studio-code project pane
// Exports to window: Icon, Switch, Seg, TriState, SecHead

const ICONS = {
  chevron:    'M6 4l4 4-4 4',
  folder:     'M2 4.2c0-.6.5-1 1-1h3l1.3 1.4H13c.6 0 1 .4 1 1V12c0 .6-.5 1-1 1H3c-.6 0-1-.5-1-1z',
  file:       'M4 2h5l3 3v9c0 .3-.2.5-.5.5h-7c-.3 0-.5-.2-.5-.5V2.5C4 2.2 4.2 2 4.5 2z M9 2v3h3',
  plus:       'M8 3.5v9 M3.5 8h9',
  search:     'M7.5 12a4.5 4.5 0 100-9 4.5 4.5 0 000 9z M11 11l2.5 2.5',
  branch:     'M5 3.5v9 M11 3.5a1.6 1.6 0 100 3.2 1.6 1.6 0 000-3.2z M5 3.5a1.6 1.6 0 100 3.2 1.6 1.6 0 000-3.2z M5 12.5a1.6 1.6 0 100-3.2 1.6 1.6 0 000 3.2z M11 6.7c0 3-6 1.8-6 5.8',
  github:     'M8 1.6a6.4 6.4 0 00-2 12.5c.3 0 .4-.2.4-.4v-1.3c-1.8.4-2.2-.8-2.2-.8-.3-.7-.7-.9-.7-.9-.6-.4 0-.4 0-.4.6 0 1 .7 1 .7.6 1 1.5.7 1.9.6 0-.4.2-.7.4-.9-1.4-.2-2.9-.7-2.9-3.2 0-.7.3-1.3.7-1.7 0-.2-.3-.9.1-1.8 0 0 .5-.2 1.8.7a6 6 0 013.2 0c1.3-.9 1.8-.7 1.8-.7.4.9.1 1.6.1 1.8.4.4.7 1 .7 1.7 0 2.5-1.5 3-2.9 3.2.2.2.4.6.4 1.2v1.9c0 .2.1.4.4.4A6.4 6.4 0 008 1.6z',
  check:      'M3 8.5l3.2 3L13 5',
  shield:     'M8 1.8l5 1.8v4c0 3.2-2.1 5.4-5 6.6-2.9-1.2-5-3.4-5-6.6v-4z',
  terminal:   'M3.5 4.5l3 3-3 3 M8.5 11h4',
  globe:      'M8 1.8a6.2 6.2 0 100 12.4A6.2 6.2 0 008 1.8z M2 8h12 M8 2c1.8 1.6 2.8 3.8 2.8 6S9.8 12.4 8 14 5.2 10.2 5.2 8 6.2 3.6 8 2z',
  pencil:     'M11.5 2.6l1.9 1.9-7.4 7.4-2.4.5.5-2.4z',
  trash:      'M3.5 4.5h9 M6 4.5V3h4v1.5 M5 4.5l.5 8.5h5l.5-8.5',
  command:    'M5.5 3.5a2 2 0 110 4h5a2 2 0 110-4 2 2 0 01-2 2v3a2 2 0 11-2-2 2 2 0 012 2',
  package:    'M8 1.8L14 5v6l-6 3.2L2 11V5z M2 5l6 3 6-3 M8 8v6.2',
  dot:        'M8 6.5a1.5 1.5 0 100 3 1.5 1.5 0 000-3z',
  eye:        'M1.5 8s2.4-4.2 6.5-4.2S14.5 8 14.5 8s-2.4 4.2-6.5 4.2S1.5 8 1.5 8z M8 9.8A1.8 1.8 0 108 6.2a1.8 1.8 0 000 3.6z',
  refresh:    'M13 4.5a5.5 5.5 0 10.7 5 M13 2v3h-3',
  external:   'M6 3.5H3.5v9h9V10 M9 3.5h3.5V7 M7 9l5.2-5.2',
  star:       'M8 2l1.8 3.8 4.2.5-3.1 2.9.8 4.1L8 11.4 4.3 13.3l.8-4.1L2 6.3l4.2-.5z',
  link:       'M6.5 9.5l3-3 M7 4.8l1-1a2.6 2.6 0 013.7 3.7l-1 1 M9 11.2l-1 1a2.6 2.6 0 01-3.7-3.7l1-1',
  history:    'M8 4v4l2.5 1.5 M8 2.2A5.8 5.8 0 102.4 6.5 M2.2 2.5v3.5h3.5',
  lock:       'M4.5 7V5.2a3.5 3.5 0 017 0V7 M3.6 7h8.8v6.2H3.6z',
  caret:      'M4 6l4 4 4-4',
};

function Icon({ name, size = 14, stroke = 1.5, fill = false, color = 'currentColor', style }) {
  const d = ICONS[name] || '';
  const filled = fill || ['dot', 'star'].includes(name);
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" style={{ flex: '0 0 auto', display: 'block', ...style }}
      fill={filled ? color : 'none'} stroke={filled ? 'none' : color}
      strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

function Switch({ on, onChange }) {
  return <button className="sw" data-on={!!on} onClick={(e) => { e.stopPropagation(); onChange(!on); }} aria-pressed={!!on} />;
}

function Seg({ options, value, onChange }) {
  return (
    <div className="seg">
      {options.map((o) => {
        const v = typeof o === 'string' ? o : o.value;
        const label = typeof o === 'string' ? o : o.label;
        return (
          <button key={v} data-on={value === v} onClick={() => onChange(v)}>{label}</button>
        );
      })}
    </div>
  );
}

// Allow / Ask / Deny tri-state pill
const TRI = [
  { value: 'allow', label: 'Allow', color: 'var(--green)', soft: 'var(--green-soft)' },
  { value: 'ask',   label: 'Ask',   color: 'var(--amber)', soft: 'var(--amber-soft)' },
  { value: 'deny',  label: 'Deny',  color: 'var(--red)',   soft: 'var(--red-soft)' },
];
function TriState({ value, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 2, padding: 2, background: 'var(--bg-inset)', border: '1px solid var(--border-soft)', borderRadius: 7 }}>
      {TRI.map((t) => {
        const on = value === t.value;
        return (
          <button key={t.value} onClick={(e) => { e.stopPropagation(); onChange(t.value); }}
            style={{ border: 'none', cursor: 'pointer', fontFamily: 'var(--sans)', fontSize: 10.5, fontWeight: 600,
              padding: '4px 8px', borderRadius: 5, transition: '.14s', whiteSpace: 'nowrap',
              background: on ? t.soft : 'transparent', color: on ? t.color : 'var(--tx-lo)' }}>
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

function SecHead({ eyebrow, title, count, actions, icon }) {
  return (
    <div className="sec-head">
      {icon && <Icon name={icon} size={15} color="var(--accent)" style={{ marginRight: -2 }} />}
      {eyebrow && <span className="sec-eyebrow">{eyebrow}</span>}
      {title && <span className="sec-title">{title}</span>}
      {count != null && <span className="sec-count tnum">{count}</span>}
      <span className="spacer" />
      {actions}
    </div>
  );
}

Object.assign(window, { Icon, Switch, Seg, TriState, SecHead });
