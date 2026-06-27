// Blueprint gist + create modals (#609 slice 5) — ported from the design's gist.jsx.
// Faithful UI; the side-effecting flows (publish / import) take async callbacks so the
// page shell can wire them to the real gist client (gist.ts) while these stay testable.

import { useState, type ReactNode } from "react";
import "../../../styles/blueprints.css";
import { ModalScrim } from "@/shared/ui/ModalScrim";
import { Ic } from "./blueprintIcons";
import { IconButton } from "@/shared/ui/IconButton";
import { stageKind, tint, hue } from "./blueprintCatalog";
import { type Blueprint, type BlueprintStage } from "../stages/blueprints";
import { type SkillPayload } from "./blueprintSkills";

/** A resolved import/preview blueprint (subset enough to preview + import). */
export interface PreviewBlueprint {
  name: string; icon: string; h: number; author?: string; rev?: string; sections: BlueprintStage[];
  /** The upstream gist id this preview came from (#955) — recorded on import so a re-import is
   *  recognized (dedupe → update in place) and the import page can show its sync state. */
  gistId?: string;
  /** The fully-coerced blueprint (#897) — carried so import preserves blueprint-wide
   *  skills/mcp/category/mode instead of reconstructing from the lossy preview subset. */
  blueprint?: Blueprint;
  /** Skill content embedded in the share (#897 Phase 5b) — reconstituted into the library on import. */
  bundled?: SkillPayload[];
}

function Modal({ icon, iconBg, iconColor, title, sub, onClose, children, foot, lg }: {
  icon: ReactNode; iconBg?: string; iconColor?: string; title: string; sub?: string;
  onClose: () => void; children: ReactNode; foot?: ReactNode; lg?: boolean;
}) {
  return (
    <div className="bp-page" style={{ position: "fixed", inset: 0 }}>
      <ModalScrim onDismiss={onClose} blur style={{ padding: 30 }}>
        <div className="modal" style={{ width: lg ? 720 : 540, maxWidth: "100%", maxHeight: "88vh", display: "flex", flexDirection: "column", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: "var(--r-lg)", boxShadow: "0 24px 70px rgba(0,0,0,.55)", overflow: "hidden" }}>
          <div className="modal-head" style={{ display: "flex", alignItems: "center", gap: 11, padding: "16px 20px", borderBottom: "1px solid var(--border-soft)" }}>
            <span className="mh-ico" style={{ width: 30, height: 30, flex: "0 0 30px", borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--mono)", fontWeight: 700, fontSize: 13, background: iconBg ?? "color-mix(in oklch, var(--accent), transparent 84%)", color: iconColor ?? "var(--accent)" }}>{icon}</span>
            <div><h2 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 14, fontWeight: 600 }}>{title}</h2>{sub && <div style={{ fontSize: 10.5, color: "var(--fg-dim)", marginTop: 1 }}>{sub}</div>}</div>
            <IconButton aria-label="close" style={{ marginLeft: "auto" }} onClick={onClose} />
          </div>
          <div className="modal-body" style={{ padding: 20, overflowY: "auto" }}>{children}</div>
          {foot && <div className="modal-foot" style={{ display: "flex", alignItems: "center", gap: 9, padding: "14px 20px", borderTop: "1px solid var(--border-soft)" }}>{foot}</div>}
        </div>
      </ModalScrim>
    </div>
  );
}

export function StageSummary({ sections }: { sections: BlueprintStage[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {sections.map((s, i) => {
        const k = stageKind(s.key);
        const caps = (s.skills?.length ?? 0) + (s.mcp?.length ?? 0);
        return (
          <div key={s.uid ?? i} style={{ display: "flex", flexDirection: "column", gap: 4, padding: "5px 0" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
              <span className="mono dim" style={{ fontSize: 9.5, width: 16 }}>{String(i + 1).padStart(2, "0")}</span>
              <span style={{ width: 22, height: 22, flex: "0 0 22px", borderRadius: 5, background: tint(k.h, 0.16), color: hue(k.h), display: "flex", alignItems: "center", justifyContent: "center" }}><Ic n={k.glyph} size={13} /></span>
              <span className="mono" style={{ fontSize: 11.5, color: "var(--fg)" }}>{s.name}</span>
              <span style={{ flex: 1 }} />
              {caps > 0 && <span className="hint mono">{caps} attached</span>}
              {s.gateRule && <span className="tag amber">gate</span>}
            </div>
            {/* The prompt is the substance of the stage (#1268) — dense text under the row, the
                icon as its index. pre-wrap keeps the prompt's own line breaks. */}
            {s.prompt?.trim() && (
              <div style={{ marginLeft: 25, fontFamily: "var(--mono)", fontSize: 10, lineHeight: 1.5, color: "var(--fg-dim)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {s.prompt.trim()}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ── Import ── */
export function ImportModal({ onClose, onResolve, onImport }: {
  onClose: () => void;
  onResolve: (ref: string) => Promise<PreviewBlueprint>;
  onImport: (preview: PreviewBlueprint) => void;
}) {
  const [val, setVal] = useState("");
  const [phase, setPhase] = useState<"input" | "loading" | "preview" | "error">("input");
  const [preview, setPreview] = useState<PreviewBlueprint | null>(null);
  const [err, setErr] = useState("");

  async function resolve() {
    if (!val.trim()) return;
    setPhase("loading");
    try { setPreview(await onResolve(val.trim())); setPhase("preview"); }
    catch (e) { setErr(String(e)); setPhase("error"); }
  }

  return (
    <Modal icon={<Ic n="cloud_download" size={15} />} title="Import from gist" sub="Pull a blueprint someone shared with you" onClose={onClose}
      foot={phase === "preview" && preview
        ? <><span className="hint">Imports as a linked copy — you can sync upstream later</span><span style={{ flex: 1 }} /><button className="btn ghost" onClick={() => setPhase("input")}>Back</button><button className="btn primary" onClick={() => onImport(preview)}>Import to library</button></>
        : <><span style={{ flex: 1 }} /><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!val.trim() || phase === "loading"} onClick={resolve}>{phase === "loading" ? "Resolving…" : "Resolve gist"}</button></>}>
      {phase === "preview" && preview ? (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <span className="bp-icon" style={{ width: 30, height: 30, flex: "0 0 30px", fontSize: 14, background: tint(preview.h, 0.16), color: hue(preview.h), display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 8, fontFamily: "var(--mono)", fontWeight: 700 }}>{preview.icon}</span>
            <div><div className="mono" style={{ fontSize: 13, fontWeight: 600 }}>{preview.name}</div><div className="hint mono">{preview.author ? `by ${preview.author} · ` : ""}{preview.rev ? `revision ${preview.rev} · ` : ""}{preview.sections.length} stages</div></div>
            <span style={{ flex: 1 }} /><span className="tag info">valid blueprint</span>
          </div>
          <div className="card" style={{ padding: 13 }}><StageSummary sections={preview.sections} /></div>
        </>
      ) : (
        <div className="field">
          <label style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-muted)", textTransform: "uppercase", letterSpacing: ".06em" }}>Gist URL or ID</label>
          <input className="input" autoFocus style={{ marginTop: 6 }} placeholder="gist.github.com/user/a91f3c0e7  ·  or  ·  a91f3c0e7"
            value={val} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void resolve(); }} />
          <div className="hint" style={{ marginTop: 6 }}>Paste a full URL or the raw gist ID.</div>
          {phase === "error" && <div style={{ color: "var(--danger)", fontFamily: "var(--mono)", fontSize: 11, marginTop: 10 }}>Couldn't resolve: {err}</div>}
        </div>
      )}
    </Modal>
  );
}
