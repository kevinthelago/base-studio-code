// File-intake pipeline screen (#604) — the drag-and-drop drop zone. Stages any
// dropped/uploaded file into the project hub under `.intake/` (binary via base64, text
// directly), classifies each, and maintains `.intake/intake.json`. Routing the staged
// files to the right repo is the planner's job (next slice); this is the intake surface.

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import { PipelineScreenFrame } from "../grading/PipelineScreenFrame";
import {
  classifyFile, isBinaryKind, intakeEntry, mergeIntake, serializeIntake, parseIntake,
  INTAKE_DIR, INTAKE_MANIFEST, ROUTE_PROMPT, type IntakeEntry, type IntakeKind,
} from "../shared/fileIntake";
import type { PipelineScreenProps } from "../grading/pipelineScreens";
import { collectDroppedEntries, type FsEntryLike, type DroppedFile } from "../shared/dropFiles";

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
  const requestPlannerPrompt = useAppStore((s) => s.requestPlannerPrompt);
  const confirmPlanSection = useAppStore((s) => s.confirmPlanSection);
  const [entries, setEntries] = useState<IntakeEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [routed, setRouted] = useState(false);
  // A second hidden input with `webkitdirectory` — the native FOLDER picker (#831). The
  // attribute isn't in React's input types, so it's set imperatively once mounted.
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const el = folderInputRef.current;
    if (el) { el.setAttribute("webkitdirectory", ""); el.setAttribute("directory", ""); }
  }, []);

  // Stage the files chosen by either browse input — `webkitRelativePath` carries the folder
  // structure when a directory was picked, else just the file name.
  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    void ingest(Array.from(e.target.files ?? []).map((file) => ({ file, path: file.webkitRelativePath || file.name })));
    e.currentTarget.value = "";
  };

  // Load any already-staged manifest on open.
  useEffect(() => {
    let live = true;
    invoke<[string, string][]>("read_project_files", { projectKey, subdir: INTAKE_DIR })
      .then((files) => {
        const manifest = files.find(([rel]) => rel === "intake.json")?.[1];
        if (live && manifest) setEntries(parseIntake(manifest));
      })
      .catch(() => {});
    return () => { live = false; };
  }, [projectKey]);

  // Stage a set of dropped files, each carrying its path relative to the drop root so a
  // dropped FOLDER's structure is preserved under design/ (#831).
  async function ingest(dropped: DroppedFile[]) {
    if (dropped.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const added: IntakeEntry[] = [];
      for (const { file, path } of dropped) {
        const kind = classifyFile(file.name, file.type || undefined);
        const relpath = `${INTAKE_DIR}/${path}`;
        if (isBinaryKind(kind)) {
          await invoke("write_project_file_bytes", { projectKey, relpath, b64: await fileToBase64(file) });
        } else {
          await invoke("write_project_file", { projectKey, relpath, contents: await file.text() });
        }
        added.push(intakeEntry(path, file.size, file.type || undefined));
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

  // Handle a drop: a dropped FOLDER is not in `dataTransfer.files` — it's reachable only via
  // `webkitGetAsEntry()`, which must be called SYNCHRONOUSLY (the DataTransfer is only valid
  // during the event). Capture the entries first, then walk them async (#831). Falls back to
  // the flat file list when the entry API is unavailable.
  function onDropFiles(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const items = Array.from(e.dataTransfer.items ?? []);
    const entriesIn = items
      .map((it) => (typeof it.webkitGetAsEntry === "function" ? it.webkitGetAsEntry() : null))
      .filter((en): en is FileSystemEntry => en != null);
    if (entriesIn.length > 0) {
      void collectDroppedEntries(entriesIn as unknown as FsEntryLike[]).then(ingest);
    } else {
      void ingest(Array.from(e.dataTransfer.files).map((file) => ({ file, path: file.name })));
    }
  }

  return (
    <PipelineScreenFrame
      label="file intake"
      statusLabel={busy ? "staging…" : entries.length ? `${entries.length} staged` : undefined}
      statusColor={busy ? "var(--accent)" : "var(--fg-dim)"}
      onClose={onClose}
      fullWidth
      bare
    >
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, gap: 12, overflow: "auto" }}>
        {/* Drop zone */}
        <label
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDropFiles}
          style={{
            flex: 1, minHeight: 0,
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8,
            padding: "28px 16px", borderRadius: "var(--r-lg)", cursor: "pointer", textAlign: "center",
            border: "1.5px dashed " + (dragOver ? "var(--accent)" : "var(--border)"),
            background: dragOver ? "color-mix(in oklch, var(--accent), transparent 90%)" : "var(--bg-canvas)",
          }}
        >
          <span style={{ fontSize: 22 }}>⬇</span>
          <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg)" }}>Drop design files or a folder here</span>
          <span className="hint">or click to browse a folder — images, SVG, components, markup, anything</span>
          {/* The drop box IS the browse affordance: clicking it opens the native folder picker
              (webkitdirectory is set on this input via the effect above). Files can also be dragged in. */}
          <input ref={folderInputRef} type="file" multiple style={{ display: "none" }} onChange={onPick} />
        </label>

        {error &&<div style={{ color: "var(--danger)", fontFamily: "var(--mono)", fontSize: 11 }}>{error}</div>}

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
            <button
              className="btn primary"
              style={{ marginTop: 6, width: "100%", justifyContent: "center" }}
              disabled={busy}
              onClick={() => {
                requestPlannerPrompt(projectKey, ROUTE_PROMPT);
                // Routing the design to the project completes the UI stage (#837).
                confirmPlanSection(projectKey, "ui");
                setRouted(true);
              }}
            >Route to project →</button>
            {routed && (
              <div className="hint" style={{ color: "var(--success)" }}>
                Sent to the planner — it will classify each file and route it to the right repo (it may ask you when a destination is ambiguous).
              </div>
            )}
          </div>
        )}
      </div>
    </PipelineScreenFrame>
  );
}
