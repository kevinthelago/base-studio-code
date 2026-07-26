// CloudBlueprints (#3802) — the persistent right-side column on the ProjectSetupPage listing the
// gist-sourced blueprints NOT yet in the local library, each with an inline one-click download (no
// modal). It REPLACES the old BlueprintImportModal + paste-URL ImportModal overlays: the "cloud"
// blueprints now live beside the local ones instead of behind a button. The guts are ported from
// BlueprintImportModal — the `listBlueprintGists` load, the user-editable gist SOURCE input (#3802),
// and the per-row loading/error states — but recast as an inline column, not a `ModalScrim`.
//
// It stays presentational: the parent owns the download (resolve gist → import into the library +
// select it), so this column's only side-effect is `onDownload(gistId)`. A just-downloaded blueprint
// leaves this list automatically — the parent's library grows, `downloadedGistIds` recomputes, and
// the row filters out. (The `blueprintImport.css` import keeps the `bim-*` keyframes in the bundle —
// `bim-spin` also backs DesignReconcileModal's spinner.)

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Cloud, RefreshCw, User, Loader2, Inbox, CheckCircle2, AlertTriangle } from "lucide-react";
import "../../../styles/blueprintImport.css";
import { listBlueprintGists, type BlueprintGistItem } from "@/features/planner/lib/gist/gist";
import { hue, tint } from "../blueprints/blueprintCatalog";
import { spin, shimmer } from "../blueprints/blueprintImport.helpers";
import { Button } from "@/shared/ui/controls/Button";
import { IconButton } from "@/shared/ui/controls/IconButton";
import { IconBox } from "@/shared/ui/data/IconBox";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { timeAgo, hueFor } from "@/shared/lib/core/format";

export interface CloudBlueprintsProps {
  /** INITIAL GitHub account to pull blueprint gists from (the user's own login by default). The
   *  source is user-editable in-column — type ANY account to browse its published blueprint gists. */
  defaultSource: string;
  /** GitHub token — optional (public gists need none; raises rate limit + surfaces secret gists). */
  token?: string;
  /** Gist ids already in the local library — those rows are hidden ("not yet downloaded" only). */
  downloadedGistIds: Set<string>;
  /** Download a gist into the library by id. May reject — the failure surfaces on the row (never a
   *  silent swallow). On success the parent grows the library + `downloadedGistIds`, so the row
   *  filters out on the next render. */
  onDownload: (gistId: string) => Promise<void>;
}

