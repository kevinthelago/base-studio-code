// PreviewPaneShell — the modular, streaming-capable replacement for PlanPreviewPane
// (#581). Routes preview chunks through the renderer registry; the imperative surface
// receives updates directly (zero React re-renders on the hot path). React state is
// limited to { activeKind, rendStatus, briefCopied } — chrome only.
//
// External behavior is identical to PlanPreviewPane: reads stagePreview + run state
// from the store, shows the same approval UI, and uses PipelineScreenFrame chrome.

import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../../../store';
import { PipelineScreenFrame } from '../PipelineScreenFrame';
import { dispatchRenderPreview, RENDER_PREVIEW_ID } from '../renderPreview';
import { buildClaudeDesignBrief } from '../claudeDesignBrief';
import { getRenderer } from './registry';
import type { RendererHandle } from './registry';
import type { RenderableChunk, RenderableKind, PreviewStatus } from './types';
import type { PipelineScreenProps } from '../pipelineScreens';

const EMPTY: string[] = [];

const DEMO_FILES: Record<string, string> = {
  'Demo.jsx':
`export default function Demo() {
  return (
    <div style={{ padding: 40, fontFamily: "Inter, system-ui, sans-serif" }}>
      <h1 style={{ color: "#e0a050", margin: 0 }}>Preview pane</h1>
      <p style={{ color: "#bbb", maxWidth: 460, lineHeight: 1.6 }}>
        The render-preview pipeline bundled this skeleton (esbuild-wasm) and rendered it
        in a sandboxed iframe, pulling React from esm.sh. The UI stage will render your
        generated screens here.
      </p>
    </div>
  );
}`,
};

