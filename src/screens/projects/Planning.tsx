import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useAppStore } from "../../store";

type SectionKey = "goal" | "scope" | "stack" | "phases" | "risks";
type SectionState = "pending" | "drafted" | "confirmed";

interface Section {
  k: SectionKey;
  title: string;
  state: SectionState;
  content: string;
}

interface PhaseItem {
  name: string;
  description: string;
  dueWeeks: number;
}

const SECTION_DEFS: { k: SectionKey; title: string }[] = [
  { k: "goal",   title: "Goal"   },
  { k: "scope",  title: "Scope"  },
  { k: "stack",  title: "Stack"  },
  { k: "phases", title: "Phases" },
  { k: "risks",  title: "Risks"  },
];

const PANE_ID = "planning";

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

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][AB012]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

function parsePhases(content: string): PhaseItem[] {
  try { return JSON.parse(content); } catch { return []; }
}

function PlanSectionCard({
  section,
  onConfirm,
  onReject,
}: {
  section: Section;
  onConfirm: (k: SectionKey) => void;
  onReject: (k: SectionKey) => void;
}) {
  const stateColor = {
    confirmed: "var(--success)",
    drafted:   "var(--accent)",
    pending:   "var(--fg-dim)",
  }[section.state];

  const stateLabel = {
    confirmed: "✓ confirmed",
    drafted:   "✎ drafted",
    pending:   "○ pending",
  }[section.state];

  const phases = section.k === "phases" ? parsePhases(section.content) : [];

  return (
    <div style={{
      borderRadius: 6,
      border: "1px solid " + (section.state === "drafted" ? "var(--accent-dim)" : "var(--border-soft)"),
      background: "var(--bg-canvas)",
      opacity: section.state === "pending" ? 0.5 : 1,
      overflow: "hidden",
    }}>
      <div style={{
        padding: "7px 10px", background: "var(--bg-elev)",
        borderBottom: section.state === "pending" ? "0" : "1px solid var(--border-soft)",
        display: "flex", alignItems: "center", gap: 8,
        fontFamily: "var(--mono)", fontSize: 10.5,
      }}>
        <span style={{ color: "var(--fg)" }}>{section.title}</span>
        <div style={{ flex: 1 }} />
        <span style={{ color: stateColor, fontSize: 10 }}>{stateLabel}</span>
        {section.state === "drafted" && (
          <>
            <button
              onClick={() => onConfirm(section.k)}
              style={{
                padding: "1px 7px", borderRadius: 3, cursor: "pointer",
                background: "color-mix(in oklch, var(--success), transparent 80%)",
                border: "1px solid var(--success)", color: "var(--success)",
                fontFamily: "var(--mono)", fontSize: 9.5,
              }}
            >✓ confirm</button>
            <button
              onClick={() => onReject(section.k)}
              style={{
                padding: "1px 7px", borderRadius: 3, cursor: "pointer",
                background: "transparent",
                border: "1px solid var(--border-soft)", color: "var(--fg-dim)",
                fontFamily: "var(--mono)", fontSize: 9.5,
              }}
            >✗ redo</button>
          </>
        )}
      </div>
      {section.state !== "pending" && (
        <div style={{ padding: "10px 12px", fontSize: 11.5, color: "var(--fg-muted)", lineHeight: 1.55 }}>
          {section.k === "phases" && phases.length > 0
            ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {phases.map((ph, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "baseline", gap: 8, fontFamily: "var(--mono)", fontSize: 10.5 }}>
                    <span style={{ color: "var(--accent)" }}>·</span>
                    <span style={{ color: "var(--fg)" }}>{ph.name}</span>
                    <span className="tag" style={{ fontSize: 9 }}>week {ph.dueWeeks}</span>
                    {ph.description && <span style={{ color: "var(--fg-dim)" }}>— {ph.description}</span>}
                  </div>
                ))}
              </div>
            )
            : <div style={{ whiteSpace: "pre-wrap" }}>{section.content}</div>
          }
        </div>
      )}
    </div>
  );
}

