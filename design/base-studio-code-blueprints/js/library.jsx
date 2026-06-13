/* ===== Library view: blueprint cards grid + community catalog ===== */
const { useState: useStateLib } = React;

function StagePips({ stages, mode }) {
  const m = mode || "flow";
  const isGate = (s) => s.pipelines.some((p) => p.gate);
  const title = stages.map((s) => s.title).join(" → ");

  if (m === "bars") {
    return (
      <div className="pips" title={title}>
        {stages.map((s) => {
          const k = STAGE_KINDS[s.kind];
          return <span key={s.id} className={"pip" + (s.dependsOn.length ? " lock" : "")}
            style={{ background: hue(k ? k.h : 250) }} />;
        })}
      </div>
    );
  }

  if (m === "text") {
    const names = stages.map((s) => s.title);
    const shown = names.slice(0, 6);
    return (
      <div className="stagetext" title={title}>
        {shown.join("  ·  ")}
        {names.length > shown.length && <span className="more">{"  ·  +" + (names.length - shown.length) + " more"}</span>}
      </div>
    );
  }

  if (m === "stepper") {
    return (
      <div className="steptrack" title={title}>
        {stages.map((s, i) => (
          <React.Fragment key={s.id}>
            {i > 0 && <span className="seg-ln" />}
            <span className={"node" + (isGate(s) ? " gate" : "")} title={s.title + (isGate(s) ? " · gated" : "")} />
          </React.Fragment>
        ))}
      </div>
    );
  }

  // flow (default): monochrome icon sequence, gates carry the lone accent
  const cap = 9;
  const shown = stages.slice(0, cap);
  return (
    <div className="seq" title={title}>
      {shown.map((s, i) => {
        const k = STAGE_KINDS[s.kind];
        return (
          <React.Fragment key={s.id}>
            {i > 0 && <span className="arr">›</span>}
            <span className={"st-g" + (isGate(s) ? " gated" : "")} title={s.title}><Ic n={k ? k.glyph : "category"} size={13} /></span>
          </React.Fragment>
        );
      })}
      {stages.length > cap && <span className="more">+{stages.length - cap}</span>}
    </div>
  );
}

function gistBadge(g) {
  if (!g || g.state === "local") return { cls: "", dot: "var(--fg-dim)", label: "local only" };
  if (g.state === "dirty") return { cls: "am", dot: "var(--accent)", label: "unpublished changes" };
  if (g.state === "forked") return { cls: "", dot: "var(--violet)", label: "forked" };
  return { cls: "ok", dot: "var(--success)", label: "synced · " + (g.rev || "r1") };
}

function BlueprintCard({ bp, index, onOpen, onMenu, mode }) {
  const gates = bp.stages.reduce((n, s) => n + s.pipelines.filter((p) => p.gate).length, 0);
  const pipes = bp.stages.reduce((n, s) => n + s.pipelines.length, 0);
  const gb = gistBadge(bp.gist);
  return (
    <div className="bp-card" style={{ animationDelay: index * 0.03 + "s" }} onClick={() => onOpen(bp.id)}>
      <div className="bp-actions">
        <button className="iconbtn" title="Duplicate" onClick={(e) => { e.stopPropagation(); onMenu("duplicate", bp, e); }}>⧉</button>
        <button className="iconbtn" title="More" onClick={(e) => { e.stopPropagation(); onMenu("open-menu", bp, e); }}>⋯</button>
      </div>
      <div className="bp-top">
        <div className="bp-icon" style={{ background: tint(bp.h, 0.16), color: hue(bp.h), borderColor: tint(bp.h, 0.4) }}>{bp.icon}</div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h3>{bp.name}
            {bp.origin === "built-in" && <span className="tag">built-in</span>}
            {bp.origin === "forked" && <span className="tag violet">forked</span>}
            {bp.origin === "imported" && <span className="tag info">imported</span>}
          </h3>
          <p className="bp-desc">{bp.desc}</p>
        </div>
      </div>

      <StagePips stages={bp.stages} mode={mode} />

      <div className="bp-foot">
        <span>{bp.stages.length} stages</span>
        {pipes > 0 && <span>· {pipes} pipelines</span>}
        {gates > 0 && <span style={{ color: "var(--accent)" }}>· {gates} gates</span>}
        <span className="sp" />
        <span className="gsync"><i style={{ background: gb.dot }} />{gb.label}</span>
      </div>
    </div>
  );
}

