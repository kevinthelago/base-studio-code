/* =====================================================================
   sections.jsx — Source pane section cards + shared primitives.
   Each card is parameterized by the current `state`.
   ===================================================================== */
const { useState } = React;

/* ---------- shared primitives ---------- */
function tintBg(h, a) { return h == null ? "var(--bg-elev2)" : `color-mix(in oklch, oklch(0.74 0.12 ${h}), transparent ${a}%)`; }
function fg(h) { return h == null ? "var(--fg-muted)" : `oklch(0.78 0.12 ${h})`; }

function TypeChip({ t, ref }) {
  const m = window.FT[t] || window.FT.string;
  return (
    <span className="ft-chip" style={{ background: tintBg(m.h, 86), color: fg(m.h), borderColor: m.h == null ? "var(--border-soft)" : `color-mix(in oklch, oklch(0.74 0.12 ${m.h}), transparent 72%)` }}>
      {m.glyph && <span className="ft-glyph">{m.glyph}</span>}{ref ? `ref → ${ref}` : m.label}
    </span>
  );
}
function WhyChip({ children, src }) {
  return <span className="why-chip" title={src ? `from ${src}` : undefined}><span className="why-spark">✦</span>{children}</span>;
}
function ReadOnly() {
  return <span className="ro-badge" title="base-studio-code never writes back to the source"><span className="ro-dot" />READ-ONLY</span>;
}
function PopBar({ pct, drop }) {
  const c = drop ? "var(--danger)" : pct >= 80 ? "var(--success)" : pct >= 40 ? "var(--accent)" : "var(--danger)";
  return (
    <span className="pop" title={`${pct}% of records populated`}>
      <span className="pop-track"><i style={{ width: `${pct}%`, background: c }} /></span>
      <span className="pop-n" style={{ color: drop ? "var(--danger)" : "var(--fg-dim)" }}>{pct}%</span>
    </span>
  );
}
function Seg({ value, options, sm }) {
  return (
    <span className={"seg" + (sm ? " sm" : "")}>
      {options.map((o) => <button key={o} className={value === o ? "on" : ""}>{o}</button>)}
    </span>
  );
}
function Card({ label, hint, badge, children, accent }) {
  return (
    <div className="scard" style={accent ? { borderColor: "color-mix(in oklch, var(--accent), transparent 72%)" } : undefined}>
      <div className="scard-head">
        <span className="scard-label">{label}</span>
        {badge}
        <span style={{ flex: 1 }} />
        {hint && <span className="mono-sm">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

/* ===================================================================
   1 · SOURCE CONNECTION
   =================================================================== */
function ConnectionCard({ state }) {
  const multi = state === "multi";
  const connected = ["inferred", "refined", "multi"].includes(state);
  const connecting = state === "connecting";
  const [sel, setSel] = useState("salesforce");

  const statusFor = (id) => {
    if (connecting) return { k: "sampling", c: "var(--accent)", txt: "sampling…" };
    if (connected && (id === "salesforce" || (multi && id === "sql"))) return { k: "connected", c: "var(--success)", txt: "connected" };
    return { k: "idle", c: "var(--fg-dim)", txt: "not connected" };
  };

  return (
    <Card label="source connection" badge={<ReadOnly />} hint={multi ? "2 sources → 1 model" : "read-only connector"}>
      <div className="src-grid">
        {window.SOURCES.map((s) => {
          const on = (s.id === "salesforce" && state !== "empty") || (multi && s.id === "sql") || (state === "empty" && s.id === sel);
          const st = statusFor(s.id);
          return (
            <button key={s.id} className={"src-tile" + (on ? " on" : "")} onClick={() => setSel(s.id)}>
              <span className="src-glyph" style={{ color: `oklch(0.78 0.12 ${s.h})` }}>{s.glyph}</span>
              <span className="src-name">{s.name}</span>
              <span className="src-kind">{s.kind}</span>
              {on && state !== "empty" && (
                <span className="src-status" style={{ color: st.c }}>
                  <span className={"sdot " + (st.k === "connected" ? "on" : st.k === "sampling" ? "run" : "idle")} />{st.txt}
                </span>
              )}
            </button>
          );
        })}
        {connected && <button className="src-add" title="Add another source">＋<span>add source</span></button>}
      </div>

      {state === "empty" && (
        <div className="proposed-banner">
          <span className="pb-spark">✦</span>
          <div className="col" style={{ gap: 2, flex: 1 }}>
            <span className="pb-title">Detected: migrating from Salesforce</span>
            <span className="pb-sub">The pitch mentions an existing CRM. Connect read-only to infer your schema from it.</span>
          </div>
          <button className="btn-accent">Connect read-only →</button>
        </div>
      )}
      {connecting && (
        <div className="conn-live">
          <span className="sdot run" />
          <span className="mono-sm" style={{ color: "var(--accent)" }}>Handshake complete · sampling records — no writes performed</span>
        </div>
      )}
      {connected && (
        <div className="conn-meta">
          <span className="chip"><span className="sdot on" /> Salesforce · prod org</span>
          {multi && <span className="chip"><span className="sdot on" /> SQL · billing export</span>}
          <span style={{ flex: 1 }} />
          <span className="mono-sm">OAuth · scope: <b style={{ color: "var(--success)" }}>read</b></span>
        </div>
      )}
    </Card>
  );
}

/* ===================================================================
   2 · INVENTORY
   =================================================================== */
function InventoryCard() {
  const [open, setOpen] = useState("Account");
  const totalRec = "49,427";
  return (
    <Card label="inventory" hint={`4 objects · ${totalRec} records found`}>
      <div className="col" style={{ gap: 6 }}>
        {window.INVENTORY.map((o) => {
          const isOpen = open === o.obj;
          return (
            <div key={o.obj} className="inv">
              <div className="inv-row" onClick={() => setOpen(isOpen ? null : o.obj)}>
                <span className="inv-caret">{isOpen ? "▼" : "▶"}</span>
                <span className="inv-name">{o.obj}</span>
                {o.custom && <span className="custom-tag">custom</span>}
                <span style={{ flex: 1 }} />
                <span className="mono-sm">{o.fields} fields</span>
                <span className="inv-rec">{o.records}</span>
              </div>
              {isOpen && (
                <div className="inv-detail">
                  <table className="sample">
                    <thead><tr>{o.cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                    <tbody>
                      {o.sample.map((row, i) => (
                        <tr key={i}>{o.cols.map((c) => <td key={c}>{row[c]}</td>)}</tr>
                      ))}
                    </tbody>
                  </table>
                  <span className="mono-sm sample-foot">sampled {o.records} records · {o.fields - o.cols.length} more fields</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/* ===================================================================
   3 · INFERRED DATA MODEL (marquee)
   =================================================================== */
function InferredModelCard({ state, refineMode }) {
  const multi = state === "multi";
  const [open, setOpen] = useState(() => new Set(["Account"]));
  const toggle = (n) => setOpen((s) => { const x = new Set(s); x.has(n) ? x.delete(n) : x.add(n); return x; });
  const m = window.MODEL;
  const totalFields = m.entities.reduce((n, e) => n + e.fields.length, 0);

  return (
    <Card label="inferred data model" accent={!refineMode} hint={`${m.name} · ${m.entities.length} entities · ${totalFields} fields`}
      badge={<span className="why-chip"><span className="why-spark">✦</span>inferred by planner</span>}>
      {!refineMode && (
        <div className="model-note">Every entity & field traces back to real records in the source. Type, identity, and required-ness are <b>derived from the data</b>.</div>
      )}
      <div className="col" style={{ gap: 7 }}>
        {m.entities.map((e) => {
          const isOpen = open.has(e.name);
          return (
            <div key={e.name} className="ent">
              <div className="ent-head" onClick={() => toggle(e.name)}>
                <span className="inv-caret">{isOpen ? "▼" : "▶"}</span>
                <span className="ent-name">{e.name}</span>
                {e.custom && <span className="custom-tag">from custom obj</span>}
                {e.identity && <span className="id-chip" title="identity / merge key">⚷ {e.identity}</span>}
                <span style={{ flex: 1 }} />
                <span className="mono-sm">{e.fields.length} fields · {e.records}</span>
              </div>
              {isOpen && (
                <div className="ent-fields">
                  {e.fields.map((f) => (
                    <div key={f.name} className={"fld" + (f.drop ? " is-drop" : "")}>
                      <span className="fld-name">
                        {f.name}
                        {f.identity && <span className="fld-id" title="identity">⚷</span>}
                        {f.req && <span className="fld-req" title="required">*</span>}
                      </span>
                      <TypeChip t={f.type} ref={f.ref} />
                      {f.type === "enum" && f.values && (
                        <span className="enum-vals">{f.values.map((v) => <span key={v} className="ev">{v}</span>)}</span>
                      )}
                      <span style={{ flex: 1 }} />
                      {multi && (f.name === "name" && e.name === "Account") && <span className="multi-src" title="supplied by both">SF<span className="ms-x">·</span>SQL</span>}
                      <WhyChip src={f.src}>{f.why}</WhyChip>
                      {!refineMode && <PopBar pct={f.pop} drop={f.drop} />}
                      {refineMode && (
                        <span className="fld-actions">
                          {f.drop
                            ? <button className="mini-btn danger">drop</button>
                            : <button className="mini-btn">edit</button>}
                        </span>
                      )}
                    </div>
                  ))}
                  <div className="fld-prov">
                    <span className="mono-sm">provenance ·</span>
                    <span className="mono-sm">{e.records} records sampled from <b>{e.name === "Project" ? "Project__c" : e.name}</b></span>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/* ===================================================================
   4 · REFINE THE SCHEMA
   =================================================================== */
function RefineCard({ state }) {
  const done = state === "refined" || state === "multi";
  return (
    <Card label="refine the schema" hint={done ? "confirmed" : "your pass"}
      badge={<span className="becomes">↓ becomes the schema your new app is built over</span>}>
      <div className="refine-actions">
        <span className="ra"><span className="ra-g">✎</span>rename</span>
        <span className="ra"><span className="ra-g">⇄</span>change type</span>
        <span className="ra"><span className="ra-g">⚷</span>set identity</span>
        <span className="ra"><span className="ra-g">⧉</span>merge entities</span>
        <span className="ra"><span className="ra-g">🗑</span>drop cruft</span>
      </div>

      <div className="drop-callout">
        <span className="dc-icon">⚠</span>
        <div className="col" style={{ gap: 2, flex: 1 }}>
          <span className="dc-title"><span className="mono">Project.legacyCode</span> — 2% populated</span>
          <span className="dc-sub">Dead Salesforce baggage. Drop it so it isn't immortalized in the new system.</span>
        </div>
        {done
          ? <span className="chip" style={{ color: "var(--danger)", borderColor: "color-mix(in oklch,var(--danger),transparent 60%)" }}>dropped ✓</span>
          : <span className="seg sm"><button>keep</button><button className="on danger-on">drop</button></span>}
      </div>

      {done && (
        <div className="refine-log">
          <span className="rl-row"><span className="rl-mark">✓</span>dropped <span className="mono">legacyCode</span>, <span className="mono">Account.fax</span></span>
          <span className="rl-row"><span className="rl-mark">✓</span>renamed <span className="mono">AnnualRevenue → arr</span></span>
          <span className="rl-row"><span className="rl-mark">✓</span>set identity <span className="mono">Account.domain</span>, <span className="mono">Contact.email</span></span>
        </div>
      )}
    </Card>
  );
}

/* ===================================================================
   5 · FIELD MAPPING
   =================================================================== */
function MappingCard({ state }) {
  const multi = state === "multi";
  const M = window.MAPPING;
  return (
    <Card label="field mapping" hint={multi ? "2 sources · precedence SF > SQL" : `${M.mapped.length} mapped · ${M.droppedSource.length} dropped`}
      badge={<span className="why-chip"><span className="why-spark">✦</span>auto-proposed</span>}>
      {multi && (
        <div className="prec-row">
          <span className="mono-sm">precedence on overlap</span>
          <span style={{ flex: 1 }} />
          <span className="seg sm"><button className="on">Salesforce</button><button>&gt;</button><button>SQL</button></span>
        </div>
      )}
      <div className="map-list">
        {M.mapped.map((mp, i) => (
          <div key={i} className="map-row">
            <span className="map-from">{mp.from}</span>
            <span className="map-arrow">→</span>
            <span className="map-to">{mp.to}</span>
            {mp.note && <span className="map-note">{mp.note}</span>}
            {mp.auto && <span className="map-auto">✦</span>}
          </div>
        ))}
      </div>

      <div className="gap-grid">
        <div className="gap-col">
          <div className="gap-label">unmapped source <span className="gap-n">{M.droppedSource.length}</span></div>
          {M.droppedSource.map((d, i) => (
            <div key={i} className="gap-row drop">
              <span className="gap-field">{d.field}</span>
              <span style={{ flex: 1 }} />
              <span className="gap-why">{d.why}</span>
              <span className="chip" style={{ fontSize: 8, color: "var(--danger)", borderColor: "color-mix(in oklch,var(--danger),transparent 62%)" }}>dropped</span>
            </div>
          ))}
        </div>
        <div className="gap-col">
          <div className="gap-label">new-model · no source <span className="gap-n">{M.unmappedModel.length}</span></div>
          {M.unmappedModel.map((d, i) => (
            <div key={i} className="gap-row net">
              <span className="gap-field">{d.field}</span>
              <span style={{ flex: 1 }} />
              <span className="gap-why">{d.why}</span>
              <span className="chip" style={{ fontSize: 8, color: "var(--info)", borderColor: "color-mix(in oklch,var(--info),transparent 62%)" }}>net-new</span>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

/* ===================================================================
   6 · LOAD PREVIEW
   =================================================================== */
function LoadPreviewCard({ state }) {
  const multi = state === "multi";
  const L = multi ? window.LOAD_MULTI : window.LOAD;
  return (
    <Card label="load preview" hint="what the migration stream does at build">
      <div className="load-stat">
        <div className="ls"><span className="ls-v">{L.total}</span><span className="ls-k">rows will load</span></div>
        <div className="ls"><span className="ls-v">{L.entities}</span><span className="ls-k">entities</span></div>
        <div className="ls"><span className="ls-v" style={{ color: "var(--success)" }}>{L.lineage}%</span><span className="ls-k">lineage</span></div>
        <div className="ls"><span className="ls-v" style={{ color: L.validation >= 98 ? "var(--success)" : "var(--accent)" }}>{L.validation}%</span><span className="ls-k">validation</span></div>
        <div className="ls"><span className="ls-v" style={{ color: L.conflicts ? "var(--accent)" : "var(--fg)" }}>{L.conflicts}</span><span className="ls-k">conflict{L.conflicts !== 1 ? "s" : ""}</span></div>
      </div>

      <div className="preview-note">
        <span className="pn-dot" />preview only — runs at build time, not now
      </div>

      <div className="col" style={{ gap: 5, marginTop: 10 }}>
        {L.per.map((p) => (
          <div key={p.entity} className="load-row">
            <span className="load-ent">{p.entity}</span>
            {p.note && <span className="chip" style={{ fontSize: 8, color: "var(--info)", borderColor: "color-mix(in oklch,var(--info),transparent 62%)" }}>{p.note}</span>}
            <span className="load-rows">{p.rows} rows</span>
            <span style={{ flex: 1 }} />
            <span className="src-pips">
              {p.src.map((s) => <span key={s} className="pip" title={window.source(s).name} style={{ color: `oklch(0.78 0.12 ${window.source(s).h})` }}>{window.source(s).glyph}</span>)}
            </span>
            <span className="qual" title="null rate">∅ {p.nulls}%</span>
            <span className="qual" style={{ color: p.valid >= 98 ? "var(--success)" : "var(--accent)" }} title="validation pass">✓ {p.valid}%</span>
          </div>
        ))}
      </div>

      {multi && (
        <div className="recon">
          <span className="mono-sm" style={{ color: "var(--fg-muted)" }}>reconciliation</span>
          <span className="mono-sm">11,902 records merged by identity · <b style={{ color: "var(--accent)" }}>7 conflicts</b> on <span className="mono">Account.name</span> resolved by precedence <b>SF &gt; SQL</b></span>
        </div>
      )}
    </Card>
  );
}

/* ===================================================================
   7 · DOWNSTREAM IMPACT — "what your app will be built from"
   =================================================================== */
function DownstreamCard({ state }) {
  const full = state === "refined" || state === "multi";
  return (
    <Card label="downstream impact" accent hint="before features · structure">
      <div className="ds-statement">
        This model seeds <b className="ds-hl">4 entities / 37 fields</b> that <span className="ds-stage">features</span> and <span className="ds-stage">structure</span> will design over.
      </div>
      <div className="ds-flow">
        <span className="ds-node on">Source</span>
        <span className="ds-arrow">→</span>
        <span className="ds-node">Features</span>
        <span className="ds-arrow">→</span>
        <span className="ds-node">Structure</span>
        <span className="ds-arrow">→</span>
        <span className="ds-node dim">Build</span>
      </div>

      <div className="scard-label" style={{ margin: "14px 0 8px" }}>generated artifacts</div>
      <div className="col" style={{ gap: 6 }}>
        {window.ARTIFACTS.map((a) => (
          <div key={a.name} className="artifact">
            <span className="art-glyph">{a.glyph}</span>
            <div className="col" style={{ gap: 1, flex: 1, minWidth: 0 }}>
              <span className="art-name">{a.name}</span>
              <span className="mono-sm">{a.detail}</span>
            </div>
            <span className={"chip art-kind " + a.kind}>{a.kind}</span>
          </div>
        ))}
      </div>

      <div className="scard-label" style={{ margin: "14px 0 8px" }}>load issues at publish · stream <span className="stream-chip">migration</span></div>
      <div className="col" style={{ gap: 5 }}>
        {window.LOAD_ISSUES.map((iss, i) => (
          <div key={i} className="dep-issue">
            <span className="di-plus">＋</span>
            <span className="di-txt">{iss.t}</span>
            <span style={{ flex: 1 }} />
            <span className="chip" style={{ fontSize: 8 }}>{iss.tag}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

Object.assign(window, {
  S_TypeChip: TypeChip, S_ReadOnly: ReadOnly,
  ConnectionCard, InventoryCard, InferredModelCard, RefineCard,
  MappingCard, LoadPreviewCard, DownstreamCard,
});
