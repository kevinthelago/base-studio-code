// Repositories & Deployment — the merged "Deployment" stage pane (#1399). One cohesive surface that
// replaces the old stacked FocusedReposBody + FocusedDeployBody (#1383): a plain `⎇ Repositories &
// Deployment` header, then card 01 "Repositories" where each repo's git identity is merged with its
// deploy target (click a repo to expand its target editor inline), then the rest of the ship flow
// (pipeline · environments · config+secrets · dependencies · release/health · readiness) reused from
// FocusedDeployBody in "tail" view. Design: design/Streams Pane Design/ReposDeployPane.dc.html.
//
// Controlled like FocusedDeployBody — reads a DeployConfig + the linked repos and calls
// onDeployChange / onLinkRepo / per-repo visibility. Reuses shared/deployConfig.ts (no model change).
// Shipping is governed by the blueprint (this pane only renders when deploy is folded in), so there's
// no header gate/ship pill, no global visibility toggle, and no readiness banner (#1403) — the
// per-stage gate + the D · READINESS checklist already carry that signal.

import { useState } from "react";
import {
  platform, serviceMode, serviceTargetDefined, deployChecks,
  type DeployConfig, type DeployService,
} from "../shared/deployConfig";
import { Card, Divider, ServiceTargetEditor, FocusedDeployBody } from "./DeployView";
import type { Repo } from "../pane/projectPane.types";
import type { PlanDependency, DependencyRegistry } from "../issues/dependencies";

const MONO = "var(--mono)";

