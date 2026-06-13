/* ===== Assistant drawer: Claude designs / edits the blueprint ===== */
const { useState: useStateA, useRef: useRefA, useEffect: useEffectA } = React;

// Map a free-text request to concrete, always-valid blueprint actions + prose.
function planActions(text, bp) {
  const t = text.toLowerCase();
  const have = new Set(bp.stages.map((s) => s.kind));
  const actions = [];
  const add = (kind, pipes) => { if (!have.has(kind)) { actions.push({ op: "add", kind, pipes }); have.add(kind); } };

  if (/secur|threat|audit|secret/.test(t)) add("security");
  if (/test|coverage|qa/.test(t)) add("testing", [["lint-plan", true]]);
  if (/observ|logging|metric|trac|monitor/.test(t)) add("observability");
  if (/contract|api|endpoint/.test(t)) { add("schema", [["schema-check", true]]); add("api", [["contract-test", true]]); }
  if (/preview|ui|screen|design|frontend/.test(t)) {
    if (!have.has("ux")) add("ux", [["render-preview", true]]);
    else actions.push({ op: "gatePipe", kind: "ux", pipeKey: "render-preview" });
  }
  if (/infra|deploy|hosting|cloud/.test(t)) add("infra");
  if (/ci|cd|release|build pipeline/.test(t)) add("cicd");
  if (/doc|readme|guide/.test(t)) add("docs");
  if (/persona|user research|audience/.test(t)) add("users");

  // trimming requests remove process-heavy stages
  if (/mvp|trim|lean|minimal|cut|simplify|fast/.test(t)) {
    ["observability", "infra", "docs", "cicd", "security"].forEach((k) => {
      if (have.has(k)) actions.push({ op: "remove", kind: k });
    });
  }
  return actions;
}

function actionLine(a) {
  const k = STAGE_KINDS[a.kind] || { title: a.kind, glyph: "category", h: 250 };
  if (a.op === "add") return { type: "add", title: k.title, note: a.pipes && a.pipes.length ? `+ ${a.pipes.map((p) => p[0]).join(", ")} ${a.pipes.some((p) => p[1]) ? "gate" : ""}`.trim() : "new stage", h: k.h, glyph: k.glyph };
  if (a.op === "remove") return { type: "del", title: k.title, note: "remove stage", h: k.h, glyph: k.glyph };
  if (a.op === "gatePipe") return { type: "mod", title: k.title, note: `gate ${a.pipeKey}`, h: k.h, glyph: k.glyph };
  return { type: "mod", title: a.kind, note: "", h: 250, glyph: "category" };
}

const SUGGESTIONS = [
  "Make it contract-first with API gates",
  "Add a security review stage",
  "Gate the UI design stage with render-preview",
  "Add testing + observability",
  "Trim it down to a lean MVP",
];

function ProseFor(actions, text) {
  if (actions.length === 0) {
    return "I couldn't map that to a concrete stage change yet. Try naming a concern — security, testing, API contracts, UI preview, observability — or ask me to trim it to an MVP.";
  }
  const adds = actions.filter((a) => a.op === "add").length;
  const dels = actions.filter((a) => a.op === "remove").length;
  const gates = actions.filter((a) => a.op === "gatePipe" || (a.pipes && a.pipes.some((p) => p[1]))).length;
  const bits = [];
  if (adds) bits.push(`add ${adds} stage${adds > 1 ? "s" : ""}`);
  if (dels) bits.push(`drop ${dels} stage${dels > 1 ? "s" : ""}`);
  if (gates) bits.push(`wire ${gates} gate${gates > 1 ? "s" : ""}`);
  return `Here's a focused change: I'd ${bits.join(", ")}. Dependencies are ordered so each stage stays locked until its prerequisites land. Review and apply, or refine the ask.`;
}

