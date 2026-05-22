/* global React, Titlebar, Rail, Tabstrip, StatusBar,
   PaneShell, ConsoleView, FilesView, BranchesView, ChangesView, LogView,
   REVIEW_TURNS, TREE */

// Main console — 3×3 grid of panes, each in a different view.
// One pane has its hamburger menu open as a demonstration.

function ScreenConsole({ menuPaneIdx = 0 }) {
  const cells = [
    { agent:"@reviewer",   status:"run",  active:"console",
      view:<ConsoleView small turns={REVIEW_TURNS.slice(0,2)}/>, meta:"PR #418" },
    { agent:"@docs",       status:"on",   active:"files",
      view:<FilesView small tree={TREE.slice(0,10)}
                      active="crates/ws-server/src/tunnel.rs"
                      cwd="~/Code/acme/payments"/>, meta:"watch" },
    { agent:"@triager",    status:"run",  active:"changes",
      view:<ChangesView small/>, meta:"WIP" },
    { agent:"@scratch",    status:"on",   active:"branches",
      view:<BranchesView small/>, meta:"" },
    { agent:"@dispatcher", status:"on",   active:"console",
      view:<ConsoleView small withInput={false} turns={[
        { role:"assistant", blocks:[
          { kind:"text", text:"awaiting webhook routing. 2 in queue." },
          { kind:"tool", tool:"gh", args:"webhooks recent", ok:true, summary:"12 in 1h" },
        ]},
      ]}/>, meta:"q:2" },
    { agent:"@db-shell",   status:"idle", active:"console",
      view:<ConsoleView small withInput={false} turns={[
        { role:"assistant", blocks:[{kind:"text", text:"sqlite session idle. /scan to start."}]},
      ]}/>, meta:"sqlite" },
    { agent:"@github",     status:"on",   active:"log",
      view:<LogView small/>, meta:"main" },
    { agent:"@tunnel-mon", status:"on",   active:"console",
      view:<ConsoleView small withInput={false} turns={[
        { role:"assistant", blocks:[
          { kind:"tool", tool:"ws", args:"ping iPhone-Lina", ok:true, summary:"24ms" },
          { kind:"tool", tool:"ws", args:"ping Pixel-Alex",  ok:true, summary:"61ms" },
          { kind:"text", text:"forwarded 12 frames · 0 dropped" },
        ]},
      ]}/>, meta:"42 e/s" },
    { agent:"@logs",       status:"on",   active:"console",
      view:<ConsoleView small withInput={false} turns={[
        { role:"assistant", blocks:[{kind:"text",
          text:"[14:22:08] auto  fired rule=R-02\n[14:22:10] kb    upsert id=blk_9a2c\n[14:22:14] orch  spawn agent=@reviewer pid=8821"}]},
      ]}/>, meta:"tail" },
  ];

  return (
    <div className="app">
      <Titlebar workspace="orchestrator · acme/payments"/>
      <div className="shell">
        <Rail active="console"/>
        <div className="main">
          <Tabstrip
            tabs={[
              { name:"orchestrator", layout:"3×3", state:"run" },
              { name:"feat/tunnel",  layout:"2×2", state:"on"  },
              { name:"scratch",      layout:"1×1", state:"idle"},
            ]}
            activeIdx={0}
          />
          <div className="page" style={{flexDirection:"column"}}>
            <div className="console-grid" style={{
              gridTemplateColumns:"repeat(3, 1fr)",
              gridTemplateRows:"repeat(3, 1fr)",
            }}>
              {cells.map((c,i)=>(
                <PaneShell key={i}
                  agent={c.agent} status={c.status}
                  repo="acme/payments" branch="main" dirty
                  model={i===menuPaneIdx ? "sonnet-4.5" : "sonnet-4.5"}
                  available={["console","files","branches","changes","log"]}
                  active={c.active}
                  meta={c.meta}
                  menuOpen={i===menuPaneIdx}
                >
                  {c.view}
                </PaneShell>
              ))}
            </div>
          </div>
          <StatusBar extra={<span className="s">9 panes · 5 views · acme/payments</span>}/>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { ScreenConsole });
