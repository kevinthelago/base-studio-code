import { useState, useEffect, useRef, useCallback, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import ReactMarkdown from "react-markdown";
import { log } from "../lib/log";
import { useAppStore } from "../store";
import {
  scopeToProject, selectDocuments, collectTags, groupByKind,
  DOC_FILTERS, kindLabel,
  type Doc, type DocFilter, type DocKind,
} from "../lib/documents";
import { useDragResize } from "../hooks/useDragResize";

const KB_PANE_ID = "kb";

const TERM_THEME: import("@xterm/xterm").ITheme = {
  background:          "#181a1f",
  foreground:          "#eeeae4",
  cursor:              "#c4923a",
  cursorAccent:        "#181a1f",
  selectionBackground: "#c4923a44",
  black:               "#181a1f", brightBlack:   "#44474f",
  red:                 "#d4554f", brightRed:     "#e06c75",
  green:               "#5fb467", brightGreen:   "#98c379",
  yellow:              "#c4923a", brightYellow:  "#e5c07b",
  blue:                "#5694c7", brightBlue:    "#61afef",
  magenta:             "#9b59b6", brightMagenta: "#c678dd",
  cyan:                "#4aabb5", brightCyan:    "#64d5e4",
  white:               "#939aa4", brightWhite:   "#eeeae4",
};

/** Token color per document kind, for the list/preview badges. */
const KIND_COLOR: Record<DocKind, string> = {
  reusable: "var(--info)",
  project:  "var(--accent)",
  repo:     "var(--success)",
};

function KindBadge({ kind, project, repo }: { kind: DocKind; project: string | null; repo: string | null }) {
  const color = KIND_COLOR[kind];
  const text = kind === "repo" && repo
    ? repo
    : (kind === "project" && project ? project : kindLabel(kind));
  return (
    <span style={{
      display: "inline-flex", alignItems: "center",
      padding: "0 5px", borderRadius: 3, maxWidth: 110,
      fontFamily: "var(--mono)", fontSize: 9, lineHeight: "15px",
      color, background: `color-mix(in oklch, ${color}, transparent 88%)`,
      border: `1px solid color-mix(in oklch, ${color}, transparent 72%)`,
      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
    }}>{text}</span>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}b`;
  return `${(bytes / 1024).toFixed(1)}k`;
}

function formatAge(secs: number): string {
  if (secs === 0) return "";
  const delta = Math.floor(Date.now() / 1000) - secs;
  if (delta < 60) return `${delta}s`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h`;
  return `${Math.floor(delta / 86400)}d`;
}

// Built-in dangerous commands always blocked in spawned sessions — display copy
// of the backend's DEFAULT_DENY (keep roughly in sync; this list is informational).
const BUILTIN_BLOCKED = [
  "sudo", "rm -rf /", "rm -rf ~", "dd", "mkfs", "shutdown", "reboot",
  "git push --force", "curl … | sh",
];

// The command-policy editor surfaced as the Knowledge Base → Commands section.
// Sessions allow the Bash tool broadly (so loops and compound commands run
// without a prompt); a curated built-in deny-list plus the user's blocks below
// guard against dangerous commands (deny wins over allow). The allow list is the
// global tier that combines with per-project/repo commands set in the planner.
function CommandsPanel() {
  const {
    allowedCommands, addAllowedCommand, removeAllowedCommand,
    deniedCommands, addDeniedCommand, removeDeniedCommand,
  } = useAppStore();
  const [allowDraft, setAllowDraft] = useState("");
  const [denyDraft, setDenyDraft] = useState("");

  const chips = (
    items: string[],
    onRemove: (c: string) => void,
    color: string,
    empty: string,
  ) => (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 5, minHeight: 22, alignItems: "center" }}>
      {items.length === 0 && <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-dim)", fontStyle: "italic" }}>{empty}</span>}
      {items.map(c => (
        <span key={c} style={{
          display: "inline-flex", alignItems: "center", gap: 5, padding: "2px 8px", borderRadius: 4,
          background: "var(--bg-canvas)", border: "1px solid var(--border)",
          fontFamily: "var(--mono)", fontSize: 10.5, color,
        }}>
          {c}
          <span onClick={() => onRemove(c)} style={{ cursor: "pointer", color: "var(--fg-dim)", lineHeight: 1 }}>×</span>
        </span>
      ))}
    </div>
  );

  const adder = (draft: string, setDraft: (v: string) => void, onAdd: (c: string) => void, placeholder: string) => (
    <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
      <input
        className="input"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter" && draft.trim()) { e.preventDefault(); onAdd(draft.trim()); setDraft(""); } }}
        placeholder={placeholder}
        style={{ flex: 1, height: 26, fontFamily: "var(--mono)", fontSize: 10.5 }}
      />
      <button className="btn" onClick={() => { if (draft.trim()) { onAdd(draft.trim()); setDraft(""); } }} style={{ height: 26, fontSize: 10.5 }}>+ add</button>
    </div>
  );

  const card = (title: string, sub: string, body: ReactNode) => (
    <div className="card" style={{ padding: "14px 16px" }}>
      <h3 style={{ margin: "0 0 4px", fontSize: 13 }}>{title}</h3>
      <p style={{ margin: "0 0 10px", color: "var(--fg-muted)", fontSize: 11.5, lineHeight: 1.6 }}>{sub}</p>
      {body}
    </div>
  );

  return (
    <div style={{ flex: 1, overflow: "auto", padding: "18px 22px" }}>
      <div style={{ maxWidth: 720, display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <h2 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 16, fontWeight: 600 }}>Commands</h2>
          <p style={{ color: "var(--fg-muted)", fontSize: 12, marginTop: 4, lineHeight: 1.6 }}>
            Project and triage sessions can run shell commands freely — including loops and
            piped/compound commands — so agents start working without permission prompts. A
            curated set of dangerous commands is always blocked, and you can block or pin more here.
          </p>
        </div>

        {card(
          "Always blocked",
          "Built-in — these dangerous commands are denied in every session (deny overrides allow). Best-effort against direct invocations.",
          chips(BUILTIN_BLOCKED, () => {}, "var(--danger)", ""),
        )}

        {card(
          "Also block",
          "Additional commands to deny everywhere (e.g. scp, kubectl, terraform). Applied to new sessions.",
          <>{chips(deniedCommands, removeDeniedCommand, "var(--danger)", "nothing extra blocked")}
            {adder(denyDraft, setDenyDraft, c => addDeniedCommand(c), "block a command…")}</>,
        )}

        {card(
          "Always allowed (global)",
          "Pinned as explicitly allowed across every project. Per-project and per-repo commands are added in a project's planner; they combine with this list.",
          <>{chips(allowedCommands, removeAllowedCommand, "var(--accent)", "Bash is allowed broadly by default")}
            {adder(allowDraft, setAllowDraft, c => addAllowedCommand(c.toLowerCase()), "allow a command…")}</>,
        )}
      </div>
    </div>
  );
}

