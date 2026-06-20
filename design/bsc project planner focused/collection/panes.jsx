/* =====================================================================
   panes.jsx — the four Data Collection pane bodies + shared primitives.
   Each pane is a function of the current `state`.
   ===================================================================== */
const { useState } = React;

/* ---------- shared primitives ---------- */
function ModeChip({ mode }) {
  const m = window.MODE[mode]; if (!m) return null;
  return (
    <span className="mode-chip" style={{ color: `oklch(0.78 0.11 ${m.h})`,
      background: `color-mix(in oklch, oklch(0.74 0.12 ${m.h}), transparent 88%)`,
      borderColor: `color-mix(in oklch, oklch(0.74 0.12 ${m.h}), transparent 72%)` }}>
      <span className="mc-g">{m.glyph}</span>{m.label}
    </span>
  );
}
function EntityChip({ name }) { return <span className="ent-chip">{name}</span>; }
function Card({ label, hint, badge, accent, children }) {
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
function SourceHead({ s, right }) {
  return (
    <div className="srow-head">
      <ModeChip mode={s.mode} />
      <span className="srow-label">{s.label}</span>
      <span className="srow-loc">{s.loc}</span>
      <span style={{ flex: 1 }} />
      {right}
    </div>
  );
}
function Readiness({ checks, tail }) {
  const ok = checks.filter((c) => c.ok).length;
  return (
    <Card label="readiness" accent hint={ok === checks.length ? "gate met" : `${ok}/${checks.length}`}>
      <div className="col" style={{ gap: 5 }}>
        {checks.map((c) => (
          <div key={c.id} className={"ready-row " + (c.ok ? "ok" : c.block ? "block" : "miss")}>
            <span className="rr-mark">{c.ok ? "✓" : c.block ? "✕" : "○"}</span>
            <span className="rr-label">{c.label}</span>
            <span style={{ flex: 1 }} />
            <span className="mono-sm" style={c.block ? { color: "var(--danger)" } : undefined}>{c.detail}</span>
          </div>
        ))}
      </div>
      {tail && <div className="ready-tail">{tail}</div>}
    </Card>
  );
}
function DataModelStrip({ compact }) {
  const dm = window.DM;
  return (
    <div className="dm-strip">
      <span className="dm-name"><span className="dm-spark">◆</span>{dm.name}</span>
      <span className="dm-arrow">·</span>
      {dm.entities.map((e) => (
        <span key={e.name} className="dm-ent">
          <EntityChip name={e.name} />
          {!compact && <span className="dm-fcount">{e.fields.length}f</span>}
        </span>
      ))}
    </div>
  );
}
const modeCount = (srcs) => {
  const sc = srcs.filter((s) => s.mode === "scrape").length;
  const fe = srcs.filter((s) => s.mode === "fetch").length;
  return `${srcs.length} sources (${sc} scrape · ${fe} fetch)`;
};

/* ===================================================================
   PANE A · TARGETS (collectTargets)
   =================================================================== */
function TargetsPane({ state }) {
  const srcs = window.sourcesFor(state);
  const bound = state === "defined" || state === "multi";
  const empty = state === "empty";

  if (empty) {
    return (
      <>
        <Card label="sources">
          <div className="empty-block">
            <span className="eb-glyph">🎯</span>
            <span className="eb-title">No sources declared yet</span>
            <span className="eb-sub">Declare the external sites, APIs, and datasets this project will collect from.</span>
            <div className="proposed-inline"><span className="why-spark">✦</span>Planner suggests: add the conference site as your first source</div>
            <button className="btn-accent" style={{ marginTop: 4 }}>＋ Add the first source</button>
          </div>
        </Card>
        <Card label="target data model">
          <div className="dm-unbound">No Data Model bound — <span className="link">bind an existing one</span> or <span className="link">create “Talks”</span>.</div>
        </Card>
        <Readiness checks={[
          { id: "src", label: "At least one source declared", ok: false, detail: "0 sources" },
          { id: "dm", label: "Data Model bound", ok: false, detail: "none" },
        ]} />
      </>
    );
  }

  return (
    <>
      <Card label="sources" hint={modeCount(srcs)}>
        <div className="col" style={{ gap: 7 }}>
          {srcs.map((s) => (
            <div key={s.id} className="srow">
              <SourceHead s={s} right={<button className="iconbtn">✕</button>} />
              <div className="srow-meta">
                <span className="chip">{s.type}</span>
                <span className="mono-sm">feeds</span>
                {s.feeds.map((f) => <EntityChip key={f} name={f} />)}
              </div>
            </div>
          ))}
          <button className="add-line">＋ add source</button>
        </div>
      </Card>

      <Card label="scope per source" hint="keep the crawl / fetch bounded">
        <div className="col" style={{ gap: 7 }}>
          {srcs.map((s) => (
            <div key={s.id} className="srow">
              <div className="row" style={{ gap: 7, marginBottom: 7 }}>
                <ModeChip mode={s.mode} />
                <span className="srow-label">{s.label}</span>
                {state === "partial" && s.id === "speakers" && <span className="chip" style={{ fontSize: 8, color: "var(--accent)", borderColor: "var(--accent-dim)" }}>scope incomplete</span>}
              </div>
              <div className="scope-grid">
                <Kv k={s.mode === "scrape" ? "start" : "query"} v={s.scope.start} />
                <Kv k={s.mode === "scrape" ? "pattern" : "paging"} v={s.scope.pattern} />
                <Kv k="cap" v={state === "partial" && s.id === "speakers" ? "—" : s.scope.bound} />
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card label="target data model" badge={bound ? <span className="why-chip" style={{ color: "var(--success)" }}>✓ bound</span> : <span className="why-chip" style={{ color: "var(--accent)" }}>not bound</span>}>
        {bound
          ? <><DataModelStrip /><div className="mono-sm" style={{ marginTop: 9 }}>Collected rows populate these entities. <span className="link">Edit model →</span></div></>
          : <div className="dm-unbound">Sources declared, but no Data Model bound yet — <span className="link">bind “Talks”</span> to continue.</div>}
      </Card>

      <Readiness checks={[
        { id: "src", label: "At least one source declared", ok: true, detail: `${srcs.length} sources` },
        { id: "dm", label: "Data Model bound", ok: bound, detail: bound ? "Talks" : "none" },
      ]} tail={<><b>{modeCount(srcs)}</b> → the <EntityChip name={window.DM.name} /> Data Model.</>} />
    </>
  );
}
function Kv({ k, v }) { return <div className="kv"><span className="kv-k">{k}</span><span className="kv-v">{v}</span></div>; }

/* ===================================================================
   PANE B · SOURCE LEGITIMACY (sourceLicensing)
   =================================================================== */
const CLR = {
  cleared:   { c: "var(--success)", label: "cleared" },
  "needs review": { c: "var(--accent)", label: "needs review" },
  blocked:   { c: "var(--danger)", label: "blocked" },
};
function ClearChip({ status }) {
  const m = CLR[status] || CLR["needs review"];
  return <span className="clr-chip" style={{ color: m.c, background: `color-mix(in oklch, ${m.c}, transparent 88%)`, borderColor: `color-mix(in oklch, ${m.c}, transparent 70%)` }}>
    <span className="clr-dot" style={{ background: m.c }} />{m.label}</span>;
}
function LegitimacyPane({ state }) {
  const srcs = window.sourcesFor(state);
  const empty = state === "empty";
  // status per source by state
  const statusOf = (id) => {
    if (id === "rival") return "blocked";
    if (state === "partial" && id === "speakers") return "needs review";
    return "cleared";
  };

  if (empty) {
    return (
      <>
        <Card label="per-source clearance">
          <div className="empty-block">
            <span className="eb-glyph">⚖</span>
            <span className="eb-title">No sources to clear yet</span>
            <span className="eb-sub">Declare sources in <b>Targets</b> first — every source must be cleared for the intended use before any data is acquired.</span>
          </div>
        </Card>
      </>
    );
  }

  const blocked = srcs.some((s) => statusOf(s.id) === "blocked");
  const review = srcs.some((s) => statusOf(s.id) === "needs review");
  const sessions = window.CLEARANCE.sessions;

  return (
    <>
      {blocked && (
        <div className="hard-block">
          <span className="hb-icon">⛔</span>
          <div className="col" style={{ gap: 2, flex: 1 }}>
            <span className="hb-title">Acquisition blocked</span>
            <span className="hb-sub">Rival agenda — {window.CLEARANCE.rival.reason}. Narrow scope or drop the source.</span>
          </div>
          <button className="btn-ghost sm">Drop source</button>
        </div>
      )}

      <Card label="per-source clearance" hint="cleared before acquire">
        <div className="col" style={{ gap: 7 }}>
          {srcs.map((s) => {
            const st = statusOf(s.id);
            return (
              <div key={s.id} className={"srow" + (st === "blocked" ? " is-block" : st === "needs review" ? " is-review" : "")}>
                <SourceHead s={s} right={<ClearChip status={st} />} />
                {st === "blocked" && <div className="srow-reason">{window.CLEARANCE.rival.reason}</div>}
                {st === "needs review" && <div className="srow-reason" style={{ color: "var(--accent)" }}>license unconfirmed — verify CC-BY attribution terms</div>}
              </div>
            );
          })}
        </div>
      </Card>

      <Card label="robots.txt" hint="confsite.com · crawl-delay 1s">
        <div className="robots">
          <div className="robots-head"><span className="mono-sm">path</span><span style={{ flex: 1 }} /><span className="mono-sm">our crawl</span></div>
          {sessions.robots.rules.map((r) => (
            <div key={r.path} className="robots-row">
              <span className="robots-path">{r.path}</span>
              <span style={{ flex: 1 }} />
              <span className={"robots-pill " + (r.allow ? "allow" : "deny")}>{r.allow ? "allowed" : "disallowed"}</span>
            </div>
          ))}
          <div className="robots-foot"><span className="mono-sm">crawl-delay <b>{sessions.robots.delay}</b> · our target paths are <b style={{ color: "var(--success)" }}>allowed</b></span></div>
        </div>
      </Card>

      <Card label="terms & license">
        <div className="col" style={{ gap: 8 }}>
          {srcs.filter((s) => s.id !== "rival").map((s) => {
            const c = window.CLEARANCE[s.id];
            return (
              <div key={s.id} className="terms-row">
                <ModeChip mode={s.mode} />
                <span className="srow-label">{s.label}</span>
                <span style={{ flex: 1 }} />
                {c.terms.license && <span className="lic-chip">{c.terms.license}</span>}
                <span className="mono-sm">{c.terms.text}</span>
                {c.terms.attribution && <span className="attr-chip" title={c.terms.attribution}>⚐ attribution</span>}
              </div>
            );
          })}
        </div>
      </Card>

      <Card label="intended use" badge={<span className="why-chip">ToS hinges on this</span>}>
        <div className="intended">{window.INTENDED_USE}</div>
      </Card>

      <Readiness checks={srcs.map((s) => {
        const st = statusOf(s.id);
        return { id: s.id, label: `${s.label} cleared for intended use`, ok: st === "cleared", block: st === "blocked", detail: CLR[st].label };
      })} tail={blocked ? <span style={{ color: "var(--danger)" }}><b>Hard stop</b> — a blocked source must be cleared or dropped before Acquire.</span> : review ? <span style={{ color: "var(--accent)" }}>Resolve “needs review” sources to unblock Acquire.</span> : <>All sources cleared — Acquire is unblocked.</>} />
    </>
  );
}

/* ===================================================================
   PANE C · ACQUIRE (dataAcquire)
   =================================================================== */
function AcquirePane({ state }) {
  const srcs = window.sourcesFor(state);
  const empty = state === "empty";
  const live = state === "live";

  if (empty) {
    return (
      <Card label="per-source acquisition">
        <div className="empty-block">
          <span className="eb-glyph">⬇</span>
          <span className="eb-title">Nothing to acquire yet</span>
          <span className="eb-sub">Cleared sources show up here to configure their scrape or fetch.</span>
          <div className="proposed-inline"><span className="why-spark">✦</span>Detected: a sitemap at confsite.com → scrape at 1 req/s, depth 2</div>
          <button className="btn-accent" style={{ marginTop: 4 }}>Use suggested crawl →</button>
        </div>
      </Card>
    );
  }

  return (
    <>
      {srcs.map((s) => {
        const cfg = window.ACQUIRE[s.id] || window.ACQUIRE.sessions;
        const isScrape = s.mode === "scrape";
        const run = window.LIVE_RUN[s.id] || window.LIVE_RUN.sessions;
        const configuredOnly = state === "partial" && s.id === "speakers";
        return (
          <Card key={s.id} label={isScrape ? "scrape · " + s.label : "fetch · " + s.label}
            badge={<ModeChip mode={s.mode} />}
            hint={configuredOnly ? "not captured" : live && s.id === "sessions" ? "running" : "ready"}>
            {isScrape ? (
              <>
                <div className="scope-grid g2">
                  <Kv k="start urls" v={cfg.crawl.start.join(", ")} />
                  <Kv k="depth" v={String(cfg.crawl.depth)} />
                  <Kv k="include" v={cfg.crawl.include} />
                  <Kv k="exclude" v={cfg.crawl.exclude} />
                </div>
                <div className="guardrails">
                  <span className="grd"><span className="grd-k">rate</span>{cfg.rate.rps}</span>
                  <span className="grd"><span className="grd-k">concurrency</span>{cfg.rate.concurrency}</span>
                  <span className="grd"><span className="grd-k">politeness</span>{cfg.rate.delay}</span>
                  <span className="grd ok"><span className="grd-k">robots</span>✓ respected</span>
                  <span className="grd"><span className="grd-k">js render</span>{cfg.options.jsRender ? "on" : "off"}</span>
                </div>
              </>
            ) : (
              <>
                <div className="scope-grid g2">
                  <Kv k="endpoint" v={cfg.endpoint} />
                  <Kv k="auth" v={cfg.auth} />
                  <Kv k="paging" v={`${cfg.paging.kind} · ${cfg.paging.pageSize}/page`} />
                  <Kv k="format" v={cfg.format} />
                </div>
                <div className="guardrails">
                  <span className="grd"><span className="grd-k">schedule</span>{cfg.schedule}</span>
                  <span className="grd ok"><span className="grd-k">auth</span>name only</span>
                </div>
              </>
            )}

            {/* capture preview / live run */}
            {live && s.id === "sessions" ? (
              <div className="live-capture">
                <div className="row" style={{ gap: 8, marginBottom: 7 }}>
                  <span className="sdot run" />
                  <span className="mono-sm" style={{ color: "var(--accent)" }}>{run.note}</span>
                  <span style={{ flex: 1 }} />
                  <span className="mono-sm">{run.done} / ~{run.total} pages</span>
                </div>
                <div className="live-bar"><i style={{ width: `${(run.done / run.total) * 100}%` }} /></div>
                <div className="row" style={{ gap: 12, marginTop: 7 }}>
                  <span className="mono-sm">rate <b style={{ color: "var(--fg)" }}>{run.rate}</b></span>
                  <span className="mono-sm">errors <b style={{ color: run.errors ? "var(--accent)" : "var(--fg)" }}>{run.errors}</b></span>
                  <span className="mono-sm">robots <b style={{ color: "var(--success)" }}>✓</b></span>
                </div>
              </div>
            ) : (
              <div className="capture-row">
                <span className="cap-icon">{isScrape ? "📄" : "{ }"}</span>
                <span className="mono-sm">{configuredOnly ? `estimate ${cfg.estimate}` : `captured ${cfg.captured}`}</span>
                <span style={{ flex: 1 }} />
                {configuredOnly
                  ? <span className="chip" style={{ fontSize: 8, color: "var(--accent)", borderColor: "var(--accent-dim)" }}>not run</span>
                  : <span className="chip" style={{ fontSize: 8, color: "var(--success)", borderColor: "color-mix(in oklch,var(--success),transparent 65%)" }}>staged ✓</span>}
              </div>
            )}
          </Card>
        );
      })}

      <Readiness checks={srcs.map((s) => {
        const captured = !(state === "partial" && s.id === "speakers") && !(state === "live" && s.id === "sessions");
        const running = state === "live" && s.id === "sessions";
        return { id: s.id, label: `Raw artifacts captured · ${s.label}`, ok: captured, detail: running ? "running…" : captured ? "staged" : "not run" };
      })} tail={<>Raw artifacts stage to a working area, then <b>Extract</b> parses them into rows.</>} />
    </>
  );
}

/* ===================================================================
   PANE D · EXTRACT (dataExtract)
   =================================================================== */
function ExtractPane({ state }) {
  const srcs = window.sourcesFor(state);
  const empty = state === "empty";
  const partial = state === "partial";

  if (empty) {
    return (
      <Card label="per-source extraction rules">
        <div className="empty-block">
          <span className="eb-glyph">⇲</span>
          <span className="eb-title">No extraction rules yet</span>
          <span className="eb-sub">Once raw artifacts are captured, map their elements to the Data Model here.</span>
          <div className="proposed-inline"><span className="why-spark">✦</span>Planner can propose selectors from a sampled <span className="mono">session-card.html</span></div>
          <button className="btn-accent" style={{ marginTop: 4 }}>Propose selectors →</button>
        </div>
      </Card>
    );
  }

  return (
    <>
      {srcs.filter((s) => s.id !== "rival").map((s) => {
        const ex = window.EXTRACT[s.id] || window.EXTRACT.sessions;
        return (
          <Card key={s.id} label={`${ex.kind.toLowerCase()} rules · ${s.label}`} badge={<ModeChip mode={s.mode} />}
            hint={<>artifact <span className="mono" style={{ color: "var(--fg-muted)" }}>{ex.artifact}</span></>}>
            <div className="sel-table">
              <div className="sel-head">
                <span>{ex.kind === "HTML" ? "selector" : "path"}</span>
                <span style={{ flex: 1 }} />
                <span>→ model field</span>
              </div>
              {ex.rules.map((r, i) => {
                const gap = partial && !r.ok;
                return (
                  <div key={i} className={"sel-row" + (gap ? " gap" : "")}>
                    <span className="sel-sel">{r.sel}</span>
                    <span className="sel-arrow">→</span>
                    <span className="sel-field">
                      <EntityChip name={r.entity} /><span className="sel-fname">.{r.field.split(".")[1]}</span>
                      {r.ref && <span className="ref-tag">ref → {r.ref}</span>}
                    </span>
                    {gap && <span className="gap-pill">no match</span>}
                  </div>
                );
              })}
            </div>
          </Card>
        );
      })}

      {/* field mapping gaps */}
      <Card label="field mapping" hint={partial ? "1 gap" : "0 gaps"}>
        <div className="gap-grid">
          <div className="gap-col">
            <div className="gap-label">model fields · no source <span className="gap-n">{window.EXTRACT_GAPS.unmappedModel.length}</span></div>
            {window.EXTRACT_GAPS.unmappedModel.map((g, i) => (
              <div key={i} className="gap-row"><span className="gap-field">{g.field}</span><span style={{ flex: 1 }} /><span className="gap-why">{g.why}</span></div>
            ))}
          </div>
          <div className="gap-col">
            <div className="gap-label">source elements · unmapped <span className="gap-n">{window.EXTRACT_GAPS.unmappedSource.length}</span></div>
            {window.EXTRACT_GAPS.unmappedSource.map((g, i) => (
              <div key={i} className="gap-row"><span className="gap-field">{g.sel}</span><span style={{ flex: 1 }} /><span className="gap-why">{g.why}</span></div>
            ))}
          </div>
        </div>
      </Card>

      {/* sample preview — marquee */}
      <Card label="sample extraction preview" accent badge={<span className="why-chip">ran on 1 sampled artifact</span>}>
        <div className="sample-wrap">
          <table className="sample">
            <thead><tr>{window.SAMPLE_ROWS.cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>
              {window.SAMPLE_ROWS.rows.map((row, i) => (
                <tr key={i}>{window.SAMPLE_ROWS.cols.map((c) => (
                  <td key={c} className={partial && c === "track" ? "cell-miss" : ""}>{partial && c === "track" ? "—" : row[c]}</td>
                ))}</tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mono-sm" style={{ marginTop: 8 }}>5 <EntityChip name="Talk" /> rows produced{partial && <span style={{ color: "var(--accent)" }}> · track empty (selector gap)</span>}</div>
      </Card>

      {/* coverage */}
      <Card label="coverage">
        <div className="cov-row">
          <div className="cov-stat"><span className="cov-v">{window.COVERAGE.parsed}/{window.COVERAGE.total}</span><span className="cov-k">pages parsed</span></div>
          <div className="cov-bar"><i style={{ width: `${window.COVERAGE.pct}%` }} /></div>
          <span className="mono-sm" style={{ color: "var(--success)" }}>{window.COVERAGE.pct}%</span>
        </div>
        {partial && window.COVERAGE.gaps.map((g, i) => (
          <div key={i} className="cov-gap"><span className="gap-pill">field gap</span><span className="mono-sm">{g.field} — {g.why}</span></div>
        ))}
      </Card>

      <Readiness checks={[
        { id: "rules", label: "Extraction rules defined per source", ok: true, detail: `${srcs.filter((s) => s.id !== "rival").length} sources` },
        { id: "map", label: "Field mapping resolved", ok: !partial, detail: partial ? "1 gap" : "0 gaps" },
        { id: "rows", label: "Structured rows produced", ok: true, detail: "preview ok" },
        { id: "cov", label: "Coverage ≥ 95%", ok: true, detail: `${window.COVERAGE.pct}%` },
      ]} tail={<>Structured rows feed the shared <b>Clean → Load</b> back half — quality gate · reconcile · lineage.</>} />
    </>
  );
}

Object.assign(window, { TargetsPane, LegitimacyPane, AcquirePane, ExtractPane });