function Drawer({ bp, draftName, onApply, onClose, pushToast }) {
  const [msgs, setMsgs] = useStateA(() => draftName ? [
    { who: "ai", text: `Let's design "${draftName}". Tell me what you're building — the stack, the surface area, how much process you want — and I'll draft the stage flow. Or pick a starting point below.` },
  ] : [
    { who: "ai", text: `I can reshape "${bp.name}" for you. Describe a concern to add, ask me to gate a stage, or trim it to an MVP — I'll propose changes you can apply.` },
  ]);
  const [input, setInput] = useStateA("");
  const [busy, setBusy] = useStateA(false);
  const bodyRef = useRefA(null);

  useEffectA(() => { if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight; }, [msgs, busy]);

  async function send(text) {
    const q = (text || input).trim();
    if (!q || busy) return;
    setInput("");
    setMsgs((m) => [...m, { who: "me", text: q }]);
    setBusy(true);

    const actions = planActions(q, bp);
    let prose = ProseFor(actions, q);

    // Try a live Claude session for the explanation; fall back silently.
    try {
      if (window.claude && window.claude.complete && actions.length) {
        const sys = "You are a planning-blueprint designer for a multi-agent dev tool. In ONE short sentence (max 28 words), explain the proposed change. Be concrete and confident. No preamble, no lists.";
        const summary = actions.map((a) => `${a.op} ${a.kind}${a.pipes ? " (" + a.pipes.map((p) => p[0]).join(",") + ")" : ""}`).join("; ");
        const r = await window.claude.complete(`${sys}\n\nUser asked: "${q}"\nProposed actions: ${summary}\nBlueprint: ${bp.name} with stages ${bp.stages.map((s) => s.kind).join(", ")}.`);
        if (r && r.trim()) prose = r.trim();
      }
    } catch (_) { /* keep heuristic prose */ }

    await new Promise((res) => setTimeout(res, 520));
    setMsgs((m) => [...m, { who: "ai", text: prose, actions: actions.length ? actions : null }]);
    setBusy(false);
  }

  function apply(actions, idx) {
    onApply(actions);
    setMsgs((m) => m.map((mm, i) => i === idx ? { ...mm, applied: true } : mm));
    pushToast(`Applied ${actions.length} change${actions.length > 1 ? "s" : ""}`, "am");
  }

  return (
    <div className="drawer">
      <div className="drawer-head">
        <span className="da">✦</span>
        <div><h2>Design with Claude</h2><div className="dsub mono">blueprint architect · session</div></div>
        <span style={{ flex: 1 }} />
        <button className="iconbtn" onClick={onClose}>✕</button>
      </div>

      <div className="drawer-body" ref={bodyRef}>
        {msgs.map((m, i) => (
          <div className={"msg " + (m.who === "me" ? "me" : "ai")} key={i}>
            <span className="who">{m.who === "me" ? "you" : "claude"}</span>
            <div className="bub">{m.text}</div>
            {m.actions && (
              <div className="proposal">
                <div className="ptitle">✦ Proposed changes <span className="dim">· {m.actions.length}</span></div>
                <div className="pchanges">
                  {m.actions.map((a, j) => {
                    const l = actionLine(a);
                    return (
                      <div className={"diff-line " + l.type} key={j}>
                        <span className="dmark">{l.type === "add" ? "+" : l.type === "del" ? "−" : "~"}</span>
                        <span className="sicon" style={{ width: 18, height: 18, flex: "0 0 18px", borderRadius: 4, fontSize: 9, background: tint(l.h, 0.18), color: hue(l.h), display: "flex", alignItems: "center", justifyContent: "center" }}><Ic n={l.glyph} size={11} /></span>
                        <span className="dtitle">{l.title}</span>
                        <span style={{ flex: 1 }} />
                        <span className="dim" style={{ fontSize: 9.5 }}>{l.note}</span>
                      </div>
                    );
                  })}
                </div>
                {m.applied
                  ? <div className="hint mono" style={{ color: "var(--success)" }}>✓ Applied to blueprint</div>
                  : <div className="pacts"><button className="btn sm primary" onClick={() => apply(m.actions, i)}>Apply changes</button><button className="btn sm ghost" onClick={() => setMsgs((mm) => mm.map((x, k) => k === i ? { ...x, actions: null, text: x.text + " (dismissed)" } : x))}>Dismiss</button></div>}
              </div>
            )}
          </div>
        ))}
        {busy && <div className="msg ai"><span className="who">claude</span><div className="bub"><span className="typing"><i /><i /><i /></span></div></div>}
      </div>

      <div className="drawer-foot">
        <div className="chips" style={{ marginBottom: 10 }}>
          {SUGGESTIONS.map((s) => <button className="chip-sug" key={s} onClick={() => send(s)} disabled={busy}>{s}</button>)}
        </div>
        <div className="composer">
          <textarea className="input" placeholder="Describe the change you want…" value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} />
          <button className="btn primary icon" style={{ height: 56, width: 40 }} onClick={() => send()} disabled={busy || !input.trim()}>↑</button>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { Drawer, planActions });