function LibraryView({ blueprints, stats, onOpen, onMenu, onNew, onImport }) {
  const totalStages = blueprints.reduce((n, b) => n + b.stages.length, 0);
  const published = blueprints.filter((b) => b.gist && b.gist.state !== "local").length;
  const gates = blueprints.reduce((n, b) => n + b.stages.reduce((m, s) => m + s.pipelines.filter((p) => p.gate).length, 0), 0);
  const top = [...blueprints].sort((a, b) => b.uses - a.uses)[0];

  return (
    <div className="wrap">
      <div className="phead">
        <div>
          <h1>Blueprints</h1>
          <p className="psub">Reusable planning templates — an ordered set of stages, each with its own prompt module and attached pipelines. Pick one to seed every new project's planning session.</p>
        </div>
        <div className="pacts">
          <span className="sync-dot" style={{ marginRight: 4 }}><i />gist sync on</span>
          <button className="btn" onClick={onImport}><Ic n="cloud_download" size={14} /> Import from gist</button>
          <button className="btn primary" onClick={onNew}><Ic n="add" size={14} /> New blueprint</button>
        </div>
      </div>

      <div className="hero">
        <div className="hicon">B</div>
        <div className="htxt">
          <div className="heyebrow">Blueprints · library</div>
          <div className="hbody">
            <b>{blueprints.length} blueprints</b> in your library — seeding planning across the fleet.{" "}
            <b>{top.name}</b> is the workhorse at <span className="em-amber">{top.uses} uses</span>.{" "}
            {published > 0 ? <>{published} are <b>published to gists</b> and shareable; </> : null}
            author your own, then publish in one click to share with others.
          </div>
        </div>
      </div>

      <div className="stats">
        <div className="stat"><div className="sk">Blueprints</div><div className="sv">{blueprints.length}</div><div className="sm">in library</div></div>
        <div className="stat"><div className="sk">Stages · total</div><div className="sv">{totalStages}</div><div className="sm">across all blueprints</div></div>
        <div className="stat"><div className="sk">Gate pipelines</div><div className="sv am">{gates}</div><div className="sm">block until they pass</div></div>
        <div className="stat"><div className="sk">Published</div><div className="sv ok">{published}</div><div className="sm">shared via gist</div></div>
        <div className="stat"><div className="sk">Projects seeded</div><div className="sv">{stats.seeded}</div><div className="sm">all-time</div></div>
      </div>

      <div className="seclabel">Your library<span className="ln" /><span className="dim">{blueprints.length}</span></div>
      <div className="bp-grid">
        {blueprints.map((bp, i) => (
          <BlueprintCard key={bp.id} bp={bp} index={i} onOpen={onOpen} onMenu={onMenu} mode="flow" />
        ))}
        <button className="bp-card" style={{ display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 10, color: "var(--fg-dim)", border: "1px dashed var(--border)", background: "transparent", minHeight: 150 }} onClick={onNew}>
          <Ic n="add" size={22} style={{ opacity: .7 }} />
          <span className="mono" style={{ fontSize: 11 }}>New blueprint</span>
          <span className="hint">start blank, or design it with Claude</span>
        </button>
      </div>
    </div>
  );
}

function CatalogView({ catalog, mineIds, onFork, onPreview, onBack, onManualImport }) {
  const [q, setQ] = useStateLib("");
  const [sort, setSort] = useStateLib("stars");
  let rows = catalog.filter((c) => (c.name + " " + c.tags.join(" ") + " " + c.author).toLowerCase().includes(q.toLowerCase()));
  rows = [...rows].sort((a, b) => sort === "stars" ? b.stars - a.stars : a.name.localeCompare(b.name));

  return (
    <div className="wrap">
      <button className="btn ghost sm" onClick={onBack} style={{ marginBottom: 14 }}><Ic n="arrow_back" size={14} /> Blueprints</button>
      <div className="phead">
        <div>
          <h1>Import from gist</h1>
          <p className="psub">Bring a blueprint in from a GitHub gist — browse the community catalog and fork one, or paste a gist URL / ID directly.</p>
        </div>
        <div className="pacts">
          <button className="btn" onClick={onManualImport}><Ic n="link" size={14} /> Import by URL / ID</button>
        </div>
      </div>

      <div className="hero">
        <div className="hicon" style={{ background: "color-mix(in oklch, var(--info), transparent 82%)", color: "var(--info)" }}>★</div>
        <div className="htxt">
          <div className="heyebrow" style={{ color: "var(--info)" }}>gist catalog · community</div>
          <div className="hbody">
            <b>{catalog.length} shared blueprints</b> from the community. Forking pulls the gist into your library and links it upstream — you'll get a <b>sync prompt</b> when the author ships updates.
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 9, marginBottom: 16, alignItems: "center" }}>
        <input className="input" placeholder="search blueprints, tags, authors…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 320, fontFamily: "var(--mono)" }} />
        <div className="seg">
          <button className={sort === "stars" ? "on" : ""} onClick={() => setSort("stars")}>most starred</button>
          <button className={sort === "name" ? "on" : ""} onClick={() => setSort("name")}>name</button>
        </div>
        <span className="sp" style={{ flex: 1 }} />
        <span className="hint mono">{rows.length} results</span>
      </div>

      {rows.map((c, i) => {
        const forked = mineIds.includes(c.id);
        return (
          <div className="cat-row" key={c.id} style={{ animationDelay: i * 0.03 + "s" }}>
            <div className="ci" style={{ background: tint(c.h, 0.16), color: hue(c.h) }}>{c.icon}</div>
            <div className="cmeta">
              <div className="cname">{c.name}
                {c.tags.map((t) => <span className="tag" key={t}>{t}</span>)}
              </div>
              <div className="cby">gist.github.com/{c.author}/{c.gistId} · updated {c.updated}</div>
              <div className="cdesc">{c.desc}</div>
            </div>
            <div style={{ textAlign: "right", display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-end" }}>
              <span className="cstars"><span style={{ color: "var(--accent)" }}>★</span> {c.stars.toLocaleString()}</span>
              <span className="hint mono">{c.stageCount} stages</span>
            </div>
            <div style={{ display: "flex", gap: 7 }}>
              <button className="btn sm ghost" onClick={() => onPreview(c)}>Preview</button>
              <button className="btn sm primary" disabled={forked} onClick={() => onFork(c)}>{forked ? "✓ Forked" : <><Ic n="fork_right" size={13} /> Fork</>}</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

Object.assign(window, { LibraryView, CatalogView, gistBadge, StagePips, BlueprintCard });
