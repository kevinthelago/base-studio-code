// The Import-blueprint-from-gist modal (design: "Repository code review request" /
// BlueprintImportModal.dc.html). Lists the blueprint gists published under a GitHub account
// (the user's own) and imports one into the library, with the manual "by URL / ID" paste as a
// fallback. States: loading (skeletons) · list (per-row import / Imported / Update / importing) ·
// empty · error. Pure-ish presentational shell over `listBlueprintGists`; CRUD is the parent's
// `onImport` (resolve + dedupe-by-gist-id). Replaces the page-oriented CatalogView in a modal.

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { Download, Cloud, RefreshCw, Link2, X, Search, Check, ArrowUpCircle, AlertTriangle, Inbox, Loader2 } from "lucide-react";
import "../../../styles/blueprintImport.css";
import { hue, tint, gistUpdateAvailable } from "./blueprintCatalog";
import { listBlueprintGists, type BlueprintGistItem } from "../../../lib/planner/gist/gist";

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
  /** Fall back to the manual paste-a-URL / ID dialog. */
  onManualImport: () => void;
  onClose: () => void;
}

function timeAgo(iso: string): string {
  if (!iso) return "";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (!isFinite(s) || s < 0) return "";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); if (d < 30) return `${d}d ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

/** Deterministic hue from a gist id — the row tile's accent (matches CatalogView). */
const hueFor = (s: string): number => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; };

const spin: CSSProperties = { animation: "bim-spin .8s linear infinite" };
const shimmer: CSSProperties = {
  background: "linear-gradient(90deg,var(--bg-elev) 0%,var(--bg-elev2) 50%,var(--bg-elev) 100%)",
  backgroundSize: "260px 100%", animation: "bim-shimmer 1.1s linear infinite",
};

export function BlueprintImportModal({ source, token = "", importedById = {}, onImport, onManualImport, onClose }: BlueprintImportModalProps) {
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

  const load = useCallback(() => {
    setItems(null); setError(false);
    listBlueprintGists(source, token)
      .then((rows) => setItems(rows))
      .catch(() => { setItems([]); setError(true); });
  }, [source, token]);
  useEffect(() => { load(); }, [load]);

  // Esc closes; clear any pending toast/busy timers on unmount.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    const pending = timers.current;
    return () => { window.removeEventListener("keydown", onKey); pending.forEach(clearTimeout); };
  }, [onClose]);

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
  const headBtn: CSSProperties = {
    height: 28, padding: "0 11px", borderRadius: "var(--r-md)", background: "var(--bg-elev)",
    border: "1px solid var(--border-soft)", color: "var(--fg)", fontFamily: "var(--mono)",
    fontSize: 11, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6,
  };
  const iconBtn: CSSProperties = {
    width: 28, height: 28, borderRadius: "var(--r-md)", border: "1px solid var(--border-soft)",
    background: "var(--bg-elev)", color: "var(--fg-muted)", cursor: "pointer",
    display: "inline-flex", alignItems: "center", justifyContent: "center",
  };
  const ctaBtn: CSSProperties = {
    height: 28, padding: "0 13px", borderRadius: "var(--r-md)", background: "var(--accent)",
    border: "1px solid transparent", color: "#1a120a", fontWeight: 600, fontFamily: "var(--mono)",
    fontSize: 11, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6,
  };
  const pill = (color: string): CSSProperties => ({
    display: "inline-flex", alignItems: "center", gap: 4, padding: "1px 7px", borderRadius: 99,
    fontFamily: "var(--mono)", fontSize: 9, lineHeight: 1.7, color,
    border: `1px solid color-mix(in oklch, ${color}, transparent 72%)`,
    background: `color-mix(in oklch, ${color}, transparent 90%)`,
  });

  return (
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 200, background: "oklch(0.08 0.005 250 / .66)",
        backdropFilter: "blur(2.5px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 36,
      }}
    >
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
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "17px 20px", borderBottom: "1px solid var(--border-soft)", flex: "0 0 auto" }}>
          <span style={{
            width: 32, height: 32, flex: "0 0 32px", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center",
            background: "color-mix(in oklch, var(--accent), transparent 84%)", color: "var(--accent)",
          }}><Download size={16} /></span>
          <div style={{ minWidth: 0 }}>
            <h2 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 14.5, fontWeight: 600, letterSpacing: ".01em" }}>Import blueprint</h2>
            <div style={{ fontSize: 10.5, color: "var(--fg-dim)", marginTop: 2 }}>your published blueprint gists</div>
          </div>
          <span style={{ flex: 1 }} />
          <span style={{
            display: "inline-flex", alignItems: "center", gap: 7, height: 26, padding: "0 10px", borderRadius: 99,
            fontFamily: "var(--mono)", fontSize: 10, border: "1px solid var(--border-soft)", background: "var(--bg-elev)", color: "var(--fg-muted)",
          }}><Cloud size={11} />gist source · <b style={{ color: "var(--fg)", fontWeight: 600 }}>{source}</b></span>
          <button onClick={load} title="Refresh list" aria-label="Refresh list" style={iconBtn}><RefreshCw size={14} /></button>
          <button onClick={onManualImport} title="Import by URL or ID" style={headBtn}><Link2 size={13} />URL / ID</button>
          <button onClick={onClose} title="Close" aria-label="Close" style={{ ...iconBtn, border: "1px solid transparent", background: "transparent", color: "var(--fg-dim)" }}><X size={15} /></button>
        </div>

        {/* sticky search */}
        <div style={{ flex: "0 0 auto", padding: "11px 20px", borderBottom: "1px solid var(--border-soft)", background: "var(--bg-panel)", display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ position: "relative", flex: 1 }}>
            <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--fg-dim)", display: "flex" }}><Search size={13} /></span>
            <input
              value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="search blueprints by name, description, owner…"
              style={{ height: 30, width: "100%", background: "var(--bg-canvas)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-md)", color: "var(--fg)", fontFamily: "var(--mono)", fontSize: 11, padding: "0 10px 0 30px", outline: "none" }}
            />
          </div>
          <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-dim)", whiteSpace: "nowrap" }}>{resultLabel}</span>
        </div>

        {/* body */}
        <div style={{ flex: 1, minHeight: 0, overflowX: "hidden", overflowY: "auto", padding: "14px 20px" }}>
          {importError && (
            <div
              role="alert"
              style={{
                display: "flex", alignItems: "flex-start", gap: 9, marginBottom: 11, padding: "10px 12px",
                borderRadius: "var(--r-md)", fontFamily: "var(--mono)", fontSize: 11, lineHeight: 1.5,
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
            </div>
          )}
          {statusLoading && (
            <>
              {[0, 1, 2, 3].map((i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 14, padding: "13px 15px", background: "var(--bg-panel)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-md)", marginBottom: 9 }}>
                  <div style={{ width: 30, height: 30, flex: "0 0 30px", borderRadius: 7, ...shimmer }} />
                  <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 7 }}>
                    <div style={{ width: "42%", height: 11, borderRadius: 4, ...shimmer }} />
                    <div style={{ width: "64%", height: 9, borderRadius: 4, ...shimmer }} />
                  </div>
                  <div style={{ width: 78, height: 24, borderRadius: "var(--r-md)", background: "var(--bg-elev)" }} />
                </div>
              ))}
              <div style={{ textAlign: "center", fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-dim)", padding: "14px 0 4px", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                <Loader2 size={13} style={spin} />fetching {source}'s blueprint gists…
              </div>
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
                return (
                  <div
                    key={it.id}
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
                    <div style={{
                      width: 30, height: 30, flex: "0 0 30px", borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center",
                      fontFamily: "var(--mono)", fontWeight: 700, fontSize: 13, background: tint(h, 0.16), color: hue(h),
                    }}>{it.name[0]?.toUpperCase() ?? "B"}</div>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontFamily: "var(--mono)", fontSize: 12.5, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.name}</span>
                        {!busy && imported && !stale && <span style={pill("var(--success)")}>imported</span>}
                        {!busy && stale && <span style={pill("var(--accent)")}>update available</span>}
                      </div>
                      <div style={{ fontSize: 10.5, color: "var(--fg-dim)", fontFamily: "var(--mono)", marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        gist.github.com/{it.owner}/{it.id.slice(0, 7)}{it.updatedAt && ` · updated ${timeAgo(it.updatedAt)}`}
                      </div>
                      {it.description && <div style={{ fontSize: 11, color: "var(--fg-muted)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.description.replace(/^blueprint:\s*/i, "")}</div>}
                    </div>
                    <span style={{ flex: "0 0 auto" }}>
                      {busy ? (
                        <button disabled style={{ height: 26, padding: "0 12px", borderRadius: "var(--r-md)", background: "var(--bg-elev)", border: "1px solid var(--border-soft)", color: "var(--fg-muted)", fontFamily: "var(--mono)", fontSize: 10.5, cursor: "default", display: "inline-flex", alignItems: "center", gap: 6, opacity: 0.85 }}>
                          <Loader2 size={12} style={spin} />importing…
                        </button>
                      ) : imported && !stale ? (
                        <button disabled title="Already in your library — up to date" style={{ height: 26, padding: "0 11px", borderRadius: "var(--r-md)", background: "transparent", border: "1px solid color-mix(in oklch, var(--success), transparent 70%)", color: "var(--success)", fontFamily: "var(--mono)", fontSize: 10.5, cursor: "default", display: "inline-flex", alignItems: "center", gap: 6 }}>
                          <Check size={13} />Imported
                        </button>
                      ) : stale ? (
                        <button onClick={() => void doImport(it)} title="Upstream has newer changes — pull the update" style={{ height: 26, padding: "0 12px", borderRadius: "var(--r-md)", background: "color-mix(in oklch, var(--accent), transparent 88%)", border: "1px solid var(--accent-dim)", color: "var(--accent)", fontWeight: 600, fontFamily: "var(--mono)", fontSize: 10.5, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}>
                          <ArrowUpCircle size={13} />Update
                        </button>
                      ) : (
                        <button onClick={() => void doImport(it)} title="Import into your library" style={{ ...ctaBtn, height: 26, padding: "0 13px", fontSize: 10.5 }}>
                          <Download size={13} />Import
                        </button>
                      )}
                    </span>
                  </div>
                );
              })}
              {rows.length === 0 && (
                <div style={{ textAlign: "center", fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)", padding: "30px 0" }}>No blueprints match “{query}”.</div>
              )}
            </>
          )}

          {statusEmpty && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: 14, padding: "38px 24px 30px" }}>
              <div style={{ width: 48, height: 48, borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg-elev)", border: "1px solid var(--border-soft)", color: "var(--fg-dim)" }}><Inbox size={22} /></div>
              <div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--fg)", fontWeight: 600, marginBottom: 6 }}>No blueprint gists yet</div>
                <div style={{ fontSize: 11.5, color: "var(--fg-muted)", lineHeight: 1.65, maxWidth: 380 }}>
                  <b style={{ color: "var(--fg)" }}>{source}</b> hasn't published any blueprint gists. Publish one from the editor, or pull a blueprint someone shared with you by URL / ID.
                </div>
              </div>
              <button onClick={onManualImport} style={ctaBtn}><Link2 size={13} />Import by URL / ID</button>
            </div>
          )}

          {statusError && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: 14, padding: "38px 24px 30px" }}>
              <div style={{ width: 48, height: 48, borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", background: "color-mix(in oklch, var(--danger), transparent 88%)", border: "1px solid color-mix(in oklch, var(--danger), transparent 60%)", color: "var(--danger)" }}><AlertTriangle size={22} /></div>
              <div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--fg)", fontWeight: 600, marginBottom: 6 }}>Couldn't reach GitHub</div>
                <div style={{ fontSize: 11.5, color: "var(--fg-muted)", lineHeight: 1.65, maxWidth: 400 }}>
                  The gist list request failed — you may be offline or not connected. Check your GitHub token in settings, then retry.
                </div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={load} style={headBtn}><RefreshCw size={13} />Retry</button>
                <button onClick={onManualImport} style={{ ...headBtn, background: "transparent", color: "var(--fg-muted)" }}>Import by URL / ID</button>
              </div>
            </div>
          )}
        </div>

        {/* footer */}
        <div style={{ flex: "0 0 auto", display: "flex", alignItems: "center", gap: 10, padding: "11px 20px", borderTop: "1px solid var(--border-soft)", fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>
          <span>importing pulls the gist into your library &amp; links it upstream</span>
          <span style={{ flex: 1 }} />
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            press <span style={{ display: "inline-block", padding: "1px 6px", border: "1px solid var(--border)", borderRadius: 4, color: "var(--fg-muted)", background: "var(--bg-elev)" }}>Esc</span> to close
          </span>
        </div>
      </div>

      {/* toast */}
      {toast && (
        <div style={{
          position: "fixed", left: "50%", bottom: 40, transform: "translateX(-50%)", zIndex: 210,
          display: "flex", alignItems: "center", gap: 9, padding: "9px 15px", background: "var(--bg-elev2)",
          border: "1px solid var(--border)", borderRadius: 99, boxShadow: "0 12px 32px rgba(0,0,0,.5)",
          fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg)", animation: "bim-toast .2s ease both",
        }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--success)" }} />{toast}
        </div>
      )}
    </div>
  );
}
