/* global React */
// chrome.jsx — Titlebar, Rail, Tabstrip, StatusBar
// Same vocabulary as v1 minus Automations.

const NAV = [
  { key:"console",    label:"⌘", title:"Console" },
  { key:"knowledge",  label:"K", title:"Knowledge Store" },
  { key:"automation", label:"A", title:"Automations" },
  { key:"github",     label:"G", title:"GitHub" },
  { key:"settings",   label:"⚙", title:"Settings" },
];

function Titlebar({ workspace="orchestrator · acme/payments", meta }) {
  return (
    <div className="titlebar">
      <div className="tl-lights"><i/><i/><i/></div>
      <div className="tl-title">base-studio-code — {workspace}</div>
      <div className="tl-meta">
        {meta || (
          <>
            <span>claude <b style={{color:"var(--success)"}}>● connected</b></span>
            <span>github <b>lina-engelbrecht</b></span>
          </>
        )}
      </div>
    </div>
  );
}

function Rail({ active="console" }) {
  return (
    <div className="rail">
      <div className="logo">b.</div>
      {NAV.map(n => (
        <button key={n.key} className={n.key===active ? "active" : ""} title={n.title}>{n.label}</button>
      ))}
      <div className="spacer"/>
      <button title="Profile">@</button>
    </div>
  );
}

function Tabstrip({ tabs, activeIdx=0 }) {
  return (
    <div className="tabstrip">
      {tabs.map((t, i) => (
        <div key={i} className={"tab " + (i===activeIdx ? "active" : "")}>
          <span className={"dot " + (t.state||"")}/>
          <span style={{overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{t.name}</span>
          <span style={{color:"var(--fg-dim)", marginLeft:4, fontSize:10}}>{t.layout}</span>
          <span className="x">×</span>
        </div>
      ))}
      <button className="tab-add">+</button>
      <div style={{flex:1}}/>
      <div style={{alignSelf:"center", marginRight:8, color:"var(--fg-dim)", fontSize:10}}>
        <span className="kbd">⌘1</span> <span className="kbd">⌘2</span> <span className="kbd">⌘T</span>
      </div>
    </div>
  );
}

function StatusBar({ extra }) {
  return (
    <div className="statusbar">
      <div className="s"><i/> claude · 14.2k ctx</div>
      <div className="s"><i/> github · synced</div>
      <div className="spacer"/>
      {extra}
      <div>v0.5.0 · rust 1.78</div>
    </div>
  );
}

Object.assign(window, { Titlebar, Rail, Tabstrip, StatusBar, NAV });
