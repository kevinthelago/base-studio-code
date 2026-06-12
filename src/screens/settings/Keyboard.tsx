import { useEffect, useState } from "react";
import { SHORTCUT_GROUPS } from "../../lib/shortcuts";
import { useAppStore } from "../../store";
import {
  REBINDABLE_IDS,
  effectiveChord,
  chordToCaps,
  eventToChord,
  isModifierCode,
  findConflict,
  REBINDABLE,
  type RebindableId,
} from "../../lib/keybindings";

const REBINDABLE_SET = new Set<string>(REBINDABLE_IDS);
const labelOf = (id: string) => REBINDABLE.find((r) => r.id === id)?.label ?? id;

function KeyCap({ children, active }: { children: React.ReactNode; active?: boolean }) {
  return (
    <kbd style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      minWidth: 20, height: 22, padding: "0 7px",
      fontFamily: "var(--mono)", fontSize: 11, color: active ? "var(--accent)" : "var(--fg)",
      background: "var(--bg-elev2)",
      border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
      borderRadius: 5, boxShadow: "0 1px 0 var(--border)",
    }}>{children}</kbd>
  );
}

/** Render a list of key caps with "+" separators. */
function Chord({ caps, active }: { caps: string[]; active?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap", justifyContent: "flex-end" }}>
      {caps.map((k, ki) => (
        <span key={ki} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          {ki > 0 && <span style={{ color: "var(--fg-dim)", fontSize: 10 }}>+</span>}
          <KeyCap active={active}>{k}</KeyCap>
        </span>
      ))}
    </div>
  );
}

export function KeyboardSettings() {
  const keybindings = useAppStore((s) => s.keybindings);
  const setKeybinding = useAppStore((s) => s.setKeybinding);
  const resetKeybinding = useAppStore((s) => s.resetKeybinding);
  const resetAllKeybindings = useAppStore((s) => s.resetAllKeybindings);

  const [capturingId, setCapturingId] = useState<RebindableId | null>(null);
  const [error, setError] = useState<string | null>(null);

  const overrideCount = REBINDABLE_IDS.filter((id) => keybindings[id]).length;

  // While capturing, intercept the next chord on the document (capture phase, so
  // it beats anything else) and assign it — unless it collides with another
  // rebindable action, in which case we flag it and keep listening. Esc cancels.
  useEffect(() => {
    if (!capturingId) return;
    function onKey(e: KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Escape") { setCapturingId(null); setError(null); return; }
      if (isModifierCode(e.code)) return; // wait for a real key with its modifiers
      const chord = eventToChord(e);
      if (!chord) return;
      const id = capturingId!;
      const conflict = findConflict(useAppStore.getState().keybindings, id, chord);
      if (conflict) {
        setError(`That combination is already used by "${labelOf(conflict)}".`);
        return; // stay in capture so the user can try another
      }
      setKeybinding(id, chord);
      setCapturingId(null);
      setError(null);
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [capturingId, setKeybinding]);

  function startCapture(id: RebindableId) {
    setError(null);
    setCapturingId((cur) => (cur === id ? null : id));
  }

  return (
    <div style={{ maxWidth: 820 }}>
      <h2 style={{ fontFamily: "var(--mono)", fontSize: 18, margin: "0 0 4px", fontWeight: 600 }}>Keyboard</h2>
      <p style={{ color: "var(--fg-muted)", margin: "0 0 18px", fontSize: 12 }}>
        Every keyboard shortcut, grouped by what it affects. The console action shortcuts can be
        rebound — click one and press a new combination. Number-range and navigation keys are fixed.
      </p>

      {(overrideCount > 0 || capturingId) && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
          {capturingId ? (
            <span style={{ fontSize: 12, color: "var(--accent)", fontFamily: "var(--mono)" }}>
              Press a key combination… <span style={{ color: "var(--fg-dim)" }}>(Esc to cancel)</span>
            </span>
          ) : (
            <span style={{ fontSize: 12, color: "var(--fg-muted)" }}>
              {overrideCount} custom binding{overrideCount === 1 ? "" : "s"}.
            </span>
          )}
          {overrideCount > 0 && !capturingId && (
            <button
              onClick={() => { resetAllKeybindings(); setError(null); }}
              style={{
                fontSize: 11, fontFamily: "var(--mono)", color: "var(--fg-muted)",
                background: "transparent", border: "1px solid var(--border)", borderRadius: 5,
                padding: "3px 9px", cursor: "pointer",
              }}
            >
              Reset all to defaults
            </button>
          )}
        </div>
      )}

      {error && (
        <div style={{ fontSize: 12, color: "var(--danger, #e06c75)", marginBottom: 12 }}>{error}</div>
      )}

      {SHORTCUT_GROUPS.map((group) => (
        <div key={group.title} className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "baseline", marginBottom: 12, gap: 10 }}>
            <h3 style={{ margin: 0 }}>{group.title}</h3>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            {group.items.map((s, i) => {
              const rebindable = s.id != null && REBINDABLE_SET.has(s.id);
              const id = s.id as RebindableId | undefined;
              const isCapturing = rebindable && capturingId === id;
              const overridden = rebindable && id != null && keybindings[id] != null;
              const caps = rebindable && id != null ? chordToCaps(effectiveChord(keybindings, id)) : s.keys;
              return (
                <div
                  key={s.desc}
                  style={{
                    display: "grid", gridTemplateColumns: "1fr auto", gap: 14, alignItems: "center",
                    padding: "9px 12px", borderRadius: 6,
                    background: i % 2 ? "var(--bg-panel)" : "var(--bg-elev)",
                    outline: isCapturing ? "1px solid var(--accent)" : "none",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
                    <span style={{ fontSize: 12, color: "var(--fg)" }}>{s.desc}</span>
                    <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)" }}>{s.scope}</span>
                    {overridden && (
                      <button
                        onClick={() => { resetKeybinding(id!); setError(null); }}
                        title="Reset to default"
                        style={{
                          fontSize: 9.5, fontFamily: "var(--mono)", color: "var(--fg-muted)",
                          background: "transparent", border: "none", padding: 0, cursor: "pointer",
                          textDecoration: "underline",
                        }}
                      >
                        reset
                      </button>
                    )}
                  </div>
                  {rebindable ? (
                    <button
                      onClick={() => startCapture(id!)}
                      aria-label={`Rebind ${s.desc}`}
                      title="Click to rebind, then press a key combination"
                      style={{ background: "transparent", border: "none", padding: 0, cursor: "pointer" }}
                    >
                      {isCapturing
                        ? <span style={{ fontSize: 11, fontFamily: "var(--mono)", color: "var(--accent)" }}>Press keys…</span>
                        : <Chord caps={caps} active={overridden} />}
                    </button>
                  ) : (
                    <Chord caps={caps} />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
