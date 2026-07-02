// The Import-blueprint-from-gist modal (design: "Repository code review request" /
// BlueprintImportModal.dc.html). Lists the blueprint gists published under a GitHub account
// (the user's own) and imports one into the library, with the manual "by URL / ID" paste as a
// fallback. States: loading (skeletons) · list (per-row import / Imported / Update / importing) ·
// empty · error. Pure-ish presentational shell over `listBlueprintGists`; CRUD is the parent's
// `onImport` (resolve + dedupe-by-gist-id). The page-oriented gist catalog, in a modal.

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { Download, Cloud, RefreshCw, Link2, X, Search, Check, ArrowUpCircle, AlertTriangle, Inbox, Loader2, Eye, FileJson } from "lucide-react";
import "../../../styles/blueprintImport.css";
import { hue, tint, gistUpdateAvailable } from "./blueprintCatalog";
import { listBlueprintGists, type BlueprintGistItem } from "@/features/planner/lib/gist/gist";
import { ModalScrim } from "@/shared/ui/overlay/ModalScrim";
import { Button } from "@/shared/ui/controls/Button";
import { IconButton } from "@/shared/ui/controls/IconButton";
import { StatusDot } from "@/shared/ui/feedback/StatusDot";
import { IconBox } from "@/shared/ui/data/IconBox";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { timeAgo, hueFor } from "@/shared/lib/core/format";
import { StageSummary, type PreviewBlueprint } from "./BlueprintModals";

export interface BlueprintImportModalProps {
  /** GitHub account to pull blueprint gists from (the user's own login). */
  source: string;
  /** GitHub token — optional (public gists need none; raises rate limit + shows secret gists). */
  token?: string;
  /** Gist id → the locally-imported copy's recorded upstream `updatedAt` (#955). Present ⇒ already
   *  imported; a newer item `updatedAt` ⇒ out of date, so an "Update" button renders. */
  importedById?: Record<string, { updatedAt?: string }>;
  /** Import (or update-in-place) a gist by id; the current `updatedAt` is recorded for freshness.
   *  May be async — a rejection is surfaced to the user (the import never fails silently, #1042). */
  onImport: (gistId: string, updatedAt?: string) => void | Promise<void>;
  /** Resolve a gist to its blueprint contents WITHOUT importing — drives the per-row preview so the
   *  user can see what's in the JSON they're about to download before committing to it (#1037). */
  onPreview: (gistId: string) => Promise<PreviewBlueprint>;
  /** Fall back to the manual paste-a-URL / ID dialog. */
  onManualImport: () => void;
  onClose: () => void;
}


const spin: CSSProperties = { animation: "bim-spin .8s linear infinite" };
const shimmer: CSSProperties = {
  background: "linear-gradient(90deg,var(--bg-elev) 0%,var(--bg-elev2) 50%,var(--bg-elev) 100%)",
  backgroundSize: "260px 100%", animation: "bim-shimmer 1.1s linear infinite",
};

/** A fetched blueprint-preview cache entry for a gist row (#1037). */
type PreviewEntry = { loading?: boolean; data?: PreviewBlueprint; error?: string };

/** The expanded preview under a gist row: what the user is about to download — the blueprint's
 *  stages (the structured view that drives the decision) + the raw JSON file itself. */
