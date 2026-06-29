// Context stage body (#652/#1061, split from FocusedBodies.tsx #1757) — the context-file list +
// the required-context written/missing checklist.
import type { ContextFile } from "@/features/planner/pane/projectPaneData";
import { KindDot } from "@/features/planner/pane/focusedPrimitives";

function CtxRow({ f, onToggle, onView }: { f: ContextFile; onToggle?: () => void; onView?: () => void }) {
  return (
    <div onClick={onView} style={{
      display: "flex", alignItems: "center", gap: 7, padding: "5px 7px",
      borderRadius: 5, background: f.pinned ? "var(--bg-canvas)" : "transparent",
      border: "1px solid " + (f.pinned ? "var(--border-soft)" : "transparent"),
      cursor: onView ? "pointer" : "default",
    }}>
      <KindDot kind={f.kind} />
      <span className="mono" style={{
        flex: 1, fontSize: 10, color: f.pinned ? "var(--fg)" : "var(--fg-muted)",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      }}>{f.name}</span>
      <span className="mono" style={{ fontSize: 8.5, color: "var(--fg-dim)" }}>{f.tok}</span>
      <span onClick={(e) => { e.stopPropagation(); onToggle?.(); }} className="mono" style={{
        cursor: "pointer", fontSize: 11,
        color: f.pinned ? "var(--accent)" : "var(--fg-dim)", width: 14, textAlign: "center",
      }}>
        {f.pinned ? "✦" : "+"}
      </span>
    </div>
  );
}

/** One row of the required-context checklist (#1061): names a required topic's `<topic>.md`
 *  and whether it's been written yet, so the user sees exactly which files the gate still needs. */
function RequiredCtxRow({ topic, written }: { topic: string; written: boolean }) {
  return (
    <div className="mono" style={{
      display: "flex", alignItems: "center", gap: 7, padding: "4px 7px", borderRadius: 5,
      fontSize: 10,
    }}>
      <span style={{ width: 12, textAlign: "center", color: written ? "var(--success)" : "var(--fg-dim)" }}>
        {written ? "✓" : "○"}
      </span>
      <span style={{ flex: 1, color: written ? "var(--fg-muted)" : "var(--fg)" }}>{topic}.md</span>
      {!written && (
        <span style={{ fontSize: 8.5, letterSpacing: ".04em", textTransform: "uppercase", color: "var(--danger)" }}>
          missing
        </span>
      )}
    </div>
  );
}

export function FocusedContextBody({ context, onView, requiredContext }: {
  context?: ContextFile[]; onView?: (f: ContextFile) => void; requiredContext?: string[];
}) {
  const files = context ?? [];
  const required = requiredContext ?? [];
  // A topic is satisfied once its `<topic>.md` exists (the gate keys on generation, #1028).
  const written = new Set(files.map((f) => f.name.replace(/\.md$/i, "")));
  const missingCount = required.filter((t) => !written.has(t)).length;
  if (files.length === 0 && required.length === 0) {
    return (
      <div className="empty-state">
        <span className="empty-icon">✦</span>
        <span>No context files yet</span>
      </div>
    );
  }
  const totalTok = files.reduce((s, f) => s + parseFloat(f.tok), 0);
  return (
    <div>
      {required.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", padding: "0 2px 6px", gap: 8 }}>
            <span className="ulabel">required files</span>
            <span style={{ flex: 1 }} />
            <span className="mono" style={{
              fontSize: 9,
              color: missingCount === 0 ? "var(--success)" : "var(--fg-dim)",
            }}>
              {required.length - missingCount}/{required.length} written
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {required.map((t) => <RequiredCtxRow key={t} topic={t} written={written.has(t)} />)}
          </div>
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", padding: "0 2px 8px", gap: 8 }}>
        <span className="ulabel">context files</span>
        <span style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 9, color: "var(--accent)" }}>
          {totalTok.toFixed(1)}k / 200k tok
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {files.map((f) => <CtxRow key={f.name} f={f} onView={onView ? () => onView(f) : undefined} />)}
      </div>
    </div>
  );
}