function PublishPreview({ sections, repo }: { sections: Section[]; repo: string }) {
  const goalSection = sections.find(s => s.k === "goal");
  const phasesSection = sections.find(s => s.k === "phases");
  const phases = phasesSection?.content ? parsePhases(phasesSection.content) : [];
  const shortGoal = goalSection?.content?.split(/[.!?]/)[0]?.trim() ?? "New project";

  return (
    <div style={{
      padding: "12px 14px", borderRadius: 6,
      background: "color-mix(in oklch, var(--info), transparent 90%)",
      border: "1px solid color-mix(in oklch, var(--info), transparent 70%)",
      fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-muted)", lineHeight: 1.6,
    }}>
      <div style={{ color: "var(--info)", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 6 }}>
        will publish (confirm all sections first)
      </div>
      {goalSection?.content && <div>+ project name · <b style={{ color: "var(--fg)" }}>{shortGoal}</b></div>}
      {phases.length > 0 && <div>+ {phases.length} milestone{phases.length !== 1 ? "s" : ""} · one per phase</div>}
      {phases.length > 0 && <div>+ {phases.length} tracking issue{phases.length !== 1 ? "s" : ""}</div>}
      {repo
        ? <div>→ <b style={{ color: "var(--fg)" }}>{repo}</b></div>
        : <div style={{ color: "var(--warning)" }}>⚠ no repo selected — go back and pick one</div>
      }
    </div>
  );
}

