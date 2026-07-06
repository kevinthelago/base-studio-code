// File-intake pipeline screen (#604) — the drag-and-drop drop zone. Stages any
// dropped/uploaded file into the project hub under `.intake/` (binary via base64, text
// directly), classifies each, and maintains `.intake/intake.json`. Routing the staged
// files to the right repo is the planner's job (next slice); this is the intake surface.

import { useEffect, useRef, useState } from "react";
import { Chip } from "@/shared/ui/data/Chip";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { SectionLabel } from "@/shared/ui/layout/SectionLabel";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { invoke } from "@tauri-apps/api/core";
import { StageScreenFrame } from "../preview/StageScreenFrame";
import {
  classifyFile, isBinaryKind, intakeEntry, mergeIntake, serializeIntake, parseIntake, hashContent,
  INTAKE_DIR, INTAKE_MANIFEST, type IntakeEntry, type IntakeKind,
} from "../lib/fileIntake";
import type { StageScreenProps } from "../preview/stageScreens";
import { collectDroppedEntries, type FsEntryLike, type DroppedFile } from "../lib/dropFiles";

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

export function FileIntakePane({ projectKey, onClose }: StageScreenProps) {
  const [entries, setEntries] = useState<IntakeEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
        // Hash the exact content we stage, so a later re-drop of an edited file is detected as
        // changed and re-routed on triage (#2097).
        let hash: string;
        if (isBinaryKind(kind)) {
          const b64 = await fileToBase64(file);
          await invoke("write_project_file_bytes", { projectKey, relpath, b64 });
          hash = hashContent(b64);
        } else {
          const text = await file.text();
          await invoke("write_project_file", { projectKey, relpath, contents: text });
          hash = hashContent(text);
        }
        added.push(intakeEntry(path, file.size, hash, file.type || undefined));
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
    <StageScreenFrame
      label="file intake"
      statusLabel={busy ? "staging…" : entries.length ? `${entries.length} staged` : undefined}
      statusColor={busy ? "var(--accent)" : "var(--fg-dim)"}
      onClose={onClose}
      fullWidth
      bare
    >
      <Stack gap={12} style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
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
          <Text as="span" size={22}>⬇</Text>
          <Box as="span" className="mono-value">Drop design files or a folder here</Box>
          <Box as="span" className="hint">or click to browse a folder — images, SVG, components, markup, anything</Box>
          {/* The drop box IS the browse affordance: clicking it opens the native folder picker
              (webkitdirectory is set on this input via the effect above). Files can also be dragged in. */}
          {/* eslint-disable-next-line no-restricted-syntax -- native file-picker input (type=file + imperative webkitdirectory); no primitive covers it */}
          <input ref={folderInputRef} type="file" multiple style={{ display: "none" }} onChange={onPick} />
        </label>

        {error &&<Text as="div" mono size={11} tone="danger">{error}</Text>}

        {/* Staged files */}
        {entries.length > 0 && (
          <Stack gap={5}>
            <SectionLabel size={9.5}>staged · {entries.length}</SectionLabel>
            {entries.map((e) => (
              <Row key={e.name} gap={8} style={{ padding: "5px 8px", borderRadius: 5, background: "var(--bg-canvas)", border: "1px solid var(--border-soft)" }}>
                <Chip style={{ color: KIND_COLOR[e.kind], borderColor: "color-mix(in oklch," + KIND_COLOR[e.kind] + ",transparent 70%)" }}>{e.kind}</Chip>
                <Box as="span" className="mono" style={{ flex: 1, minWidth: 0, fontSize: 11, color: "var(--fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.name}</Box>
                <Text as="span" mono size={9.5} tone="dim">{(e.size / 1024).toFixed(1)}k</Text>
              </Row>
            ))}
            {/* No route control of any kind lives inside the pane (#2121). Routing is driven entirely
                by the UI stage's footer action; the actual per-repo routing happens change-aware on
                triage (#2097). This surface is intake-only. */}
          </Stack>
        )}
      </Stack>
    </StageScreenFrame>
  );
}
