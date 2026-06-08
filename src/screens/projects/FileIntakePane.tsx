// File-intake pipeline screen (#604) — the drag-and-drop drop zone. Stages any
// dropped/uploaded file into the project hub under `.intake/` (binary via base64, text
// directly), classifies each, and maintains `.intake/intake.json`. Routing the staged
// files to the right repo is the planner's job (next slice); this is the intake surface.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PipelineScreenFrame } from "./PipelineScreenFrame";
import {
  classifyFile, isBinaryKind, intakeEntry, mergeIntake, serializeIntake, parseIntake,
  INTAKE_MANIFEST, type IntakeEntry, type IntakeKind,
} from "./fileIntake";
import type { PipelineScreenProps } from "./pipelineScreens";

const KIND_COLOR: Record<IntakeKind, string> = {
  image: "var(--violet, oklch(0.72 0.12 300))", vector: "var(--violet, oklch(0.72 0.12 300))",
  markup: "var(--info)", style: "var(--info)", component: "var(--accent)",
  data: "var(--success)", doc: "var(--fg-muted)", other: "var(--fg-dim)",
};

/** Read a File as standard base64 (for binary writes). */
async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function FileIntakePane({ projectKey, onClose }: PipelineScreenProps) {
  const [entries, setEntries] = useState<IntakeEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load any already-staged manifest on open.
  useEffect(() => {
    let live = true;
    invoke<[string, string][]>("read_project_files", { projectKey, subdir: ".intake" })
      .then((files) => {
        const manifest = files.find(([rel]) => rel === "intake.json")?.[1];
        if (live && manifest) setEntries(parseIntake(manifest));
      })
      .catch(() => {});
    return () => { live = false; };
  }, [projectKey]);

  async function ingest(files: File[]) {
    if (files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const added: IntakeEntry[] = [];
      for (const file of files) {
        const kind = classifyFile(file.name, file.type || undefined);
        const relpath = `.intake/${file.name}`;
        if (isBinaryKind(kind)) {
          await invoke("write_project_file_bytes", { projectKey, relpath, b64: await fileToBase64(file) });
        } else {
          await invoke("write_project_file", { projectKey, relpath, contents: await file.text() });
        }
        added.push(intakeEntry(file.name, file.size, file.type || undefined));
      }
      const merged = mergeIntake(entries, added);
      await invoke("write_project_file", { projectKey, relpath: INTAKE_MANIFEST, contents: serializeIntake(merged) });
      setEntries(merged);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PipelineScreenFrame
      label="file intake"
      statusLabel={busy ? "staging…" : entries.length ? `${entries.length} staged` : undefined}
      statusColor={busy ? "var(--accent)" : "var(--fg-dim)"}
      onClose={onClose}
    >
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, padding: 14, gap: 12, overflow: "auto" }}>
        {/* Drop zone */}
        <label
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); void ingest(Array.from(e.dataTransfer.files)); }}
          style={{
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8,
            padding: "28px 16px", borderRadius: "var(--r-lg)", cursor: "pointer", textAlign: "center",
            border: "1.5px dashed " + (dragOver ? "var(--accent)" : "var(--border)"),
            background: dragOver ? "color-mix(in oklch, var(--accent), transparent 90%)" : "var(--bg-canvas)",
          }}
        >
          <span style={{ fontSize: 22 }}>⬇</span>
          <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg)" }}>Drop design or any files here</span>
          <span className="hint">or click to browse — images, SVG, components, markup, anything</span>
          <input
            type="file" multiple style={{ display: "none" }}
            onChange={(e) => { void ingest(Array.from(e.target.files ?? [])); e.currentTarget.value = ""; }}
          />
        </label>

        {error && <div style={{ color: "var(--danger)", fontFamily: "var(--mono)", fontSize: 11 }}>{error}</div>}

        {/* Staged files */}
        {entries.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <div className="ulabel" style={{ color: "var(--fg-dim)" }}>staged · {entries.length}</div>
            {entries.map((e) => (
              <div key={e.name} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", borderRadius: 5, background: "var(--bg-canvas)", border: "1px solid var(--border-soft)" }}>
                <span className="tag" style={{ color: KIND_COLOR[e.kind], borderColor: "color-mix(in oklch," + KIND_COLOR[e.kind] + ",transparent 70%)" }}>{e.kind}</span>
                <span style={{ flex: 1, minWidth: 0, fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.name}</span>
                <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)" }}>{(e.size / 1024).toFixed(1)}k</span>
              </div>
            ))}
            <div className="hint" style={{ marginTop: 4 }}>
              Staged in the project. The planner will route these to the right repo — explicit “Route” action arrives next.
            </div>
          </div>
        )}
      </div>
    </PipelineScreenFrame>
  );
}