/**
 * Empty-state copy for the document list (#323). Distinguishes a genuine
 * first-run (no documents at all — offer to set up the workspace + create a
 * block) from a filter/search that simply matched nothing, with per-facet copy
 * so the user knows *why* the list is empty.
 */
function KbEmptyState({
  docCount, workspaceReady, projectScoped, filter, tags, query, onSetupWorkspace,
}: {
  docCount: number;
  workspaceReady: boolean;
  projectScoped: boolean;
  filter: DocFilter;
  tags: string[];
  query: string;
  onSetupWorkspace: () => void;
}) {
  const wrap = (children: ReactNode) => (
    <div style={{
      padding: "28px 18px", fontFamily: "var(--mono)", fontSize: 11,
      color: "var(--fg-dim)", textAlign: "center", lineHeight: 1.8,
      display: "flex", flexDirection: "column", alignItems: "center", gap: 10,
    }}>{children}</div>
  );

  // First run: the store holds nothing at all.
  if (docCount === 0) {
    return wrap(
      <>
        <div style={{ fontSize: 22, opacity: 0.5 }}>📚</div>
        <div style={{ color: "var(--fg-muted)" }}>Your knowledge base is empty.</div>
        <div>Ask Claude in the panel to the right to draft your first block —{"\n"}reusable conventions, GitHub Actions templates, review checklists.</div>
        {!workspaceReady && (
          <button className="btn" onClick={onSetupWorkspace} style={{ fontSize: 10.5, marginTop: 2 }}>
            set up workspace
          </button>
        )}
      </>,
    );
  }

  // Has docs, but the active filter/search hid them all.
  if (query.trim()) return wrap(<>No documents match “{query.trim()}”.</>);
  if (tags.length > 0) return wrap(<>No documents carry {tags.map(t => `#${t}`).join(" + ")}.</>);
  if (projectScoped) return wrap(<>No documents for this project yet.</>);
  if (filter !== "all") return wrap(<>No {kindLabel(filter)} documents yet.</>);
  return wrap(<>No matches.</>);
}