export function PreviewPaneShell({ projectKey, onClose }: PipelineScreenProps) {
  const preview = useAppStore((s) => s.stagePreview[projectKey] ?? null);
  const run = useAppStore((s) => s.stagePipelineRuns[projectKey]?.[RENDER_PREVIEW_ID]);
  const declared = useAppStore((s) => s.uiScreens[projectKey]) ?? EMPTY;
  const approvedList = useAppStore((s) => s.uiApproved[projectKey]) ?? EMPTY;
  const setUiScreenApproved = useAppStore((s) => s.setUiScreenApproved);

  const pipelineStatus = run?.status ?? 'idle';
  // React state: chrome-only signals. Imperative surface mutates containerRef directly.
  const [rendStatus, setRendStatus] = useState<PreviewStatus>({ status: 'ready' });
  const [activeKind, setActiveKind] = useState<RenderableKind | null>(null);
  const [briefCopied, setBriefCopied] = useState(false);

  // Imperative surface: the renderer mounts into this div and owns its DOM children.
  const containerRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<RendererHandle | null>(null);
  // Stable ref so the cleanup effect doesn't capture stale kind state.
  const activeKindRef = useRef<RenderableKind | null>(null);

  // Route new store previews → renderer imperatively.
  // This effect is the ONLY path by which content enters the surface; it never calls
  // setState for the chunk itself, so a high-frequency stream causes zero React renders.
  useEffect(() => {
    if (!preview || !containerRef.current) return;
    const chunk: RenderableChunk = {
      kind: 'react-bundle',
      payload: { srcDoc: preview.srcDoc },
      mode: preview.mode,
      source: preview.screen ?? 'preview',
      final: true,
    };
    const renderer = getRenderer(chunk.kind);
    if (!renderer) return;

    if (handleRef.current && activeKindRef.current === chunk.kind) {
      // Same kind → update the persistent surface in place; no unmount/remount.
      handleRef.current.update(chunk);
    } else {
      // Different kind (or first chunk) → teardown current surface and mount new one.
      handleRef.current?.teardown();
      handleRef.current = renderer.mount(containerRef.current, chunk);
      handleRef.current.onStatus(setRendStatus);
      activeKindRef.current = chunk.kind;
      setActiveKind(chunk.kind); // one React render to show the surface
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview]);

  // Teardown on unmount.
  useEffect(() => () => { handleRef.current?.teardown(); }, []);

  const currentScreen = preview?.screen;
  const currentApproved = !!currentScreen && approvedList.includes(currentScreen);
  const approvedCount = declared.filter((s) => approvedList.includes(s)).length;

  const renderDemo = () => void dispatchRenderPreview({
    projectKey, artifacts: DEMO_FILES, entry: 'Demo.jsx', mode: '2d',
  });

  const loadSkeleton = async () => {
    try {
      const files = await invoke<[string, string][]>('read_ui_skeleton', { projectKey });
      if (files.length > 0) {
        await dispatchRenderPreview({
          projectKey, artifacts: Object.fromEntries(files), mode: '2d',
        });
      }
    } catch (_) { /* silently ignore disk errors */ }
  };

  const frameError = rendStatus.status === 'error' ? (rendStatus.message ?? '') : '';
  const statusLabel = pipelineStatus === 'running' ? 'building…' : frameError ? 'error' : pipelineStatus;
  const statusColor =
    frameError || pipelineStatus === 'fail' ? 'var(--danger)'
    : pipelineStatus === 'ok'               ? 'var(--success)'
    : 'var(--fg-dim)';

  return (
    <PipelineScreenFrame
      label="preview"
      badge={preview && <span className="tag" style={{ fontSize: 9 }}>{preview.mode}</span>}
      statusLabel={statusLabel}
      statusColor={statusColor}
      onClose={onClose}
      actions={
        <>
          {preview && currentScreen && (
            <button
              className={currentApproved ? 'btn sm' : 'btn ghost sm'}
              onClick={() => setUiScreenApproved(projectKey, currentScreen, !currentApproved)}
              title={currentApproved ? `${currentScreen} approved — click to revoke` : `Approve ${currentScreen}`}
              style={currentApproved ? { color: 'var(--success)', borderColor: 'var(--success)' } : undefined}
            >
              {currentApproved ? '✓ approved' : 'approve'}
            </button>
          )}
          {preview && <button className="btn ghost sm" onClick={renderDemo} title="Rebuild">↻</button>}
        </>
      }
      footer={declared.length > 0 && (
        <div style={{ borderTop: '1px solid var(--border-soft)', padding: '8px 12px', maxHeight: 180, overflow: 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--fg-muted)', marginBottom: 6 }}>
            <span>screens</span>
            <button
              className="btn ghost sm"
              title="Copy a Claude Design prompt for these screens"
              onClick={() => {
                void navigator.clipboard?.writeText(buildClaudeDesignBrief(declared));
                setBriefCopied(true);
                setTimeout(() => setBriefCopied(false), 1600);
              }}
            >{briefCopied ? '✓ copied' : '✦ Claude Design brief'}</button>
            <span style={{ flex: 1 }} />
            <span style={{ color: approvedCount === declared.length ? 'var(--success)' : 'var(--fg-dim)' }}>
              {approvedCount}/{declared.length} approved
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {declared.map((s) => {
              const ok = approvedList.includes(s);
              return (
                <button
                  key={s}
                  className="btn ghost sm"
                  onClick={() => setUiScreenApproved(projectKey, s, !ok)}
                  title={ok ? `${s} approved — click to revoke` : `Approve ${s}`}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-start', textAlign: 'left', fontFamily: 'var(--mono)', fontSize: 11 }}
                >
                  <span style={{ color: ok ? 'var(--success)' : 'var(--fg-dim)' }}>{ok ? '✓' : '○'}</span>
                  <span style={{ color: s === currentScreen ? 'var(--accent)' : 'var(--fg)' }}>{s}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    >
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {pipelineStatus === 'fail' ? (
          <div style={{ padding: 16, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--danger)', whiteSpace: 'pre-wrap', overflow: 'auto' }}>
            {run?.message || 'Preview failed to build.'}
          </div>
        ) : (
          <>
            {/* Persistent imperative surface — always in the DOM so containerRef is stable.
                Hidden when no renderer is active; the empty-state overlay covers it. */}
            <div
              ref={containerRef}
              style={{ flex: 1, display: activeKind ? 'flex' : 'none', minHeight: 0 }}
            />
            {!activeKind && (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24, textAlign: 'center' }}>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--fg-muted)' }}>
                  {pipelineStatus === 'running' ? 'Bundling…' : 'No preview yet'}
                </div>
                <div className="hint" style={{ maxWidth: 280 }}>
                  The UI stage renders generated screens here via the render-preview pipeline.
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn" onClick={loadSkeleton} disabled={pipelineStatus === 'running'}>load from skeleton →</button>
                  <button className="btn ghost" onClick={renderDemo} disabled={pipelineStatus === 'running'}>demo</button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </PipelineScreenFrame>
  );
}