/** Branch pill color by review state — matches FocusedReposBody + the design. */
function branchStateColor(st: string): string {
  return st === "review" ? "var(--success)" : st === "draft" ? "var(--fg-dim)" : "var(--info)";
}

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
  repos, deploy, onDeployChange, dependencies = [], registries = {},
  onLinkRepo, reposPublic, repoOverrides, onSetRepoPublic,
}: {
  repos?: Repo[];
  deploy?: DeployConfig;
  onDeployChange?: (next: DeployConfig) => void;
  dependencies?: PlanDependency[];
  registries?: Record<string, DependencyRegistry>;
  onLinkRepo?: (r: string) => void;
  /** Project-level default GitHub visibility — the per-repo toggle's fallback (#1227); false ⇒ private. */
  reposPublic?: boolean;
  /** Per-repo visibility overrides keyed by repo full-name; absent ⇒ inherits the default. */
  repoOverrides?: Record<string, boolean>;
  onSetRepoPublic?: (repoId: string, isPublic: boolean) => void;
}) {
  const [linking, setLinking] = useState(false);
  const [linkInput, setLinkInput] = useState("");
  const list = repos ?? [];
  const d = deploy;

  const set = (patch: Partial<DeployConfig>) => d && onDeployChange?.({ ...d, ...patch });
  const serviceForRepo = (repoId: string) => d?.services.find((s) => s.repo === repoId);
  const setSvcFor = (svcId: string, patch: Partial<DeployService>) =>
    d && set({ services: d.services.map((s) => (s.id === svcId ? { ...s, ...patch } : s)) });

  // ── per-repo visibility toggle (override → project default, #1227) ──
  const repoVisToggle = (repoId: string) => {
    if (!onSetRepoPublic) return null;
    const pub = repoOverrides?.[repoId] ?? !!reposPublic;
    return (
      <span
        style={{ display: "inline-flex", border: "1px solid var(--border-soft)", borderRadius: "var(--r-sm)", overflow: "hidden" }}
        title={`Visibility when this repo is created on GitHub${repoOverrides?.[repoId] === undefined ? " (using the project default)" : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        {([[false, "🔒"], [true, "🌐"]] as const).map(([val, glyph], i) => {
          const on = pub === val;
          return (
            <button
              key={glyph}
              onClick={() => { if (!on) onSetRepoPublic(repoId, val); }}
              aria-pressed={on}
              aria-label={val ? `Make ${repoId} public` : `Make ${repoId} private`}
              style={{
                height: 20, padding: "0 6px", border: 0, borderLeft: i ? "1px solid var(--border-soft)" : "none",
                cursor: on ? "default" : "pointer", fontSize: 9.5,
                background: on ? "var(--bg-elev2)" : "transparent", opacity: on ? 1 : 0.45,
              }}
            >{glyph}</button>
          );
        })}
      </span>
    );
  };

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

  // ── card 01: one row per repo, git identity merged with its deploy target ──
  const repoTargetRow = (r: Repo) => {
    const svc = serviceForRepo(r.id);
    const sel = !!svc && svc.id === d?.selService;
    const targeted = !!svc && serviceTargetDefined(svc);
    const local = !!svc && serviceMode(svc) === "local";
    const p = svc?.platform ? platform(svc.platform) : null;

    let targetChip: React.ReactNode = null;
    if (svc) {
      if (p) {
        targetChip = (
          <span style={{
            display: "inline-flex", alignItems: "center", gap: 5, padding: "2px 8px", borderRadius: 99, fontFamily: MONO, fontSize: 9,
            color: targeted ? "var(--accent)" : "var(--fg-muted)",
            background: `color-mix(in oklch, var(--accent), transparent ${targeted ? "86%" : "92%"})`,
            border: "1px solid " + (targeted ? "var(--accent-dim)" : "var(--border-soft)"),
          }}>
            <span style={{ color: `oklch(0.78 0.12 ${p.h})` }}>{p.glyph}</span>{p.name}
            <span style={{ fontSize: 9, color: "var(--fg-dim)", marginLeft: 1, transform: sel ? "rotate(180deg)" : "none", display: "inline-block" }}>▾</span>
          </span>
        );
      } else if (local) {
        targetChip = (
          <span style={{
            display: "inline-flex", alignItems: "center", gap: 5, padding: "2px 8px", borderRadius: 99, fontFamily: MONO, fontSize: 9,
            color: targeted ? "var(--violet)" : "var(--fg-muted)",
            background: `color-mix(in oklch, var(--violet), transparent ${targeted ? "86%" : "92%"})`,
            border: "1px solid " + (targeted ? "color-mix(in oklch, var(--violet), transparent 60%)" : "var(--border-soft)"),
          }}>
            ⬢ {svc.localKind === "library" ? "library" : "app"}
            <span style={{ fontSize: 9, color: "var(--fg-dim)", marginLeft: 1, transform: sel ? "rotate(180deg)" : "none", display: "inline-block" }}>▾</span>
          </span>
        );
      } else {
        targetChip = (
          <span style={{ padding: "2px 8px", borderRadius: 99, fontFamily: MONO, fontSize: 9, color: "var(--warn)", background: "color-mix(in oklch, var(--warn), transparent 88%)", border: "1px dashed color-mix(in oklch, var(--warn), transparent 55%)" }}>set target →</span>
        );
      }
    }

    return (
      <div key={r.id} style={{
        borderRadius: 9, overflow: "hidden",
        border: "1px solid " + (sel ? "var(--accent-dim)" : r.primary ? "color-mix(in oklch, var(--accent), transparent 72%)" : "var(--border-soft)"),
        background: sel ? "color-mix(in oklch, var(--accent), transparent 93%)" : "var(--bg-canvas)",
      }}>
        <div
          onClick={svc ? () => set({ selService: svc.id }) : undefined}
          style={{ padding: "11px 12px", cursor: svc ? "pointer" : "default" }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 7, height: 7, borderRadius: 99, flex: "0 0 auto", background: r.cloned ? "var(--success)" : "var(--fg-dim)" }} />
            <span style={{ fontFamily: MONO, fontSize: 12.5, color: "var(--fg)" }}>{r.id}</span>
            {r.primary && <span style={{ fontFamily: MONO, fontSize: 8, padding: "1px 7px", borderRadius: 99, color: "var(--accent)", border: "1px solid var(--accent-dim)", background: "color-mix(in oklch, var(--accent), transparent 86%)" }}>primary</span>}
            <span style={{ flex: 1 }} />
            {targetChip}
            {repoVisToggle(r.id)}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 9 }}>
            <span style={{ fontFamily: MONO, fontSize: 8.5, padding: "1px 7px", borderRadius: 99, color: "var(--info)", background: "var(--bg-elev2)", border: "1px solid var(--border-soft)" }}>⎇ {r.branch}</span>
            <span style={{ fontFamily: MONO, fontSize: 9, color: "var(--success)" }}>↑{r.ahead}</span>
            <span style={{ fontFamily: MONO, fontSize: 9, color: "var(--info)" }}>↓{r.behind}</span>
            {r.lang && <span style={{ fontFamily: MONO, fontSize: 8, padding: "1px 7px", borderRadius: 99, color: "var(--fg-muted)", background: "var(--bg-elev2)", border: "1px solid var(--border-soft)" }}>{r.lang}</span>}
            <span style={{ flex: 1 }} />
            {r.agents.length > 0 && (
              <span style={{ display: "inline-flex", alignItems: "center" }}>
                {r.agents.map((id, i) => <span key={id} style={{ marginLeft: i ? -5 : 0 }}><Avatar id={id} /></span>)}
              </span>
            )}
          </div>
          {r.branches.length > 0 && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 9 }}>
              {r.branches.map((b) => (
                <span key={b.n} style={{ fontFamily: MONO, fontSize: 8.5, padding: "1px 6px", borderRadius: 3, background: "var(--bg-elev)", border: "1px solid var(--border-soft)", color: branchStateColor(b.state) }}>
                  ⎇ {b.n} <span style={{ color: "var(--fg-dim)" }}>#{b.issue}</span>
                </span>
              ))}
            </div>
          )}
        </div>
        {sel && svc && (
          <div style={{ padding: "0 12px 12px" }}>
            <ServiceTargetEditor svc={svc} setSvc={(patch) => setSvcFor(svc.id, patch)} />
          </div>
        )}
      </div>
    );
  };

  const reposCard = (done: boolean) => {
    const cloned = list.filter((r) => r.cloned).length;
    const right = list.length > 0
      ? <span style={{ fontFamily: MONO, fontSize: 10, color: "var(--fg-dim)" }}>{list.length} linked · {cloned} cloned</span>
      : undefined;
    const body = list.length === 0 ? (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 7, padding: "22px 12px", color: "var(--fg-dim)" }}>
        <span style={{ fontSize: 26, opacity: 0.5 }}>⎇</span>
        <span style={{ fontFamily: MONO, fontSize: 10.5, color: "var(--fg-muted)" }}>No repositories linked yet</span>
        <span style={{ fontSize: 10.5, textAlign: "center", maxWidth: 250, lineHeight: 1.5 }}>Link the repos this project spans — Claude clones each and tracks its branches.</span>
      </div>
    ) : (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{list.map((r) => repoTargetRow(r))}</div>
    );
    return (
      <Card n="01" title="Repositories" hint="→ deploy targets" done={done} right={right}>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {body}
          {linkAffordance}
        </div>
      </Card>
    );
  };

  // ── header — just the icon + title (no gate/ship pills, #1403) ──
  const header = (
    <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
      <span style={{
        width: 19, height: 19, borderRadius: 5, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12,
        color: "var(--accent)", background: "color-mix(in oklch, var(--accent), transparent 84%)", border: "1px solid var(--accent-dim)",
      }}>⎇</span>
      <span style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: ".13em", textTransform: "uppercase", color: "var(--fg-dim)" }}>Repositories &amp; Deployment</span>
    </div>
  );

  // ── body ──
  let body: React.ReactNode;
  if (list.length === 0) {
    // Nothing to deploy until a repo is linked.
    body = (
      <>
        {reposCard(false)}
        <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "13px 14px", borderRadius: "var(--r-lg)", background: "var(--bg-canvas)", border: "1px dashed var(--border)" }}>
          <span style={{ fontSize: 15, color: "var(--fg-dim)" }}>⏻</span>
          <span style={{ fontFamily: MONO, fontSize: 10, color: "var(--fg-dim)", lineHeight: 1.5 }}>Deployment unlocks once at least one repository is linked.</span>
        </div>
      </>
    );
  } else {
    // Repos + their deploy targets in card 01, then the rest of the deploy flow (tail). No readiness
    // banner — the D · READINESS checklist below carries that signal (#1403).
    const ck = (id: string) => (d ? deployChecks(d).find((c) => c.id === id)?.ok ?? false : false);
    body = (
      <>
        <Divider label="A · HOW IT SHIPS" color="var(--accent)" />
        {reposCard(ck("target"))}
        <FocusedDeployBody deploy={d} onChange={onDeployChange} dependencies={dependencies} registries={registries} view="tail" />
      </>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {header}
      {body}
    </div>
  );
}
