// The Import-blueprint-from-gist modal (design: "Repository code review request" /
// BlueprintImportModal.dc.html). Lists every blueprint gist published under a GitHub account and
// imports one into the library, with the manual "by URL / ID" paste as a fallback. The account is a
// USER-EDITABLE SOURCE input (#3802) — the source IS the query, so any account's published blueprints
// can be browsed (replacing the old within-source search bar). States: loading (skeletons) · list
// (per-row import / Imported / Update / importing) · empty · error. Pure-ish presentational shell over
// `listBlueprintGists`; CRUD is the parent's `onImport` (resolve + dedupe-by-gist-id).

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Cloud, RefreshCw, Link2, X, User, Check, ArrowUpCircle, AlertTriangle, Inbox, Loader2, Eye } from "lucide-react";
import "../../../styles/blueprintImport.css";
import { hue, tint, gistUpdateAvailable } from "./blueprintCatalog";
import { listBlueprintGists, type BlueprintGistItem } from "@/features/planner/lib/gist/gist";
import { ModalScrim } from "@/shared/ui/overlay/ModalScrim";
import { Button } from "@/shared/ui/controls/Button";
import { IconButton } from "@/shared/ui/controls/IconButton";
import { StatusDot } from "@/shared/ui/feedback/StatusDot";
import { Banner } from "@/shared/ui/feedback/Banner";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";
import { IconBox } from "@/shared/ui/data/IconBox";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { timeAgo, hueFor } from "@/shared/lib/core/format";
import { type PreviewBlueprint } from "./BlueprintModals";
import { GistPreview } from "./GistPreview";
import { spin, shimmer, pill, type PreviewEntry } from "./blueprintImport.helpers";

