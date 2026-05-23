import { useState, useMemo, useRef, useCallback } from "react";
import { KB_TAGS } from "../data/mock";
import { useAppStore } from "../store";
import { KbConsole } from "../components/kb/KbConsole";

function tagColor(tag: string) {
  if (tag === "review-policy") return "amber";
  if (tag === "architecture" || tag === "decisions") return "info";
  if (tag === "agents" || tag === "prompts") return "green";
  return "";
}

const MIN_EDITOR_H = 160;
const MIN_CONSOLE_H = 140;

export function KnowledgeStoreScreen() {
  const { kbBlocks } = useAppStore();

  const [activeTags, setActiveTags] = useState<string[]>(["all"]);
  const [selectedId, setSelectedId] = useState<string>(kbBlocks[0]?.id ?? "");
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<"updated" | "title" | "size">("updated");
  const [consoleH, setConsoleH] = useState(240);

  // Drag-to-resize divider
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const onDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startY: e.clientY, startH: consoleH };

    function onMove(ev: MouseEvent) {
      if (!dragRef.current || !containerRef.current) return;
      const delta = dragRef.current.startY - ev.clientY;
      const totalH = containerRef.current.clientHeight;
      const newH = Math.max(MIN_CONSOLE_H, Math.min(totalH - MIN_EDITOR_H, dragRef.current.startH + delta));
      setConsoleH(newH);
    }
    function onUp() {
      dragRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [consoleH]);

  function toggleTag(name: string) {
    if (name === "all") { setActiveTags(["all"]); return; }
    setActiveTags((prev) => {
      const isOn = prev.includes(name);
      const next = prev.filter((t) => t !== "all" && t !== name);
      if (isOn) return next.length === 0 ? ["all"] : next;
      return [...next, name];
    });
  }

  const filtered = useMemo(() => {
    let list = kbBlocks.filter((b) => {
      if (!activeTags.includes("all") && !b.tags.some((t) => activeTags.includes(t))) return false;
      if (search.trim() && !b.title.toLowerCase().includes(search.trim().toLowerCase())) return false;
      return true;
    });
    if (sortBy === "title") list = [...list].sort((a, b) => a.title.localeCompare(b.title));
    if (sortBy === "size")  list = [...list].sort((a, b) => b.lines - a.lines);
    return list;
  }, [kbBlocks, activeTags, search, sortBy]);

  const selected = filtered.find((b) => b.id === selectedId) ?? filtered[0] ?? kbBlocks[0];

  const hintText = activeTags.includes("all")
    ? `${filtered.length} blocks · all`
    : `${filtered.length} blocks · ${activeTags.map((t) => `#${t}`).join(", ")}`;

  return (
    <div style={{ flex: 1, display: "flex", minHeight: 0 }}>

      {/* ── Tag rail ─────────────────────────────────────────────────── */}
      <aside style={{
        width: 200, flex: "0 0 200px", background: "var(--bg-panel)",
        borderRight: "1px solid var(--border-soft)", padding: "14px 8px",
        display: "flex", flexDirection: "column", gap: 1, overflow: "auto",
      }}>
        <div style={{
          fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".08em",
          color: "var(--fg-dim)", padding: "2px 12px 8px",
          display: "flex", justifyContent: "space-between",
        }}>
          <span>TAGS</span>
          <span style={{ cursor: "pointer", color: "var(--fg-muted)" }}>+</span>
        </div>

        {KB_TAGS.map((t) => {
          const on = activeTags.includes(t.name);
          return (
            <div
              key={t.name}
              onClick={() => toggleTag(t.name)}
              style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: on ? "6px 10px 6px 10px" : "6px 10px 6px 12px",
                borderRadius: 5, fontSize: 11.5,
                background: on ? "var(--bg-elev)" : "transparent",
                color: on ? "var(--fg)" : "var(--fg-muted)",
                borderLeft: on ? "2px solid var(--accent)" : "2px solid transparent",
                cursor: "pointer", fontFamily: "var(--mono)", userSelect: "none",
              }}
            >
              <span>#{t.name}</span>
              <span style={{ color: "var(--fg-dim)", fontSize: 10.5 }}>{t.n}</span>
            </div>
          );
        })}

        <div style={{ height: 14 }} />
        <div style={{
          fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".08em",
          color: "var(--fg-dim)", padding: "2px 12px 8px",
        }}>SOURCES</div>
        {["manual", "agent-authored", "github · imported"].map((s) => (
          <div key={s} style={{
            padding: "6px 12px", fontSize: 11.5, fontFamily: "var(--mono)",
            color: "var(--fg-muted)", cursor: "pointer",
          }}>{s}</div>
        ))}
      </aside>

      {/* ── Block list ───────────────────────────────────────────────── */}
      <aside style={{
        width: 280, flex: "0 0 280px", background: "var(--bg-canvas)",
        borderRight: "1px solid var(--border-soft)", display: "flex", flexDirection: "column",
      }}>
        <div style={{
          padding: "12px 12px 8px", borderBottom: "1px solid var(--border-soft)",
          display: "flex", flexDirection: "column", gap: 8,
        }}>
          <input
            className="input"
            placeholder="⌕ search blocks…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div style={{ display: "flex", gap: 6, alignItems: "center", justifyContent: "space-between" }}>
            <span className="hint">{hintText}</span>
            <select
              className="input"
              style={{ height: 22, width: 90, fontSize: 10.5 }}
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
            >
              <option value="updated">updated</option>
              <option value="title">title</option>
              <option value="size">size</option>
            </select>
          </div>
        </div>

        <div style={{ flex: 1, overflow: "auto" }}>
          {filtered.length === 0 ? (
            <div style={{
              padding: "24px 16px", fontFamily: "var(--mono)", fontSize: 11,
              color: "var(--fg-dim)", textAlign: "center",
            }}>no blocks match</div>
          ) : filtered.map((b) => {
            const sel = selected && b.id === selected.id;
            return (
              <div
                key={b.id}
                onClick={() => setSelectedId(b.id)}
                style={{
                  padding: sel ? "11px 12px 11px 10px" : "11px 12px",
                  borderBottom: "1px solid var(--border-soft)",
                  background: sel ? "var(--bg-elev)" : "transparent",
                  borderLeft: sel ? "2px solid var(--accent)" : "2px solid transparent",
                  cursor: "pointer",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>{b.id}</span>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>{b.updated}</span>
                </div>
                <div style={{
                  fontSize: 12, color: sel ? "var(--fg)" : "var(--fg-muted)",
                  marginBottom: 5, fontWeight: 500,
                }}>{b.title}</div>
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {b.tags.map((tag) => (
                    <span key={tag} className={`tag ${tagColor(tag)}`}>#{tag}</span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ padding: 10, borderTop: "1px solid var(--border-soft)" }}>
          <button className="btn primary" style={{ width: "100%", justifyContent: "center" }}>+ New block</button>
        </div>
      </aside>

      {/* ── Right column: editor/preview + console (T stem) ─────────── */}
      <div ref={containerRef} style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>

        {/* Editor + preview */}
        <section style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: MIN_EDITOR_H, overflow: "hidden" }}>
          {selected && (
            <>
              <header style={{
                padding: "12px 18px", borderBottom: "1px solid var(--border-soft)",
                display: "flex", alignItems: "center", gap: 10, background: "var(--bg-panel)",
                flexShrink: 0,
              }}>
                <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", whiteSpace: "nowrap" }}>
                  {selected.id}
                </span>
                <input
                  className="input"
                  key={selected.id}
                  defaultValue={selected.title}
                  style={{
                    flex: 1, height: 30, fontSize: 14, fontFamily: "var(--sans)",
                    background: "transparent", border: "1px solid transparent",
                  }}
                />
                {selected.tags.map((tag) => (
                  <span key={tag} className={`tag ${tagColor(tag)}`}>#{tag}</span>
                ))}
                <button className="btn ghost" style={{ height: 24, fontSize: 10.5 }}>+ tag</button>
                <div style={{ width: 1, height: 18, background: "var(--border-soft)" }} />
                <button className="btn ghost" style={{ height: 24 }}>↗ link</button>
                <button className="btn ghost" style={{ height: 24 }}>⎘ embed</button>
                <button className="btn">save</button>
              </header>

              <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
                {/* Raw editor */}
                <div style={{
                  flex: 1, padding: "18px 22px", overflow: "auto",
                  borderRight: "1px solid var(--border-soft)",
                }}>
                  <pre style={{
                    margin: 0, fontFamily: "var(--mono)", fontSize: 12,
                    lineHeight: 1.7, color: "var(--fg)", whiteSpace: "pre-wrap",
                  }}>
                    {selected.content ?? "# " + selected.title + "\n\n(no content yet)"}
                  </pre>
                </div>

                {/* Preview */}
                <div style={{
                  flex: 1, padding: "18px 24px", overflow: "auto",
                  background: "var(--bg-panel)",
                }}>
                  <div style={{
                    fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)",
                    textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 10,
                  }}>preview</div>
                  <h1 style={{ fontSize: 20, margin: "0 0 12px", fontWeight: 600, fontFamily: "var(--sans)" }}>
                    {selected.title}
                  </h1>
                  <div style={{ display: "flex", gap: 4, marginBottom: 14, flexWrap: "wrap" }}>
                    {selected.tags.map((tag) => (
                      <span key={tag} className={`tag ${tagColor(tag)}`}>#{tag}</span>
                    ))}
                  </div>
                  <div style={{
                    fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-muted)",
                    lineHeight: 1.7,
                  }}>
                    {selected.lines} lines · updated {selected.updated}
                  </div>
                  <div style={{
                    marginTop: 16, padding: "9px 13px",
                    borderLeft: "2px solid var(--accent-dim)",
                    background: "var(--bg-elev)",
                    fontSize: 11, color: "var(--fg-muted)",
                  }}>
                    <div style={{
                      fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)",
                      marginBottom: 4, textTransform: "uppercase", letterSpacing: ".06em",
                    }}>backlinks</div>
                    Used by agent{" "}
                    <code style={{ color: "var(--success)" }}>@reviewer</code>{" "}
                    · 3 other blocks link here.
                  </div>
                </div>
              </div>
            </>
          )}
        </section>

        {/* Drag handle */}
        <div
          onMouseDown={onDividerMouseDown}
          style={{
            height: 5, flexShrink: 0,
            background: "var(--border-soft)",
            cursor: "row-resize",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          <div style={{
            width: 32, height: 2, borderRadius: 1,
            background: "var(--border)",
          }} />
        </div>

        {/* KB Console */}
        <div style={{ height: consoleH, flexShrink: 0, overflow: "hidden" }}>
          {selected && <KbConsole block={selected} />}
        </div>
      </div>
    </div>
  );
}