export function CloudBlueprints({ defaultSource, token = "", downloadedGistIds, onDownload }: CloudBlueprintsProps) {
  const [items, setItems] = useState<BlueprintGistItem[] | null>(null); // null = loading
  const [error, setError] = useState(false);
  // The gist SOURCE is user-editable (#3802) — the account whose published blueprint gists we list.
  // `source` drives the load; `sourceInput` is the in-progress text, applied on Enter / blur / Browse.
  const [source, setSource] = useState(defaultSource);
  const [sourceInput, setSourceInput] = useState(defaultSource);
  const [busyId, setBusyId] = useState<string | null>(null);
  // A failed download surfaces on its row (persistent until the next attempt) rather than swallowed.
  const [rowError, setRowError] = useState<{ id: string; msg: string } | null>(null);

  const load = useCallback(() => {
    setItems(null); setError(false);
    listBlueprintGists(source, token)
      .then((rows) => setItems(rows))
      .catch(() => { setItems([]); setError(true); });
  }, [source, token]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- load() resets to the loading state on each (source, token) change
  useEffect(() => { load(); }, [load]); // re-runs whenever the source changes

  // Apply the typed source (Enter / blur / Browse) — a real change re-lists via `load`'s dep on it.
  const applySource = () => { const s = sourceInput.trim(); if (s && s !== source) setSource(s); };

  // Guard against a download settling after unmount (the column lives inside a create flow).
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const doDownload = async (it: BlueprintGistItem) => {
    setBusyId(it.id); setRowError(null);
    try {
      await onDownload(it.id); // parent imports + selects; the row filters out on the next render
    } catch (e) {
      if (alive.current) setRowError({ id: it.id, msg: e instanceof Error ? e.message : String(e) });
    } finally {
      if (alive.current) setBusyId((cur) => (cur === it.id ? null : cur));
    }
  };

  const all = items ?? [];
  const notDownloaded = all.filter((it) => !downloadedGistIds.has(it.id));

  const loading = items === null;
  const showError = !loading && error;
  const allDownloaded = !loading && !error && all.length > 0 && notDownloaded.length === 0;
  const noneAtSource = !loading && !error && all.length === 0;
  const showList = !loading && !error && notDownloaded.length > 0;
  const resultLabel = loading ? "loading…" : showError ? "—" : `${notDownloaded.length} available`;

  return (
    <Box style={{
      flex: 1, minWidth: 0, minHeight: 0,
      display: "flex", flexDirection: "column",
      borderLeft: "1px solid var(--border-soft)", background: "var(--bg-elev)",
    }}>
      {/* header */}
      <Row gap={9} align="center" style={{ padding: "16px 16px 10px", flex: "0 0 auto" }}>
        <IconBox size={26} radius={7} background="color-mix(in oklch, var(--accent), transparent 84%)" color="var(--accent)"><Cloud size={13} /></IconBox>
        <Box style={{ minWidth: 0 }}>
          <Text as="div" mono size={12.5} weight={600} style={{ letterSpacing: ".01em", color: "var(--fg)" }}>Cloud blueprints</Text>
          <Text as="div" size={10} tone="dim">not yet in your library</Text>
        </Box>
        <Box as="span" style={{ flex: 1 }} />
        <IconButton onClick={load} title="Refresh list" aria-label="Refresh cloud blueprints"><RefreshCw size={13} /></IconButton>
      </Row>

      {/* user-editable SOURCE input (#3802) — the source IS the query: type any GitHub account and
          list every blueprint gist it publishes. Applied on Enter / blur / Browse. */}
      <Box style={{ padding: "0 16px 12px", flex: "0 0 auto", borderBottom: "1px solid var(--border-soft)" }}>
        <Row gap={7}>
          <Box style={{ position: "relative", flex: 1, minWidth: 0 }}>
            <Box as="span" style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", color: "var(--fg-dim)", display: "flex" }}><User size={12} /></Box>
            {/* eslint-disable-next-line no-restricted-syntax -- bespoke inline source input (absolute-positioned icon overlay; not the .input/.field stack) */}
            <input
              value={sourceInput}
              onChange={(e) => setSourceInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") applySource(); }}
              onBlur={applySource}
              placeholder="GitHub account…"
              aria-label="Cloud blueprints source (GitHub account)"
              className="mono"
              style={{ height: 30, width: "100%", background: "var(--bg-canvas)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-md)", color: "var(--fg)", fontSize: 11, padding: "0 10px 0 28px", outline: "none" }}
            />
          </Box>
          <Button onClick={applySource} title="List this account's blueprint gists" style={{ height: 30, fontSize: 10.5, flex: "0 0 auto" }}>Browse</Button>
        </Row>
        <Text as="div" mono size={9.5} tone="dim" style={{ marginTop: 6 }}>{resultLabel}</Text>
      </Box>

      {/* body */}
      <Box style={{ flex: 1, minHeight: 0, overflowX: "hidden", overflowY: "auto", padding: "12px 16px" }}>
        {loading && (
          <Stack gap={8}>
            {[0, 1, 2].map((i) => (
              <Row key={i} gap={10} style={{ padding: "11px 12px", border: "1px solid var(--border-soft)", borderRadius: "var(--r-md)" }}>
                <Box radius={6} style={{ width: 26, height: 26, flex: "0 0 26px", ...shimmer }} />
                <Stack gap={6} style={{ flex: 1 }}>
                  <Box radius={4} style={{ width: "55%", height: 10, ...shimmer }} />
                  <Box radius={4} style={{ width: "80%", height: 8, ...shimmer }} />
                </Stack>
              </Row>
            ))}
            <Row className="mono" gap={7} justify="center" style={{ fontSize: 10, color: "var(--fg-dim)", padding: "6px 0 2px" }}>
              <Loader2 size={12} style={spin} />fetching {source}'s blueprints…
            </Row>
          </Stack>
        )}

        {showList && (
          <Stack gap={8}>
            {notDownloaded.map((it) => {
              const busy = busyId === it.id;
              const h = hueFor(it.id);
              const err = rowError?.id === it.id ? rowError.msg : null;
              return (
                <Box key={it.id}>
                  <Row gap={10} align="start" style={{
                    padding: "11px 12px", background: "var(--bg-panel)",
                    border: "1px solid var(--border-soft)", borderRadius: "var(--r-md)",
                  }}>
                    <Box className="mono" bg={tint(h, 0.16)} radius={6} style={{
                      width: 26, height: 26, flex: "0 0 26px", display: "flex", alignItems: "center", justifyContent: "center",
                      fontWeight: 700, fontSize: 12, color: hue(h),
                    }}>{it.name[0]?.toUpperCase() ?? "B"}</Box>
                    <Box style={{ minWidth: 0, flex: 1 }}>
                      <Box className="mono" style={{ fontSize: 12, fontWeight: 600, color: "var(--fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.name}</Box>
                      <Box className="mono" style={{ fontSize: 10, color: "var(--fg-dim)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {it.owner}{it.updatedAt && ` · updated ${timeAgo(it.updatedAt)}`}
                      </Box>
                      {it.description && <Box style={{ fontSize: 10.5, color: "var(--fg-muted)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.description.replace(/^blueprint:\s*/i, "")}</Box>}
                    </Box>
                    {busy ? (
                      <Button variant="primary" disabled aria-label={`Downloading ${it.name}`} style={{ height: 26, padding: "0 11px", fontSize: 10.5, flex: "0 0 auto" }}>
                        <Loader2 size={12} style={spin} />
                      </Button>
                    ) : (
                      <Button variant="primary" onClick={() => void doDownload(it)} title={`Download “${it.name}” into your library`} style={{ height: 26, padding: "0 11px", fontSize: 10.5, flex: "0 0 auto" }}>
                        <Download size={13} />Get
                      </Button>
                    )}
                  </Row>
                  {err && (
                    <Row role="alert" gap={6} align="start" className="mono" style={{ padding: "6px 12px 2px", fontSize: 10, color: "var(--danger)" }}>
                      <AlertTriangle size={12} style={{ flex: "0 0 auto", marginTop: 1 }} />Couldn't download: {err}
                    </Row>
                  )}
                </Box>
              );
            })}
          </Stack>
        )}

        {allDownloaded && (
          <Stack gap={9} align="center" style={{ textAlign: "center", padding: "26px 12px", color: "var(--fg-dim)" }}>
            <CheckCircle2 size={20} style={{ color: "var(--success)" }} />
            <Text as="div" size={11} style={{ color: "var(--fg-muted)", lineHeight: 1.55 }}>All of <b style={{ color: "var(--fg)" }}>{source}</b>'s blueprints are downloaded.</Text>
          </Stack>
        )}

        {noneAtSource && (
          <Stack gap={9} align="center" style={{ textAlign: "center", padding: "26px 12px", color: "var(--fg-dim)" }}>
            <Inbox size={20} />
            <Text as="div" size={11} style={{ color: "var(--fg-muted)", lineHeight: 1.55 }}>No blueprints published under <b style={{ color: "var(--fg)" }}>{source}</b>. Try a different GitHub account above.</Text>
          </Stack>
        )}

        {showError && (
          <Stack gap={10} align="center" style={{ textAlign: "center", padding: "26px 12px", color: "var(--fg-dim)" }}>
            <AlertTriangle size={20} style={{ color: "var(--danger)" }} />
            <Text as="div" size={11} style={{ color: "var(--fg-muted)", lineHeight: 1.55 }}>Couldn't reach GitHub — you may be offline. Check your token in settings, then retry.</Text>
            <Button onClick={load} style={{ height: 28, fontSize: 10.5 }}><RefreshCw size={12} />Retry</Button>
          </Stack>
        )}
      </Box>
    </Box>
  );
}