export interface BlueprintImportModalProps {
  /** INITIAL GitHub account to pull blueprint gists from (the user's own login by default). The
   *  source is user-editable in-modal (#3802): the user can type ANY account to browse its
   *  published blueprint gists — the source IS the query now. */
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

export function BlueprintImportModal({ source: defaultSource, token = "", importedById = {}, onImport, onPreview, onManualImport, onClose }: BlueprintImportModalProps) {
  const [items, setItems] = useState<BlueprintGistItem[] | null>(null); // null = loading
  const [error, setError] = useState(false);
  // The gist SOURCE is user-editable (#3802) — the account whose published blueprint gists we list.
  // `source` drives the load; `sourceInput` is the in-progress text, applied on Enter / blur / Browse.
  const [source, setSource] = useState(defaultSource);
  const [sourceInput, setSourceInput] = useState(defaultSource);
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
    setItems(null); setError(false); setPreviewId(null);
    listBlueprintGists(source, token)
      .then((rows) => setItems(rows))
      .catch(() => { setItems([]); setError(true); });
  }, [source, token]);
  useEffect(() => { load(); }, [load]);   // re-runs whenever the source changes

  // Apply the typed source (Enter / blur / Browse) — a real change re-lists via `load`'s dep on it.
  const applySource = () => { const s = sourceInput.trim(); if (s && s !== source) setSource(s); };

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

  // No within-source search anymore (#3802) — the source input IS the query; list every gist it has.
  const rows = items ?? [];

  const statusLoading = items === null;
  const statusError = !statusLoading && error;
  const statusEmpty = !statusLoading && !error && (items?.length ?? 0) === 0;
  const statusList = !statusLoading && !error && (items?.length ?? 0) > 0;
  const resultLabel = statusLoading ? "loading…"
    : statusError ? "—"
    : `${rows.length} result${rows.length === 1 ? "" : "s"}`;

  return (
    <ModalScrim onDismiss={onClose} blur style={{ padding: 36 }}>
      <Box
        role="dialog" aria-modal="true" aria-label="Import blueprint from gist"
        bg="var(--bg-panel)" border radius="lg" style={{
          width: 760, maxWidth: "100%", maxHeight: "82vh", display: "flex", flexDirection: "column",
          boxShadow: "0 28px 80px rgba(0,0,0,.6)", overflow: "hidden",
          animation: "bim-pop .24s cubic-bezier(.2,.8,.2,1)",
        }}
      >
        {/* header */}
        <Row gap={12} style={{ padding: "17px 20px", borderBottom: "1px solid var(--border-soft)", flex: "0 0 auto" }}>
          <IconBox size={32} radius={8} background="color-mix(in oklch, var(--accent), transparent 84%)" color="var(--accent)"><Download size={16} /></IconBox>
          <Box style={{ minWidth: 0 }}>
            <Text as="h2" mono size={14.5} weight={600} style={{ margin: 0, letterSpacing: ".01em" }}>Import blueprint</Text>
            <Text as="div" size={10.5} tone="dim" style={{ marginTop: 2 }}>browse any account's published blueprint gists</Text>
          </Box>
          <Box as="span" style={{ flex: 1 }} />
          <Box as="span" className="mono" pad={[0, 10]} bg="var(--bg-elev)" border="soft" radius={99} style={{
            display: "inline-flex", alignItems: "center", gap: 7, height: 26,
            fontSize: 10, color: "var(--fg-muted)",
          }}><Cloud size={11} />gist source · <b style={{ color: "var(--fg)", fontWeight: 600 }}>{source}</b></Box>
          <IconButton onClick={load} title="Refresh list" aria-label="Refresh list"><RefreshCw size={14} /></IconButton>
          <Button onClick={onManualImport} title="Import by URL or ID"><Link2 size={13} />URL / ID</Button>
          <IconButton onClick={onClose} title="Close" aria-label="Close"><X size={15} /></IconButton>
        </Row>

        {/* sticky SOURCE input (#3802) — the gist source is the query now: type any GitHub account
            and list every blueprint gist it publishes. Applied on Enter / blur / Browse. */}
        <Row gap={10} style={{ flex: "0 0 auto", padding: "11px 20px", borderBottom: "1px solid var(--border-soft)", background: "var(--bg-panel)" }}>
          <Box style={{ position: "relative", flex: 1 }}>
            <Box as="span" style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--fg-dim)", display: "flex" }}><User size={13} /></Box>
            {/* eslint-disable-next-line no-restricted-syntax -- bespoke inline source input (absolute-positioned icon overlay; not the .input/.field stack) */}
            <input
              value={sourceInput}
              onChange={(e) => setSourceInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") applySource(); }}
              onBlur={applySource}
              placeholder="GitHub username or gist source…"
              aria-label="Gist source (GitHub account)"
              className="mono"
              style={{ height: 30, width: "100%", background: "var(--bg-canvas)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-md)", color: "var(--fg)", fontSize: 11, padding: "0 10px 0 30px", outline: "none" }}
            />
          </Box>
          <Button onClick={applySource} title="List this account's blueprint gists" style={{ height: 30, fontSize: 10.5 }}>Browse</Button>
          <Text as="span" size={10.5} tone="dim" className="mono" style={{ whiteSpace: "nowrap" }}>{resultLabel}</Text>
        </Row>

        {/* body */}
        <Box pad={[14, 20]} style={{ flex: 1, minHeight: 0, overflowX: "hidden", overflowY: "auto"}}>
          {importError && (
            <Banner
              role="alert"
              tone="danger"
              lead={<AlertTriangle size={14} style={{ flex: "0 0 auto" }} />}
              onDismiss={() => setImportError(null)}
              style={{ marginBottom: 11 }}
            >
              <Box as="span" style={{ flex: 1, color: "var(--fg)" }}>{importError}</Box>
            </Banner>
          )}
          {statusLoading && (
            <>
              {[0, 1, 2, 3].map((i) => (
                <Row key={i} gap={14} style={{ padding: "13px 15px", background: "var(--bg-panel)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-md)", marginBottom: 9 }}>
                  <Box radius={7} style={{ width: 30, height: 30, flex: "0 0 30px", ...shimmer }} />
                  <Stack gap={7} style={{ flex: 1 }}>
                    <Box radius={4} style={{ width: "42%", height: 11, ...shimmer }} />
                    <Box radius={4} style={{ width: "64%", height: 9, ...shimmer }} />
                  </Stack>
                  <Box bg="var(--bg-elev)" radius="md" style={{ width: 78, height: 24}} />
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
                  <Box key={it.id}>
                  <Row
                    gap={14}
                    onMouseEnter={() => setHover(it.id)}
                    onMouseLeave={() => setHover((cur) => (cur === it.id ? null : cur))}
                    style={{
                      padding: "12px 15px",
                      background: isHover ? "color-mix(in oklch, var(--bg-panel), var(--bg-elev) 35%)" : "var(--bg-panel)",
                      border: "1px solid " + (isHover ? "var(--border)" : "var(--border-soft)"),
                      borderRadius: "var(--r-md)", marginBottom: 9, transition: "border-color .12s, background .12s",
                      animation: "bim-row .26s ease", animationDelay: `${i * 0.035}s`,
                    }}
                  >
                    <Box className="mono" bg={tint(h, 0.16)} radius={7} style={{
                      width: 30, height: 30, flex: "0 0 30px", display: "flex", alignItems: "center", justifyContent: "center",
                      fontWeight: 700, fontSize: 13, color: hue(h),
                    }}>{it.name[0]?.toUpperCase() ?? "B"}</Box>
                    <Box style={{ minWidth: 0, flex: 1 }}>
                      <Row className="mono" gap={8} style={{ fontSize: 12.5, fontWeight: 600 }}>
                        <Box as="span" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.name}</Box>
                        {!busy && imported && !stale && <Box as="span" style={pill("var(--success)")}>imported</Box>}
                        {!busy && stale && <Box as="span" style={pill("var(--accent)")}>update available</Box>}
                      </Row>
                      <Box className="mono" style={{ fontSize: 10.5, color: "var(--fg-dim)", marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        gist.github.com/{it.owner}/{it.id.slice(0, 7)}{it.updatedAt && ` · updated ${timeAgo(it.updatedAt)}`}
                      </Box>
                      {it.description && <Box style={{ fontSize: 11, color: "var(--fg-muted)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.description.replace(/^blueprint:\s*/i, "")}</Box>}
                    </Box>
                    <Box as="span" style={{ flex: "0 0 auto", display: "inline-flex", alignItems: "center", gap: 6 }}>
                      {/* eslint-disable-next-line no-restricted-syntax -- bespoke inline preview-toggle button */}
                      <button
                        onClick={() => togglePreview(it)}
                        aria-expanded={expanded}
                        title="Preview the blueprint's contents before importing"
                        className="mono"
                        style={{ height: 26, padding: "0 10px", borderRadius: "var(--r-md)", background: expanded ? "var(--bg-elev2)" : "transparent", border: "1px solid var(--border-soft)", color: expanded ? "var(--fg)" : "var(--fg-muted)", fontSize: 10.5, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}
                      ><Eye size={13} />Preview</button>
                      {busy ? (
                        // eslint-disable-next-line no-restricted-syntax -- bespoke inline "importing…" status button
                        <button disabled className="mono" style={{ height: 26, padding: "0 12px", borderRadius: "var(--r-md)", background: "var(--bg-elev)", border: "1px solid var(--border-soft)", color: "var(--fg-muted)", fontSize: 10.5, cursor: "default", display: "inline-flex", alignItems: "center", gap: 6, opacity: 0.85 }}>
                          <Loader2 size={12} style={spin} />importing…
                        </button>
                      ) : imported && !stale ? (
                        // eslint-disable-next-line no-restricted-syntax -- bespoke inline "Imported" status button
                        <button disabled title="Already in your library — up to date" className="mono" style={{ height: 26, padding: "0 11px", borderRadius: "var(--r-md)", background: "transparent", border: "1px solid color-mix(in oklch, var(--success), transparent 70%)", color: "var(--success)", fontSize: 10.5, cursor: "default", display: "inline-flex", alignItems: "center", gap: 6 }}>
                          <Check size={13} />Imported
                        </button>
                      ) : stale ? (
                        // eslint-disable-next-line no-restricted-syntax -- bespoke inline "Update" button
                        <button onClick={() => void doImport(it)} title="Upstream has newer changes — pull the update" className="mono" style={{ height: 26, padding: "0 12px", borderRadius: "var(--r-md)", background: "color-mix(in oklch, var(--accent), transparent 88%)", border: "1px solid var(--accent-dim)", color: "var(--accent)", fontWeight: 600, fontSize: 10.5, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}>
                          <ArrowUpCircle size={13} />Update
                        </button>
                      ) : (
                        <Button variant="primary" onClick={() => void doImport(it)} title="Import into your library" style={{ height: 26, padding: "0 13px", fontSize: 10.5 }}>
                          <Download size={13} />Import
                        </Button>
                      )}
                    </Box>
                  </Row>
                  {expanded && <GistPreview entry={previews[it.id]} />}
                  </Box>
                );
              })}
            </>
          )}

          {statusEmpty && (
            <EmptyState
              iconVariant="dashed"
              icon={<Inbox size={22} />}
              title="No blueprint gists found"
              description={<>No published blueprint gists found for <b style={{ color: "var(--fg)" }}>{source}</b>. Try a different GitHub account above, or pull a blueprint someone shared with you by URL / ID.</>}
              actions={<Button variant="primary" onClick={onManualImport}><Link2 size={13} />Import by URL / ID</Button>}
            />
          )}

          {statusError && (
            <EmptyState
              iconVariant="dashed"
              icon={<AlertTriangle size={22} />}
              title="Couldn't reach GitHub"
              description="The gist list request failed — you may be offline or not connected. Check your GitHub token in settings, then retry."
              actions={
                <>
                  <Button onClick={load}><RefreshCw size={13} />Retry</Button>
                  <Button variant="ghost" onClick={onManualImport}>Import by URL / ID</Button>
                </>
              }
            />
          )}
        </Box>

        {/* footer */}
        <Row className="mono" gap={10} style={{ flex: "0 0 auto", padding: "11px 20px", borderTop: "1px solid var(--border-soft)", fontSize: 10, color: "var(--fg-dim)" }}>
          <Text as="span">importing pulls the gist into your library &amp; links it upstream</Text>
          <Box as="span" style={{ flex: 1 }} />
          <Box as="span" style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            press <Box as="span" pad={[1, 6]} bg="var(--bg-elev)" border radius={4} style={{ display: "inline-block", color: "var(--fg-muted)"}}>Esc</Box> to close
          </Box>
        </Row>
      </Box>

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