export function Planning() {
  const {
    setProjectsView,
    planningPitch, planningRepo,
    activeProjectId, activeProjectName, activeProjectNumber,
    githubToken,
    kbBlocks,
  } = useAppStore();

  const isExisting = !!activeProjectId;

  const [sections, setSections] = useState<Section[]>(
    SECTION_DEFS.map(d => ({ ...d, state: "pending" as SectionState, content: "" }))
  );
  const [publishing, setPublishing] = useState(false);
  const [publishResult, setPublishResult] = useState<string | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);

  const containerRef   = useRef<HTMLDivElement>(null);
  const termRef        = useRef<Terminal | null>(null);
  const fitRef         = useRef<FitAddon | null>(null);
  const unlistenData   = useRef<UnlistenFn | null>(null);
  const unlistenExit   = useRef<UnlistenFn | null>(null);
  // Accumulated stripped output used to scan for complete <plan_update> tags
  const bufRef         = useRef("");

  const confirmedCount   = sections.filter(s => s.state === "confirmed").length;
  const draftedOrConfirmed = sections.filter(s => s.state !== "pending").length;
  const allConfirmed     = confirmedCount === SECTION_DEFS.length;
  const progress         = confirmedCount / SECTION_DEFS.length;

  // Mount xterm.js and spawn the planning PTY (once per Planning screen lifecycle).
  // pty_kill is called on unmount so navigating away ends the session cleanly.
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
      invoke("pty_write", { paneId: PANE_ID, data }).catch(console.error);
    });

    // Capture KB state at mount time for workspace sync.
    const kbSnapshot = kbBlocks;

    requestAnimationFrame(async () => {
      fitAddon.fit();

      // Subscribe before creating the PTY so we never miss early output.
      unlistenData.current = await listen<string>(`pty_data_${PANE_ID}`, ev => {
        term.write(ev.payload);

        // Parse <plan_update> tags out of the stripped output stream.
        bufRef.current += stripAnsi(ev.payload);
        const re = /<plan_update section="(\w+)">([\s\S]*?)<\/plan_update>/g;
        let m: RegExpExecArray | null;
        let found = false;
        while ((m = re.exec(bufRef.current)) !== null) {
          const key = m[1] as SectionKey;
          const content = m[2].trim();
          if (SECTION_DEFS.some(d => d.k === key)) {
            setSections(prev => {
              const idx = prev.findIndex(s => s.k === key);
              if (idx >= 0 && prev[idx].state !== "confirmed") {
                const next = [...prev];
                next[idx] = { ...next[idx], state: "drafted", content };
                return next;
              }
              return prev;
            });
            found = true;
          }
        }
        // Remove consumed tags so we don't re-process them on the next chunk.
        if (found) {
          bufRef.current = bufRef.current.replace(
            /<plan_update section="\w+">([\s\S]*?)<\/plan_update>/g, ""
          );
        }
      });

      unlistenExit.current = await listen<unknown>(`pty_exit_${PANE_ID}`, () => {
        term.write("\r\n\x1b[33m[session ended — navigate away and back to restart]\x1b[0m\r\n");
      });

      // Create isolated workspace directories with settings.json + CLAUDE.md,
      // and sync all KB blocks to disk so the planner can Read them via ../kb/.
      const paths = await invoke<{ kb_dir: string; planning_dir: string }>(
        "setup_workspaces",
        {
          kbBlocks: kbSnapshot.map(b => ({
            id:      b.id,
            title:   b.title,
            tags:    b.tags,
            content: b.content,
          })),
        },
      ).catch((e: unknown) => {
        console.error("workspace setup failed:", e);
        return null;
      });

      // Launch claude inside the isolated planning directory.
      await invoke("pty_create", {
        paneId:  PANE_ID,
        cols:    term.cols,
        rows:    term.rows,
        cwd:     paths?.planning_dir ?? "",
        initCmd: "claude",
      }).catch(console.error);
    });

    const ro = new ResizeObserver(() => {
      fitAddon.fit();
      invoke("pty_resize", { paneId: PANE_ID, cols: term.cols, rows: term.rows }).catch(console.error);
    });
    ro.observe(el);

    return () => {
      unlistenData.current?.();
      unlistenExit.current?.();
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current  = null;
      invoke("pty_kill", { paneId: PANE_ID }).catch(console.error);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function handleConfirm(k: SectionKey) {
    setSections(prev => prev.map(s => s.k === k ? { ...s, state: "confirmed" } : s));
  }

  function handleReject(k: SectionKey) {
    setSections(prev => prev.map(s => s.k === k ? { ...s, state: "pending", content: "" } : s));
  }

  async function handlePublish() {
    if (!allConfirmed || !planningRepo || !githubToken) return;
    setPublishing(true);
    setPublishError(null);
    setPublishResult(null);
    try {
      const phasesSection = sections.find(s => s.k === "phases");
      const phases = phasesSection?.content ? parsePhases(phasesSection.content) : [];
      const goalSection = sections.find(s => s.k === "goal");
      const projectTitle = goalSection?.content?.split(/[.!?]/)[0]?.trim() ?? "New project";

      const now = new Date();
      const published: string[] = [];

      for (const phase of phases) {
        const dueDate = new Date(now);
        dueDate.setDate(now.getDate() + phase.dueWeeks * 7);

        const ms = await invoke<{ number: number }>("github_post", {
          token: githubToken,
          path:  `repos/${planningRepo}/milestones`,
          body:  {
            title:       phase.name,
            description: phase.description,
            due_on:      dueDate.toISOString(),
          },
        });

        const issue = await invoke<{ number: number }>("github_post", {
          token: githubToken,
          path:  `repos/${planningRepo}/issues`,
          body:  {
            title:     `[${phase.name}] ${projectTitle}`,
            body:      `## ${phase.name}\n\n${phase.description}\n\n---\n_Auto-generated by base-studio-code planner._`,
            milestone: ms.number,
          },
        });

        published.push(`#${issue.number}`);
      }

      setPublishResult(
        `Published ${phases.length} milestone${phases.length !== 1 ? "s" : ""} + issues ${published.join(", ")} to ${planningRepo}`
      );
    } catch (e) {
      setPublishError(String(e));
    } finally {
      setPublishing(false);
    }
  }

  const remainingPct = Math.round((1 - progress) * 100);

  return (
    <>
      {/* Header */}
      <div style={{ padding: "14px 24px 0", display: "flex", alignItems: "flex-start", gap: 14 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <button
              onClick={() => setProjectsView(isExisting ? "board" : "list")}
              style={{
                background: "none", border: "none", cursor: "pointer",
                fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-muted)",
                padding: 0, marginRight: 4,
              }}
            >{isExisting ? "← board" : "← projects"}</button>
            <span style={{ color: "var(--border-soft)" }}>·</span>
            {isExisting
              ? (
                <>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>#{activeProjectNumber}</span>
                  <h2 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 16, fontWeight: 600 }}>{activeProjectName}</h2>
                </>
              )
              : (
                <h2 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 16, fontWeight: 600 }}>
                  {planningPitch
                    ? (planningPitch.length > 60 ? planningPitch.slice(0, 60) + "…" : planningPitch)
                    : "New project"}
                </h2>
              )
            }
            <span className="tag amber">● {isExisting ? "expanding" : "drafting"}</span>
            {planningRepo && <span className="tag">{planningRepo}</span>}
          </div>
          <div style={{ color: "var(--fg-muted)", fontSize: 12, marginTop: 4 }}>
            claude cli · interactive pty · {confirmedCount}/{SECTION_DEFS.length} sections confirmed
          </div>
        </div>
        <button className="btn ghost" onClick={() => setProjectsView(isExisting ? "board" : "list")}>
          save & exit
        </button>
        {allConfirmed
          ? (
            <button
              className="btn primary"
              onClick={handlePublish}
              disabled={publishing || !planningRepo}
            >{publishing ? "publishing…" : "publish to github →"}</button>
          )
          : (
            <button className="btn primary" disabled style={{ opacity: 0.5, cursor: "not-allowed" }}>
              publish to github · {remainingPct > 0 ? `${remainingPct}% to go` : "confirm all sections"}
            </button>
          )
        }
      </div>

      {/* Section progress bar */}
      <div style={{ padding: "14px 24px 12px", display: "flex", gap: 6 }}>
        {sections.map(s => {
          const tone = s.state === "confirmed" ? "var(--accent)"
                     : s.state === "drafted"   ? "color-mix(in oklch, var(--accent), transparent 50%)"
                     : "var(--bg-elev2)";
          return (
            <div key={s.k} style={{ flex: 1, height: 5, borderRadius: 3, background: tone }} title={s.title} />
          );
        })}
      </div>

      {/* Split panel */}
      <div style={{ flex: 1, display: "flex", minHeight: 0, borderTop: "1px solid var(--border-soft)" }}>
        {/* Claude CLI terminal */}
        <section style={{ flex: "1 1 0", display: "flex", flexDirection: "column", borderRight: "1px solid var(--border-soft)" }}>
          <div style={{
            padding: "10px 18px", background: "var(--bg-panel)",
            borderBottom: "1px solid var(--border-soft)",
            display: "flex", alignItems: "center", gap: 8,
            fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-muted)",
          }}>
            <span style={{ color: "var(--accent)" }}>▸ claude cli · planning session</span>
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 10, color: "var(--fg-dim)" }}>
              emit{" "}
              <code style={{ color: "var(--fg)", background: "var(--bg-elev)", padding: "0 4px", borderRadius: 3 }}>
                &lt;plan_update section="goal"&gt;…&lt;/plan_update&gt;
              </code>
              {" "}to populate sections →
            </span>
          </div>

          {(publishResult || publishError) && (
            <div style={{
              padding: "8px 18px",
              borderBottom: `1px solid ${publishResult ? "var(--success)" : "var(--danger)"}`,
              background: publishResult
                ? "color-mix(in oklch, var(--success), transparent 88%)"
                : "color-mix(in oklch, var(--danger), transparent 88%)",
              fontFamily: "var(--mono)", fontSize: 10.5,
              color: publishResult ? "var(--success)" : "var(--danger)",
            }}>
              {publishResult ? `✓ ${publishResult}` : `✗ ${publishError}`}
            </div>
          )}

          <div
            ref={containerRef}
            style={{
              flex: 1, minHeight: 0, overflow: "hidden",
              background: TERM_THEME.background as string,
              display: "flex",
              padding: "6px 4px",
            }}
          />
        </section>

        {/* Plan sections panel */}
        <aside style={{ flex: "0 0 430px", display: "flex", flexDirection: "column", background: "var(--bg-panel)" }}>
          <div style={{
            padding: "10px 18px", borderBottom: "1px solid var(--border-soft)",
            display: "flex", alignItems: "center", gap: 8,
            fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-muted)",
          }}>
            <span style={{ color: "var(--accent)" }}>
              ⌘ plan · {draftedOrConfirmed > 0 ? "building" : "waiting"}
            </span>
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 10 }}>{confirmedCount}/{SECTION_DEFS.length} confirmed</span>
          </div>
          <div style={{ flex: 1, overflow: "auto", padding: "14px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
            {sections.map(s => (
              <PlanSectionCard
                key={s.k}
                section={s}
                onConfirm={handleConfirm}
                onReject={handleReject}
              />
            ))}
            <PublishPreview sections={sections} repo={planningRepo} />
          </div>
        </aside>
      </div>
    </>
  );
}
