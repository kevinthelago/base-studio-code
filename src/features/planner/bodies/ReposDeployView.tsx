// Repositories & Deployment — the merged "Deployment" stage pane (#1399), rebuilt to the per-repo
// card design (#1421, design/Claude design_ deployment section/Deployment.dc.html). The Default
// blueprint folds Deploy INTO Repos (#1383), so THIS is the deployment surface every project lands
// on — it must BE the design. One collapsible RepoDeployCard per repo, with the repo's git identity
// (branch · ahead/behind · language · agents · visibility) folded into the card's collapsed row and
// its full ship plan (target & build · pipeline · environments · config & secrets · rollout) inside.
// The header carries the "N of M repos deploy-ready" counter; the project-wide locked dependency
// manifest follows as a tail (it gates separately, #1127).
//
// Controlled — reads a DeployConfig + the linked repos and calls onDeployChange / onLinkRepo /
// per-repo visibility. Reuses RepoDeployCard + ServiceDeploySections from DeployView (one design,
// shared with the standalone Deploy stage), so there's no header gate/ship pill (#1403).

import { useState } from "react";
import { type DeployConfig, type DeployService } from "../shared/deployConfig";
import { RepoDeployCard } from "./DeployView";
import type { Repo } from "../pane/projectPane.types";

const MONO = "var(--mono)";

/** A stream avatar — initial + a deterministic hue from the stream id (agents are arbitrary stream
 *  ids here, not the design's fixed roster). */
function Avatar({ id, sz = 16 }: { id: string; sz?: number }) {
  let hue = 0;
  for (let i = 0; i < id.length; i++) hue = (hue * 31 + id.charCodeAt(i)) % 360;
  return (
    <span style={{
      width: sz, height: sz, borderRadius: 99, background: `oklch(0.7 0.13 ${hue})`, color: "#0b0d10",
      fontFamily: MONO, fontSize: sz * 0.5, fontWeight: 700, display: "inline-flex", alignItems: "center",
      justifyContent: "center", border: "1.5px solid var(--bg-canvas)",
    }}>{(id[0] ?? "?").toUpperCase()}</span>
  );
}