export function KnowledgeStoreScreen() {
  // When navigated from a project, scope the list to that project's documents.
  const { kbProjectScope, setKbProjectScope } = useAppStore();
  const [docs, setDocs]             = useState<Doc[]>([]);
  // Commands section: swaps the main area to the command-policy editor.
  const [showCommands, setShowCommands] = useState(false);
  const [filter, setFilter]         = useState<DocFilter>("all");
  const [search, setSearch]         = useState("");
  // Search is debounced (#321): the input updates `search` immediately for a
  // responsive box, while `debouncedSearch` drives the (body-reading) filter.
  const [debouncedSearch, setDebouncedSearch] = useState("");
  // Tag/stack facet (#320): the selected tags narrow the list (AND semantics).
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  // Lazy body cache (#321): full-text search reads document bodies, which the
  // backend's list_documents does not return. Bodies are fetched on demand only
  // while a query is active and cached by relpath; selecting a doc also fills it.
  const [bodies, setBodies] = useState<Record<string, string>>({});
  const [selectedPath, setSelected] = useState<string | null>(null);
  const [preview, setPreview]       = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [kbDir, setKbDir]           = useState<string>("");
  // Manual editor: when editing, the preview swaps to a textarea seeded with the
  // current content; Save writes it back via write_document and refreshes.
  const [editing, setEditing]       = useState(false);
  const [editText, setEditText]     = useState("");
  const [saving, setSaving]         = useState(false);
  const [saveError, setSaveError]   = useState<string | null>(null);

  // Resizable panels (#43): the document list width (horizontal) and, when a
  // document is open, the preview height above the Claude terminal (vertical).
  const list        = useDragResize({ initial: 248, min: 190, max: 480, axis: "x" });
  const previewPane = useDragResize({ initial: 280, min: 140, max: 560, axis: "y" });

  const containerRef  = useRef<HTMLDivElement>(null);
  const termRef       = useRef<Terminal | null>(null);
  const fitRef        = useRef<FitAddon | null>(null);
  const unlistenData  = useRef<UnlistenFn | null>(null);
  const unlistenExit  = useRef<UnlistenFn | null>(null);
  const kbDirRef      = useRef("");

  // Welcome message: sent once on a fresh session when no user articles exist.
  // claudeReadyRef becomes true after the OSC100 "run" signal (claude started).
  // A 1s silence timer then fires; if still no user articles, we send the intro.
  const isNewSessionRef  = useRef(false);
  const claudeReadyRef   = useRef(false);
  const welcomeSentRef   = useRef(false);
  const silenceTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The Claude session only authors reusable docs, so the welcome keys off those.
  const hasUserDocsRef   = useRef(false);
  useEffect(() => {
    hasUserDocsRef.current = docs.some(d => d.kind === "reusable");
  }, [docs]);

  const selected = selectedPath ? docs.find(d => d.relpath === selectedPath) ?? null : null;
  // A project scope overrides the source chips: show only that project's docs;
  // otherwise the source-kind filter applies. The tag facet + debounced
  // free-text query (incl. body) narrow either set.
  const scoped = kbProjectScope ? scopeToProject(docs, kbProjectScope.keys) : docs;
  const tagOptions = collectTags(scoped);
  const filtered = selectDocuments(
    scoped,
    { filter: kbProjectScope ? "all" : filter, tags: selectedTags, query: debouncedSearch },
    bodies,
  );
  // Render grouped under reusable / project / repo headers (#320). When a single
  // kind is selected the helper naturally collapses to one group.
  const groups = groupByKind(filtered);

  // Debounce the search box (#321) so each keystroke doesn't re-scan bodies.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search), 200);
    return () => clearTimeout(id);
  }, [search]);

  // Drop tag selections that no longer exist in the current doc set.
  useEffect(() => {
    setSelectedTags(prev => prev.filter(t => tagOptions.includes(t)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tagOptions.join(" ")]);

  // ── Document list polling ────────────────────────────────────────────────────
  const refreshDocs = useCallback(async () => {
    try {
      const result = await invoke<Doc[]>("list_documents");
      setDocs(result);
    } catch {
      // dir may not exist yet
    }
  }, []);

  useEffect(() => {
    refreshDocs();
    const id = setInterval(refreshDocs, 3000);
    return () => clearInterval(id);
  }, [refreshDocs]);

  // ── Lazy body fetch for full-text search (#321) ─────────────────────────────
  // Only pay the read cost while a query is active: fetch the body of every doc
  // not already cached, in parallel, and merge into the cache. Bounded by the KB
  // size; bodies persist so a refined query reuses them.
  useEffect(() => {
    if (!debouncedSearch.trim()) return;
    const missing = docs.filter(d => bodies[d.relpath] === undefined);
    if (missing.length === 0) return;
    let cancelled = false;
    Promise.all(
      missing.map(d =>
        invoke<string>("read_document", { relpath: d.relpath })
          .then(content => [d.relpath, content] as const)
          .catch(() => [d.relpath, ""] as const),
      ),
    ).then(pairs => {
      if (cancelled) return;
      setBodies(prev => {
        const next = { ...prev };
        for (const [rel, content] of pairs) next[rel] = content;
        return next;
      });
    });
    return () => { cancelled = true; };
  }, [debouncedSearch, docs, bodies]);

  // ── Preview when a document is selected ─────────────────────────────────────
  useEffect(() => {
    // Selecting a different document cancels any in-progress edit.
    setEditing(false);
    setSaveError(null);
    if (!selectedPath) { setPreview(null); return; }
    setPreviewLoading(true);
    invoke<string>("read_document", { relpath: selectedPath })
      .then(content => {
        setPreview(content);
        // Fill the search body cache for free while we have the content.
        setBodies(prev => ({ ...prev, [selectedPath]: content }));
      })
      .catch(() => setPreview(null))
      .finally(() => setPreviewLoading(false));
  }, [selectedPath]);

  // Live generation → preview (#322): when the open document is regenerated on
  // disk (the embedded Claude session writes it; refreshDocs bumps modified_secs),
  // re-read it into the preview so the new content lands without reselecting.
  // Suppressed while editing so it can't clobber unsaved edits.
  const selectedModified = selected?.modified_secs ?? 0;
  useEffect(() => {
    if (!selectedPath || editing || selectedModified === 0) return;
    invoke<string>("read_document", { relpath: selectedPath })
      .then(content => {
        setPreview(content);
        setBodies(prev => ({ ...prev, [selectedPath]: content }));
      })
      .catch(() => { /* keep the current preview on a transient read error */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedModified]);

  // Unsaved-changes guard (#322): true while the editor holds edits not yet
  // written. Navigating away (selecting another doc, closing the preview) asks
  // for confirmation first so a generation/edit isn't silently discarded.
  const dirty = editing && editText !== (preview ?? "");
  const confirmDiscard = useCallback(() => {
    if (!dirty) return true;
    return window.confirm("Discard unsaved changes to this document?");
  }, [dirty]);
  /** Select a document, guarding any unsaved edit first. */
  const selectDoc = useCallback((relpath: string | null) => {
    if (!confirmDiscard()) return;
    setShowCommands(false);
    setSelected(relpath);
  }, [confirmDiscard]);

  // ── Manual editor handlers ──────────────────────────────────────────────────
  function startEdit() {
    setEditText(preview ?? "");
    setSaveError(null);
    setEditing(true);
  }

  async function saveEdit() {
    if (!selectedPath || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await invoke("write_document", { relpath: selectedPath, content: editText });
      setPreview(editText);
      setEditing(false);
      refreshDocs();
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }

  // ── PTY terminal (mounts once for the lifetime of this screen) ───────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const term = new Terminal({
      theme: TERM_THEME,
      fontFamily: '"JetBrains Mono", monospace',
      fontSize: 12,
      lineHeight: 1.4,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 10000,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(el);
    termRef.current = term;
    fitRef.current  = fitAddon;

    term.onData(data => {
      invoke("pty_write", { paneId: KB_PANE_ID, data }).catch(console.error);
    });

    // OSC 100: claude() shell wrapper signals process start ("run").
    // On a fresh session with no articles, we arm a silence timer and send
    // a one-shot welcome prompt once Claude reaches its interactive prompt.
    term.parser.registerOscHandler(100, (data) => {
      if (data === "run" && isNewSessionRef.current) {
        claudeReadyRef.current = true;
      }
      return true;
    });

    let destroyed = false;
    requestAnimationFrame(async () => {
      if (destroyed) return;
      fitAddon.fit();

      unlistenData.current = await listen<string>(`pty_data_${KB_PANE_ID}`, ev => {
        term.write(ev.payload);
        // Arm silence timer once claude has started — fires when output goes quiet
        // (i.e. Claude is at its interactive prompt and ready for input).
        if (claudeReadyRef.current && !welcomeSentRef.current) {
          if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
          silenceTimerRef.current = setTimeout(() => {
            silenceTimerRef.current = null;
            if (!hasUserDocsRef.current && !welcomeSentRef.current) {
              welcomeSentRef.current = true;
              invoke("pty_write", {
                paneId: KB_PANE_ID,
                data: "Please introduce yourself briefly — let the user know you can help them create, edit, and organize knowledge base articles.\r",
              }).catch(console.error);
            }
          }, 1000);
        }
      });
      unlistenExit.current = await listen<unknown>(`pty_exit_${KB_PANE_ID}`, () => {
        term.write("\r\n\x1b[33m[session ended — press ↺ restart to begin a new one]\x1b[0m\r\n");
      });

      const dir = await invoke<string>("setup_kb_workspace").catch((e: unknown) => {
        log.error(`kb workspace setup failed: ${e}`);
        return "";
      });
      kbDirRef.current = dir;
      setKbDir(dir);

      const isNew = await invoke<boolean>("pty_create", {
        paneId:  KB_PANE_ID,
        cols:    term.cols,
        rows:    term.rows,
        cwd:     dir,
        initCmd: "claude --continue 2>/dev/null || claude",
        env:     {},
      }).catch(() => true);
      isNewSessionRef.current = !!isNew;
      // Reconnecting to a surviving session (remount / HMR) — Ctrl+L repaints the
      // prompt into the fresh terminal without submitting anything.
      if (!isNew) {
        invoke("pty_write", { paneId: KB_PANE_ID, data: "\x0c" }).catch(console.error);
      }
    });

    const ro = new ResizeObserver(() => {
      const { clientWidth, clientHeight } = el;
      if (clientWidth === 0 || clientHeight === 0) return;
      fitAddon.fit();
      invoke("pty_resize", { paneId: KB_PANE_ID, cols: term.cols, rows: term.rows }).catch(console.error);
    });
    ro.observe(el);

    return () => {
      destroyed = true;
      if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
      unlistenData.current?.();
      unlistenExit.current?.();
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current  = null;
      // PTY session intentionally kept alive — reconnects on remount (same as the
      // console TerminalView). The ↺ restart button is the only path that kills it.
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // First-run setup (#323): (re)create the KB workspace on demand from the empty
  // state, in case the mount-time setup failed (e.g. the dir was absent).
  async function handleSetupWorkspace() {
    const dir = await invoke<string>("setup_kb_workspace").catch((e: unknown) => {
      log.error(`kb workspace setup failed: ${e}`);
      return "";
    });
    if (dir) { kbDirRef.current = dir; setKbDir(dir); }
    refreshDocs();
  }

  async function handleRestart() {
    const term = termRef.current;
    if (!term || restarting) return;
    setRestarting(true);
    if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
    claudeReadyRef.current  = false;
    welcomeSentRef.current  = false;
    term.clear();
    await invoke("pty_kill", { paneId: KB_PANE_ID }).catch(console.error);
    const dir = kbDirRef.current;
    const isNew = await invoke<boolean>("pty_create", {
      paneId:  KB_PANE_ID,
      cols:    term.cols,
      rows:    term.rows,
      cwd:     dir,
      initCmd: "claude",
      env:     {},
    }).catch(() => true);
    isNewSessionRef.current = !!isNew;
    setRestarting(false);
  }

  return (
    <div style={{ flex: 1, display: "flex", minHeight: 0 }}>

      {/* ── Document list ────────────────────────────────────────────────────── */}
      <aside style={{
        width: list.size, flex: `0 0 ${list.size}px`,
        background: "var(--bg-panel)", borderRight: "1px solid var(--border-soft)",
        display: "flex", flexDirection: "column", minHeight: 0,
      }}>
        {/* Commands section entry — swaps the main area to the command-policy editor. */}
        <div
          onClick={() => { if (confirmDiscard()) { setShowCommands(true); setSelected(null); } }}
          style={{
            padding: "9px 12px", cursor: "pointer", userSelect: "none",
            borderBottom: "1px solid var(--border-soft)",
            borderLeft: "2px solid " + (showCommands ? "var(--accent)" : "transparent"),
            background: showCommands ? "var(--bg-elev)" : "transparent",
            display: "flex", alignItems: "center", gap: 8,
            fontFamily: "var(--mono)", fontSize: 11.5,
            color: showCommands ? "var(--fg)" : "var(--fg-muted)",
          }}
        >
          <span>⌘</span><span>Commands</span>
        </div>
        <div style={{
          padding: "10px 12px 8px",
          borderBottom: "1px solid var(--border-soft)",
          display: "flex", flexDirection: "column", gap: 8,
        }}>
          <div style={{
            display: "flex", alignItems: "center", gap: 8,
            fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".07em",
            color: "var(--fg-dim)",
          }}>
            <span>DOCUMENTS</span>
            <div style={{ flex: 1 }} />
            <span style={{ color: "var(--fg-muted)" }}>{filtered.length}</span>
            <button
              onClick={refreshDocs}
              style={{
                background: "none", border: "none", cursor: "pointer",
                color: "var(--fg-dim)", fontFamily: "var(--mono)", fontSize: 11, padding: 0,
              }}
              title="Refresh"
            >↻</button>
          </div>

          {/* Project scope chip (when navigated from a project) replaces the
              source filter chips; otherwise show the source filters. */}
          {kbProjectScope ? (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span
                title={`project · ${kbProjectScope.label}`}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 6,
                  padding: "2px 8px", borderRadius: 4, maxWidth: 200,
                  fontFamily: "var(--mono)", fontSize: 10, color: "var(--accent)",
                  background: "color-mix(in oklch, var(--accent), transparent 88%)",
                  border: "1px solid color-mix(in oklch, var(--accent), transparent 72%)",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}
              >
                ▸ {kbProjectScope.label}
                <span
                  onClick={() => setKbProjectScope(null)}
                  title="Clear project filter"
                  style={{ cursor: "pointer", color: "var(--fg-dim)", lineHeight: 1 }}
                >✕</span>
              </span>
              <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-dim)" }}>project docs</span>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {DOC_FILTERS.map(f => {
                const on = filter === f;
                return (
                  <button
                    key={f}
                    onClick={() => setFilter(f)}
                    style={{
                      padding: "2px 7px", borderRadius: 3, cursor: "pointer",
                      fontFamily: "var(--mono)", fontSize: 9.5,
                      border: "1px solid " + (on ? "var(--accent-dim)" : "var(--border-soft)"),
                      background: on ? "var(--bg-elev)" : "transparent",
                      color: on ? "var(--fg)" : "var(--fg-dim)",
                    }}
                  >{kindLabel(f)}</button>
                );
              })}
            </div>
          )}

          {/* Tag / stack facet (#320) — multi-select; a doc must carry every
              selected tag. Hidden when the visible docs carry no tags. */}
          {tagOptions.length > 0 && (
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-dim)", marginRight: 2 }}>#</span>
              {tagOptions.map(t => {
                const on = selectedTags.includes(t);
                return (
                  <button
                    key={t}
                    onClick={() => setSelectedTags(prev => on ? prev.filter(x => x !== t) : [...prev, t])}
                    style={{
                      padding: "1px 6px", borderRadius: 3, cursor: "pointer",
                      fontFamily: "var(--mono)", fontSize: 9,
                      border: "1px solid " + (on ? "var(--info)" : "var(--border-soft)"),
                      background: on ? "color-mix(in oklch, var(--info), transparent 86%)" : "transparent",
                      color: on ? "var(--info)" : "var(--fg-dim)",
                    }}
                  >{t}</button>
                );
              })}
              {selectedTags.length > 0 && (
                <span
                  onClick={() => setSelectedTags([])}
                  title="Clear tags"
                  style={{ cursor: "pointer", color: "var(--fg-dim)", fontFamily: "var(--mono)", fontSize: 9 }}
                >clear</span>
              )}
            </div>
          )}

          {/* Search */}
          <input
            className="input"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="search title + body…"
            style={{ height: 24, padding: "0 8px", fontFamily: "var(--mono)", fontSize: 10.5 }}
          />
        </div>

        <div style={{ flex: 1, overflow: "auto" }}>
          {filtered.length === 0 ? (
            <KbEmptyState
              docCount={docs.length}
              workspaceReady={kbDir !== ""}
              projectScoped={!!kbProjectScope}
              filter={kbProjectScope ? "all" : filter}
              tags={selectedTags}
              query={debouncedSearch}
              onSetupWorkspace={handleSetupWorkspace}
            />
          ) : groups.map(group => (
            <div key={group.kind}>
              <div style={{
                padding: "6px 12px 4px", fontFamily: "var(--mono)", fontSize: 9,
                letterSpacing: ".08em", color: "var(--fg-dim)", textTransform: "uppercase",
                background: "var(--bg-panel)", position: "sticky", top: 0, zIndex: 1,
                borderBottom: "1px solid var(--border-soft)",
                display: "flex", alignItems: "center", gap: 6,
              }}>
                <span style={{ color: KIND_COLOR[group.kind] }}>●</span>
                <span>{group.label}</span>
                <span style={{ color: "var(--fg-dim)", opacity: 0.7 }}>{group.docs.length}</span>
              </div>
              {group.docs.map(d => {
                const sel = d.relpath === selectedPath;
                return (
                  <div
                    key={d.relpath}
                    onClick={() => selectDoc(sel ? null : d.relpath)}
                    style={{
                      padding: sel ? "9px 12px 9px 10px" : "9px 12px",
                      borderBottom: "1px solid var(--border-soft)",
                      borderLeft: sel ? "2px solid var(--accent)" : "2px solid transparent",
                      background: sel ? "var(--bg-elev)" : "transparent",
                      cursor: "pointer", userSelect: "none",
                    }}
                  >
                    <div style={{
                      fontFamily: "var(--mono)", fontSize: 11.5,
                      color: sel ? "var(--fg)" : "var(--fg-muted)",
                      marginBottom: 3,
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}>
                      {d.title}
                    </div>
                    <div style={{
                      fontFamily: "var(--mono)", fontSize: 9.5,
                      color: "var(--fg-dim)", display: "flex", gap: 6, alignItems: "center",
                    }}>
                      <KindBadge kind={d.kind} project={d.project} repo={d.repo} />
                      <div style={{ flex: 1 }} />
                      <span>{formatSize(d.size_bytes)}</span>
                      {d.modified_secs > 0 && <span>{formatAge(d.modified_secs)}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        {kbDir && (
          <div style={{
            padding: "8px 12px", borderTop: "1px solid var(--border-soft)",
            fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }} title={kbDir}>
            {kbDir}
          </div>
        )}
      </aside>

      {/* Drag handle — document list width */}
      <div className="resize-x" {...list.handleProps} title="Drag to resize" />

      {/* ── Right side: Commands policy, or document preview + terminal ──────── */}
      {showCommands ? <CommandsPanel /> : (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0 }}>

        {/* Document preview — shown only when a document is selected */}
        {selected && (
          <div style={{
            flex: `0 0 ${previewPane.size}px`, overflow: "auto",
            borderBottom: "1px solid var(--border-soft)",
            background: "var(--bg-canvas)",
          }}>
            <div style={{
              padding: "8px 18px", background: "var(--bg-panel)",
              borderBottom: "1px solid var(--border-soft)",
              display: "flex", alignItems: "center", gap: 8,
              fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-muted)",
              position: "sticky", top: 0, zIndex: 1,
            }}>
              <span style={{ color: "var(--fg)" }}>{selected.title}</span>
              <KindBadge kind={selected.kind} project={selected.project} repo={selected.repo} />
              <div style={{ flex: 1 }} />
              {editing ? (
                <>
                  {saveError && (
                    <span style={{ color: "var(--danger)", fontSize: 9.5, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={saveError}>{saveError}</span>
                  )}
                  <button
                    onClick={saveEdit}
                    disabled={saving}
                    style={{
                      padding: "2px 8px", borderRadius: 3, cursor: saving ? "not-allowed" : "pointer",
                      background: "var(--accent)", border: "none", color: "#1a120a",
                      fontFamily: "var(--mono)", fontSize: 10, fontWeight: 700, opacity: saving ? 0.6 : 1,
                    }}
                  >{saving ? "saving…" : "save"}</button>
                  <button
                    onClick={() => { setEditing(false); setSaveError(null); }}
                    disabled={saving}
                    style={{
                      padding: "2px 8px", borderRadius: 3, cursor: "pointer",
                      background: "transparent", border: "1px solid var(--border-soft)",
                      color: "var(--fg-dim)", fontFamily: "var(--mono)", fontSize: 10,
                    }}
                  >cancel</button>
                </>
              ) : (
                <button
                  onClick={startEdit}
                  disabled={previewLoading || preview === null}
                  title="Edit this document"
                  style={{
                    padding: "2px 8px", borderRadius: 3,
                    cursor: (previewLoading || preview === null) ? "not-allowed" : "pointer",
                    background: "transparent", border: "1px solid var(--border-soft)",
                    color: "var(--fg-dim)", fontFamily: "var(--mono)", fontSize: 10,
                    opacity: (previewLoading || preview === null) ? 0.5 : 1,
                  }}
                >✎ edit</button>
              )}
              <button
                onClick={() => selectDoc(null)}
                style={{
                  background: "none", border: "none", cursor: "pointer",
                  color: "var(--fg-dim)", fontSize: 13, padding: 0, lineHeight: 1,
                }}
              >×</button>
            </div>
            <div style={{ padding: "16px 20px" }}>
              {editing ? (
                <textarea
                  value={editText}
                  onChange={e => setEditText(e.target.value)}
                  spellCheck={false}
                  style={{
                    width: "100%", minHeight: 200, boxSizing: "border-box",
                    background: "var(--bg-panel)", border: "1px solid var(--border-soft)",
                    borderRadius: 4, outline: "none", padding: "10px 12px",
                    fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--fg)",
                    resize: "vertical", lineHeight: 1.6,
                  }}
                />
              ) : previewLoading ? (
                <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)" }}>loading…</div>
              ) : preview !== null ? (
                <div className="plan-md">
                  <ReactMarkdown>{preview}</ReactMarkdown>
                </div>
              ) : (
                <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)" }}>Could not read document.</div>
              )}
            </div>
          </div>
        )}

        {/* Drag handle — preview height (only while a document is open) */}
        {selected && <div className="resize-y" {...previewPane.handleProps} title="Drag to resize" />}

        {/* Claude terminal */}
        <div style={{
          flex: 1, display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden",
        }}>
          <div style={{
            padding: "8px 18px", background: "var(--bg-panel)",
            borderBottom: "1px solid var(--border-soft)",
            display: "flex", alignItems: "center", gap: 8, flexShrink: 0,
            fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-muted)",
          }}>
            <span style={{ color: "var(--accent)" }}>▸ claude cli · knowledge base</span>
            <div style={{ flex: 1 }} />
            <button
              onClick={handleRestart}
              disabled={restarting}
              style={{
                padding: "2px 8px", borderRadius: 3,
                cursor: restarting ? "not-allowed" : "pointer",
                background: "transparent", border: "1px solid var(--border-soft)",
                color: "var(--fg-dim)", fontFamily: "var(--mono)", fontSize: 10,
                opacity: restarting ? 0.5 : 1,
              }}
            >{restarting ? "restarting…" : "↺ restart"}</button>
          </div>
          <div
            ref={containerRef}
            style={{
              flex: 1, minHeight: 0, overflow: "hidden",
              background: TERM_THEME.background as string,
              padding: "6px 4px",
            }}
          />
        </div>

      </div>
      )}
    </div>
  );
}