function GistPreview({ entry }: { entry?: PreviewEntry }) {
  const [raw, setRaw] = useState(false);
  const box: CSSProperties = {
    margin: "-3px 0 9px", padding: "11px 13px", borderRadius: "var(--r-md)",
    background: "var(--bg-canvas)", border: "1px solid var(--border-soft)",
    fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-muted)",
  };
  if (!entry || entry.loading) {
    return <Row gap={8} style={box}><Loader2 size={12} style={spin} />reading the blueprint…</Row>;
  }
  if (entry.error) {
    return <Row align="start" gap={8} style={{ ...box, color: "var(--danger)" }}><AlertTriangle size={13} style={{ flex: "0 0 auto", marginTop: 1 }} />couldn't read this blueprint: {entry.error}</Row>;
  }
  const p = entry.data!;
  const bp = p.blueprint;                          // the fully-coerced blueprint, when present
  const sections = bp?.sections ?? p.sections;     // top-level sections always exist
  const caps = sections.reduce((n, s) => n + (s.skills?.length ?? 0) + (s.mcp?.length ?? 0), 0);
  return (
    <div style={box}>
      <div style={{ color: "var(--fg-dim)", marginBottom: 8 }}>
        {bp?.category ?? "greenfield"}{bp?.mode ? ` · ${bp.mode}` : ""} · {sections.length} stage{sections.length === 1 ? "" : "s"}{caps > 0 ? ` · ${caps} attached` : ""}
      </div>
      <StageSummary sections={sections} />
      <button
        onClick={() => setRaw((r) => !r)}
        className="mono"
        style={{ marginTop: 9, background: "none", border: 0, padding: 0, cursor: "pointer", color: "var(--fg-dim)", fontSize: 10, display: "inline-flex", alignItems: "center", gap: 5 }}
      ><FileJson size={11} />{raw ? "hide" : "view"} raw JSON</button>
      {raw && (
        <pre style={{ marginTop: 7, maxHeight: 220, overflow: "auto", padding: 10, borderRadius: "var(--r-md)", background: "var(--bg-elev)", border: "1px solid var(--border-soft)", color: "var(--fg-muted)", fontSize: 10, lineHeight: 1.5, whiteSpace: "pre" }}>
          {JSON.stringify(bp ?? { name: p.name, sections }, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function BlueprintImportModal({ source, token = "", importedById = {}, onImport, onPreview, onManualImport, onClose }: BlueprintImportModalProps) {
  const [items, setItems] = useState<BlueprintGistItem[] | null>(null); // null = loading
  const [error, setError] = useState(false);
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [toast, setToast] = useState("");
  // A failed import surfaces here (persistent until the next attempt / dismiss) rather than
  // being swallowed — the user must know an import didn't land and why (#1042).
  const [importError, setImportError] = useState<string | null>(null);
  const timers = useRef<number[]>([]);
  // Per-row blueprint preview (#1037): which gist row is expanded + a fetch cache of the resolved
  // blueprint JSON, so the user sees what's in the file before importing it.
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, PreviewEntry>>({});
  const togglePreview = (it: BlueprintGistItem) => {
    if (previewId === it.id) { setPreviewId(null); return; }
    setPreviewId(it.id);
    if (previews[it.id]?.data) return; // already fetched
    setPreviews((m) => ({ ...m, [it.id]: { loading: true } }));
    onPreview(it.id)
      .then((data) => setPreviews((m) => ({ ...m, [it.id]: { data } })))
      .catch((e) => setPreviews((m) => ({ ...m, [it.id]: { error: e instanceof Error ? e.message : String(e) } })));
  };

  const load = useCallback(() => {
    setItems(null); setError(false);
    listBlueprintGists(source, token)
      .then((rows) => setItems(rows))
      .catch(() => { setItems([]); setError(true); });
  }, [source, token]);
  useEffect(() => { load(); }, [load]);

  // Clear any pending toast/busy timers on unmount (Esc + overlay dismiss handled by ModalScrim).
  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  const flash = (msg: string) => {
    setToast(msg);
    timers.current.push(window.setTimeout(() => setToast(""), 1900));
  };

  const doImport = async (it: BlueprintGistItem) => {
    setBusyId(it.id);
    setImportError(null);
    try {
      // Await the parent's resolve+install so the outcome is REAL — a success flashes the
      // confirmation (the parent re-renders the row to "Imported"); a failure surfaces the
      // reason instead of the old fire-and-forget flash that lied on error (#1042).
      await onImport(it.id, it.updatedAt);
      flash(`Imported “${it.name}”`);
    } catch (e) {
      setImportError(`Couldn't import “${it.name}”: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyId((cur) => (cur === it.id ? null : cur));
    }
  };

  const q = query.trim().toLowerCase();
  const rows = (items ?? []).filter((it) =>
    (it.name + " " + it.description + " " + it.owner).toLowerCase().includes(q));

  const statusLoading = items === null;
  const statusError = !statusLoading && error;
  const statusEmpty = !statusLoading && !error && (items?.length ?? 0) === 0;
  const statusList = !statusLoading && !error && (items?.length ?? 0) > 0;
  const resultLabel = statusLoading ? "loading…"
    : statusError ? "—"
    : `${rows.length} result${rows.length === 1 ? "" : "s"}`;

  // ── shared style atoms ──
  const pill = (color: string): CSSProperties => ({
    display: "inline-flex", alignItems: "center", gap: 4, padding: "1px 7px", borderRadius: 99,
    fontFamily: "var(--mono)", fontSize: 9, lineHeight: 1.7, color,
    border: `1px solid color-mix(in oklch, ${color}, transparent 72%)`,
    background: `color-mix(in oklch, ${color}, transparent 90%)`,
  });

  return (
    <ModalScrim onDismiss={onClose} blur style={{ padding: 36 }}>
      <div
        role="dialog" aria-modal="true" aria-label="Import blueprint from gist"
        style={{
          width: 760, maxWidth: "100%", maxHeight: "82vh", display: "flex", flexDirection: "column",
          background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: "var(--r-lg)",
          boxShadow: "0 28px 80px rgba(0,0,0,.6)", overflow: "hidden",
          animation: "bim-pop .24s cubic-bezier(.2,.8,.2,1)",
        }}
      >
        {/* header */}
        <Row gap={12} style={{ padding: "17px 20px", borderBottom: "1px solid var(--border-soft)", flex: "0 0 auto" }}>
          <IconBox size={32} radius={8} background="color-mix(in oklch, var(--accent), transparent 84%)" color="var(--accent)"><Download size={16} /></IconBox>
          <div style={{ minWidth: 0 }}>
            <h2 className="mono" style={{ margin: 0, fontSize: 14.5, fontWeight: 600, letterSpacing: ".01em" }}>Import blueprint</h2>
            <div style={{ fontSize: 10.5, color: "var(--fg-dim)", marginTop: 2 }}>your published blueprint gists</div>
          </div>
          <span style={{ flex: 1 }} />
          <span className="mono" style={{
            display: "inline-flex", alignItems: "center", gap: 7, height: 26, padding: "0 10px", borderRadius: 99,
            fontSize: 10, border: "1px solid var(--border-soft)", background: "var(--bg-elev)", color: "var(--fg-muted)",
          }}><Cloud size={11} />gist source · <b style={{ color: "var(--fg)", fontWeight: 600 }}>{source}</b></span>
          <IconButton onClick={load} title="Refresh list" aria-label="Refresh list"><RefreshCw size={14} /></IconButton>
          <Button onClick={onManualImport} title="Import by URL or ID"><Link2 size={13} />URL / ID</Button>
          <IconButton onClick={onClose} title="Close" aria-label="Close"><X size={15} /></IconButton>
        </Row>

        {/* sticky search */}
        <Row gap={10} style={{ flex: "0 0 auto", padding: "11px 20px", borderBottom: "1px solid var(--border-soft)", background: "var(--bg-panel)" }}>
          <div style={{ position: "relative", flex: 1 }}>
            <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--fg-dim)", display: "flex" }}><Search size={13} /></span>
            <input
              value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="search blueprints by name, description, owner…"
              className="mono"
              style={{ height: 30, width: "100%", background: "var(--bg-canvas)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-md)", color: "var(--fg)", fontSize: 11, padding: "0 10px 0 30px", outline: "none" }}
            />
          </div>
          <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-dim)", whiteSpace: "nowrap" }}>{resultLabel}</span>
        </Row>

        {/* body */}
        <div style={{ flex: 1, minHeight: 0, overflowX: "hidden", overflowY: "auto", padding: "14px 20px" }}>
          {importError && (
            <Row
              role="alert"
              className="mono"
              align="start"
              gap={9}
              style={{
                marginBottom: 11, padding: "10px 12px",
                borderRadius: "var(--r-md)", fontSize: 11, lineHeight: 1.5,
                color: "var(--danger)", background: "color-mix(in oklch, var(--danger), transparent 90%)",
                border: "1px solid color-mix(in oklch, var(--danger), transparent 62%)",
              }}
            >
              <AlertTriangle size={14} style={{ flex: "0 0 auto", marginTop: 1 }} />
              <span style={{ flex: 1, color: "var(--fg)" }}>{importError}</span>
              <button
                onClick={() => setImportError(null)}
                aria-label="Dismiss error"
                style={{ background: "transparent", border: 0, color: "var(--fg-dim)", cursor: "pointer", padding: 0, display: "flex" }}
              ><X size={13} /></button>
            </Row>
          )}
          {statusLoading && (
            <>
              {[0, 1, 2, 3].map((i) => (
                <Row key={i} gap={14} style={{ padding: "13px 15px", background: "var(--bg-panel)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-md)", marginBottom: 9 }}>
                  <div style={{ width: 30, height: 30, flex: "0 0 30px", borderRadius: 7, ...shimmer }} />
                  <Stack gap={7} style={{ flex: 1 }}>
                    <div style={{ width: "42%", height: 11, borderRadius: 4, ...shimmer }} />
                    <div style={{ width: "64%", height: 9, borderRadius: 4, ...shimmer }} />
                  </Stack>
                  <div style={{ width: 78, height: 24, borderRadius: "var(--r-md)", background: "var(--bg-elev)" }} />
                </Row>
              ))}
              <Row className="mono" gap={8} justify="center" style={{ textAlign: "center", fontSize: 10.5, color: "var(--fg-dim)", padding: "14px 0 4px" }}>
                <Loader2 size={13} style={spin} />fetching {source}'s blueprint gists…
              </Row>
            </>
          )}

          {statusList && (
            <>
              {rows.map((it, i) => {
                const local = importedById[it.id];
                const imported = !!local;
                const stale = imported && gistUpdateAvailable(it.updatedAt, local?.updatedAt);
                const busy = busyId === it.id;
                const h = hueFor(it.id);
                const isHover = hover === it.id;
                const expanded = previewId === it.id;
                return (
                  <div key={it.id}>
                  <div
                    onMouseEnter={() => setHover(it.id)}
                    onMouseLeave={() => setHover((cur) => (cur === it.id ? null : cur))}
                    style={{
                      display: "flex", alignItems: "center", gap: 14, padding: "12px 15px",
                      background: isHover ? "color-mix(in oklch, var(--bg-panel), var(--bg-elev) 35%)" : "var(--bg-panel)",
                      border: "1px solid " + (isHover ? "var(--border)" : "var(--border-soft)"),
                      borderRadius: "var(--r-md)", marginBottom: 9, transition: "border-color .12s, background .12s",
                      animation: "bim-row .26s ease", animationDelay: `${i * 0.035}s`,
                    }}
                  >
                    <div className="mono" style={{
                      width: 30, height: 30, flex: "0 0 30px", borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center",
                      fontWeight: 700, fontSize: 13, background: tint(h, 0.16), color: hue(h),
                    }}>{it.name[0]?.toUpperCase() ?? "B"}</div>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="mono" style={{ fontSize: 12.5, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.name}</span>
                        {!busy && imported && !stale && <span style={pill("var(--success)")}>imported</span>}
                        {!busy && stale && <span style={pill("var(--accent)")}>update available</span>}
                      </div>
                      <div className="mono" style={{ fontSize: 10.5, color: "var(--fg-dim)", marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        gist.github.com/{it.owner}/{it.id.slice(0, 7)}{it.updatedAt && ` · updated ${timeAgo(it.updatedAt)}`}
                      </div>
                      {it.description && <div style={{ fontSize: 11, color: "var(--fg-muted)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.description.replace(/^blueprint:\s*/i, "")}</div>}
                    </div>
                    <span style={{ flex: "0 0 auto", display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <button
                        onClick={() => togglePreview(it)}
                        aria-expanded={expanded}
                        title="Preview the blueprint's contents before importing"
                        className="mono"
                        style={{ height: 26, padding: "0 10px", borderRadius: "var(--r-md)", background: expanded ? "var(--bg-elev2)" : "transparent", border: "1px solid var(--border-soft)", color: expanded ? "var(--fg)" : "var(--fg-muted)", fontSize: 10.5, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}
                      ><Eye size={13} />Preview</button>
                      {busy ? (
                        <button disabled className="mono" style={{ height: 26, padding: "0 12px", borderRadius: "var(--r-md)", background: "var(--bg-elev)", border: "1px solid var(--border-soft)", color: "var(--fg-muted)", fontSize: 10.5, cursor: "default", display: "inline-flex", alignItems: "center", gap: 6, opacity: 0.85 }}>
                          <Loader2 size={12} style={spin} />importing…
                        </button>
                      ) : imported && !stale ? (
                        <button disabled title="Already in your library — up to date" className="mono" style={{ height: 26, padding: "0 11px", borderRadius: "var(--r-md)", background: "transparent", border: "1px solid color-mix(in oklch, var(--success), transparent 70%)", color: "var(--success)", fontSize: 10.5, cursor: "default", display: "inline-flex", alignItems: "center", gap: 6 }}>
                          <Check size={13} />Imported
                        </button>
                      ) : stale ? (
                        <button onClick={() => void doImport(it)} title="Upstream has newer changes — pull the update" className="mono" style={{ height: 26, padding: "0 12px", borderRadius: "var(--r-md)", background: "color-mix(in oklch, var(--accent), transparent 88%)", border: "1px solid var(--accent-dim)", color: "var(--accent)", fontWeight: 600, fontSize: 10.5, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}>
                          <ArrowUpCircle size={13} />Update
                        </button>
                      ) : (
                        <Button variant="primary" onClick={() => void doImport(it)} title="Import into your library" style={{ height: 26, padding: "0 13px", fontSize: 10.5 }}>
                          <Download size={13} />Import
                        </Button>
                      )}
                    </span>
                  </div>
                  {expanded && <GistPreview entry={previews[it.id]} />}
                  </div>
                );
              })}
              {rows.length === 0 && (
                <div className="mono" style={{ textAlign: "center", fontSize: 11, color: "var(--fg-dim)", padding: "30px 0" }}>No blueprints match “{query}”.</div>
              )}
            </>
          )}

          {statusEmpty && (
            <Stack gap={14} align="center" style={{ textAlign: "center", padding: "38px 24px 30px" }}>
              <div style={{ width: 48, height: 48, borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg-elev)", border: "1px solid var(--border-soft)", color: "var(--fg-dim)" }}><Inbox size={22} /></div>
              <div>
                <div className="mono" style={{ fontSize: 13, color: "var(--fg)", fontWeight: 600, marginBottom: 6 }}>No blueprint gists yet</div>
                <div style={{ fontSize: 11.5, color: "var(--fg-muted)", lineHeight: 1.65, maxWidth: 380 }}>
                  <b style={{ color: "var(--fg)" }}>{source}</b> hasn't published any blueprint gists. Publish one from the editor, or pull a blueprint someone shared with you by URL / ID.
                </div>
              </div>
              <Button variant="primary" onClick={onManualImport}><Link2 size={13} />Import by URL / ID</Button>
            </Stack>
          )}

          {statusError && (
            <Stack gap={14} align="center" style={{ textAlign: "center", padding: "38px 24px 30px" }}>
              <div style={{ width: 48, height: 48, borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", background: "color-mix(in oklch, var(--danger), transparent 88%)", border: "1px solid color-mix(in oklch, var(--danger), transparent 60%)", color: "var(--danger)" }}><AlertTriangle size={22} /></div>
              <div>
                <div className="mono" style={{ fontSize: 13, color: "var(--fg)", fontWeight: 600, marginBottom: 6 }}>Couldn't reach GitHub</div>
                <div style={{ fontSize: 11.5, color: "var(--fg-muted)", lineHeight: 1.65, maxWidth: 400 }}>
                  The gist list request failed — you may be offline or not connected. Check your GitHub token in settings, then retry.
                </div>
              </div>
              <Row gap={8} align="stretch">
                <Button onClick={load}><RefreshCw size={13} />Retry</Button>
                <Button variant="ghost" onClick={onManualImport}>Import by URL / ID</Button>
              </Row>
            </Stack>
          )}
        </div>

        {/* footer */}
        <Row className="mono" gap={10} style={{ flex: "0 0 auto", padding: "11px 20px", borderTop: "1px solid var(--border-soft)", fontSize: 10, color: "var(--fg-dim)" }}>
          <span>importing pulls the gist into your library &amp; links it upstream</span>
          <span style={{ flex: 1 }} />
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            press <span style={{ display: "inline-block", padding: "1px 6px", border: "1px solid var(--border)", borderRadius: 4, color: "var(--fg-muted)", background: "var(--bg-elev)" }}>Esc</span> to close
          </span>
        </Row>
      </div>

      {/* toast */}
      {toast && (
        <Row className="above-modal mono" gap={9} style={{
          position: "fixed", left: "50%", bottom: 40, transform: "translateX(-50%)",
          padding: "9px 15px", background: "var(--bg-elev2)",
          border: "1px solid var(--border)", borderRadius: 99, boxShadow: "0 12px 32px rgba(0,0,0,.5)",
          fontSize: 11, color: "var(--fg)", animation: "bim-toast .2s ease both",
        }}>
          <StatusDot size={7} color="var(--success)" />{toast}
        </Row>
      )}
    </ModalScrim>
  );
}