export function FocusedReposDeployBody({
  repos, deploy, onDeployChange, onLinkRepo,
}: {
  repos?: Repo[];
  deploy?: DeployConfig;
  onDeployChange?: (next: DeployConfig) => void;
  onLinkRepo?: (r: string) => void;
}) {
  const [linking, setLinking] = useState(false);
  const [linkInput, setLinkInput] = useState("");
  // Which repo's deploy-target editor is expanded — `null` = all collapsed, the initial state (#1403).
  // Clicking a repo toggles its own editor; opening one also points `selService` at it so the tail
  // pipeline's final-stage label reflects the repo being edited.
  const [openRepo, setOpenRepo] = useState<string | null>(null);
  const list = repos ?? [];
  const d = deploy;

  const set = (patch: Partial<DeployConfig>) => d && onDeployChange?.({ ...d, ...patch });
  const serviceForRepo = (repoId: string) => d?.services.find((s) => s.repo === repoId);
  const setSvcFor = (svcId: string, patch: Partial<DeployService>) =>
    d && set({ services: d.services.map((s) => (s.id === svcId ? { ...s, ...patch } : s)) });

  // ── link affordance ──
  const submitLink = () => { const v = linkInput.trim(); if (v.includes("/")) { onLinkRepo?.(v); setLinkInput(""); setLinking(false); } };
  const linkAffordance = onLinkRepo && (
    linking ? (
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input
          autoFocus aria-label="Link a repository" value={linkInput} placeholder="owner/repo"
          onChange={(e) => setLinkInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submitLink(); else if (e.key === "Escape") { setLinking(false); setLinkInput(""); } }}
          style={{ flex: 1, height: 26, padding: "0 8px", borderRadius: 6, background: "var(--bg-canvas)", border: "1px solid var(--border-soft)", color: "var(--fg)", fontFamily: MONO, fontSize: 10, outline: "none" }}
        />
        <button disabled={!linkInput.includes("/")} onClick={submitLink} style={{
          height: 26, padding: "0 11px", borderRadius: 6, border: "1px solid var(--accent-dim)",
          background: linkInput.includes("/") ? "var(--accent)" : "var(--bg-elev)", color: linkInput.includes("/") ? "#0b0d10" : "var(--fg-dim)",
          fontFamily: MONO, fontSize: 9.5, cursor: "pointer",
        }}>link</button>
        <button onClick={() => { setLinking(false); setLinkInput(""); }} style={{ height: 26, padding: "0 10px", borderRadius: 6, border: "1px solid var(--border-soft)", background: "transparent", color: "var(--fg-muted)", fontFamily: MONO, fontSize: 9.5, cursor: "pointer" }}>cancel</button>
      </div>
    ) : (
      <button type="button" onClick={() => setLinking(true)} style={{
        width: "100%", border: "1px dashed var(--border)", borderRadius: 8, padding: 14, display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
        background: "transparent", color: "var(--fg-dim)", fontFamily: MONO, fontSize: 10.5, cursor: "pointer",
      }}>＋ link another repository</button>
    )
  );

  // ── per-repo git identity shown in the collapsed card row (ahead/behind · language · agents) ──
  const repoMeta = (r: Repo) => (
    <>
      {(r.ahead > 0 || r.behind > 0) && (
        <span style={{ fontFamily: MONO, fontSize: 8.5 }}>
          {r.ahead > 0 && <span style={{ color: "var(--success)" }}>↑{r.ahead} </span>}
          {r.behind > 0 && <span style={{ color: "var(--info)" }}>↓{r.behind}</span>}
        </span>
      )}
      {r.lang && <span style={{ fontFamily: MONO, fontSize: 8, padding: "1px 7px", borderRadius: 99, color: "var(--fg-muted)", background: "var(--bg-elev2)", border: "1px solid var(--border-soft)" }}>{r.lang}</span>}
      {r.agents.length > 0 && (
        <span style={{ display: "inline-flex", alignItems: "center" }}>
          {r.agents.map((id, i) => <span key={id} style={{ marginLeft: i ? -5 : 0 }}><Avatar id={id} sz={14} /></span>)}
        </span>
      )}
    </>
  );

  // The focused pane's phase header already titles this stage (+ gate pill), so the body renders no
  // header of its own (#1430 follow-up) — just the per-repo cards.
  const total = list.length;

  // ── body — one per-repo card (RepoDeployCard) with the repo's git identity folded into its row;
  //    each repo is a self-contained deployable unit (#1421). Project-wide locked deps as a tail. ──
  let body: React.ReactNode;
  if (total === 0) {
    body = (
      <>
        <div style={{ border: "1px dashed var(--border)", borderRadius: "var(--r-lg)", padding: "40px 24px", display: "flex", flexDirection: "column", alignItems: "center", gap: 12, textAlign: "center", background: "var(--bg-canvas)" }}>
          <span style={{ fontSize: 26, opacity: 0.5 }}>⎇</span>
          <span style={{ fontFamily: "var(--sans)", fontSize: 13, fontWeight: 600, color: "var(--fg)" }}>No repositories linked</span>
          <span style={{ fontFamily: MONO, fontSize: 10.5, color: "var(--fg-muted)", maxWidth: 380, lineHeight: 1.6 }}>Deployment is configured per repository — each repo carries its own pipeline, environments and secrets. Link one to define how it ships.</span>
        </div>
        {linkAffordance}
      </>
    );
  } else {
    body = (
      <>
        <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          {list.map((r) => {
            const svc = serviceForRepo(r.id);
            if (!svc) {
              // A linked repo whose deploy service isn't seeded yet (config out of sync) — show its
              // identity so it's not dropped; the service seeds when the plan is next saved.
              return (
                <div key={r.id} style={{ background: "var(--bg-elev)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)", padding: "11px 13px", display: "flex", alignItems: "center", gap: 9 }}>
                  <span style={{ width: 7, height: 7, borderRadius: 99, flex: "0 0 7px", background: r.cloned ? "var(--success)" : "var(--fg-dim)" }} />
                  <span style={{ fontFamily: MONO, fontSize: 12, color: "var(--fg)" }}>{r.id}</span>
                  {repoMeta(r)}
                  <span style={{ flex: 1 }} />
                  <span style={{ fontFamily: MONO, fontSize: 8.5, color: "var(--fg-dim)" }}>deploy seeds on save</span>
                </div>
              );
            }
            return (
              <RepoDeployCard
                key={r.id}
                svc={svc}
                setSvc={(patch) => setSvcFor(svc.id, patch)}
                open={openRepo === r.id}
                onToggle={() => setOpenRepo(openRepo === r.id ? null : r.id)}
                meta={repoMeta(r)}
              />
            );
          })}
          {linkAffordance}
        </div>
      </>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {body}
    </div>
  );
}
