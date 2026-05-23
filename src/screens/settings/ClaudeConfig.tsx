import { useState, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../../store";
import type { ConfigProfile } from "../../store";

const TOOL_PRESETS: Array<{ label: string; allow: string[]; deny: string[] }> = [
  { label: "read-only",  allow: ["Read", "Glob", "Grep"],                        deny: ["Write", "Edit", "MultiEdit", "Bash", "WebFetch", "WebSearch"] },
  { label: "no-bash",    allow: [],                                               deny: ["Bash"] },
  { label: "no-web",     allow: [],                                               deny: ["WebFetch", "WebSearch"] },
  { label: "full",       allow: [],                                               deny: [] },
];

const COMMON_TOOLS = ["Read", "Write", "Edit", "MultiEdit", "Bash", "Glob", "Grep", "WebFetch", "WebSearch"];

function ToolChip({
  label, onRemove,
}: { label: string; onRemove: () => void }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      padding: "2px 8px", borderRadius: 4,
      background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
      fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-muted)",
    }}>
      {label}
      <span
        onClick={onRemove}
        style={{ color: "var(--fg-dim)", cursor: "pointer", lineHeight: 1 }}
      >×</span>
    </span>
  );
}

function ChipInput({
  value, onChange, onAdd, placeholder,
}: { value: string; onChange: (v: string) => void; onAdd: () => void; placeholder: string }) {
  return (
    <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
      <input
        className="input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onAdd(); } }}
        placeholder={placeholder}
        list="tool-suggestions"
        style={{ width: 130, height: 24, padding: "0 8px", fontFamily: "var(--mono)", fontSize: 10.5 }}
      />
      <datalist id="tool-suggestions">
        {COMMON_TOOLS.map((t) => <option key={t} value={t} />)}
      </datalist>
      <span
        onClick={onAdd}
        style={{
          padding: "2px 8px", borderRadius: 4, cursor: "pointer",
          background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
          fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-muted)",
        }}
      >+ add</span>
    </div>
  );
}

export function ClaudeConfigSettings() {
  const {
    projectLocalRepos, kbBlocks,
    configProfiles, addConfigProfile, updateConfigProfile, removeConfigProfile,
  } = useAppStore();

  // All unique resolved repos across all projects
  const allRepos = useMemo(() => {
    const seen = new Map<string, { full_name: string; local_path: string }>();
    for (const repos of Object.values(projectLocalRepos)) {
      for (const repo of repos) {
        seen.set(repo.full_name, repo);
      }
    }
    return Array.from(seen.values());
  }, [projectLocalRepos]);

  // Editor state
  const [target, setTarget]                 = useState("global");
  const [instructions, setInstructions]     = useState("");
  const [allow, setAllow]                   = useState<string[]>([]);
  const [deny, setDeny]                     = useState<string[]>([]);
  const [selectedKbIds, setSelectedKbIds]   = useState<Set<string>>(new Set());
  const [allowInput, setAllowInput]         = useState("");
  const [denyInput, setDenyInput]           = useState("");

  // Profile management
  const [activeProfileId, setActiveProfileId]   = useState<string | null>(null);
  const [showSaveDialog, setShowSaveDialog]     = useState(false);
  const [newProfileName, setNewProfileName]     = useState("");

  // Async status
  const [reading, setReading]               = useState(false);
  const [writing, setWriting]               = useState(false);
  const [writeStatus, setWriteStatus]       = useState<"idle" | "ok" | "error">("idle");
  const [writeMsg, setWriteMsg]             = useState("");
  const [readTick, setReadTick]             = useState(0);

  // Read from disk whenever the target changes or a manual re-read is requested
  useEffect(() => {
    setReading(true);
    setWriteStatus("idle");
    setSelectedKbIds(new Set());
    setActiveProfileId(null);
    const localPath = target === "global" ? "" : target;
    invoke<{ instructions: string; allow: string[]; deny: string[] }>(
      "read_claude_config", { localPath },
    ).then((data) => {
      setInstructions(data.instructions);
      setAllow(data.allow);
      setDeny(data.deny);
    }).catch(() => {
      setInstructions("");
      setAllow([]);
      setDeny([]);
    }).finally(() => setReading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, readTick]);

  function loadProfile(profile: ConfigProfile) {
    setInstructions(profile.instructions);
    setAllow(profile.tools.allow);
    setDeny(profile.tools.deny);
    setSelectedKbIds(new Set(profile.kbBlockIds));
    setActiveProfileId(profile.id);
    setWriteStatus("idle");
  }

  function applyPreset(preset: typeof TOOL_PRESETS[number]) {
    setAllow(preset.allow);
    setDeny(preset.deny);
  }

  function addToAllow() {
    const v = allowInput.trim();
    if (v && !allow.includes(v)) setAllow((a) => [...a, v]);
    setAllowInput("");
  }

  function addToDeny() {
    const v = denyInput.trim();
    if (v && !deny.includes(v)) setDeny((d) => [...d, v]);
    setDenyInput("");
  }

  function toggleKb(id: string) {
    setSelectedKbIds((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
    setActiveProfileId(null);
  }

  async function handleWrite() {
    setWriting(true);
    setWriteStatus("idle");
    try {
      const kbSections = kbBlocks
        .filter((b) => selectedKbIds.has(b.id))
        .map((b) => `\n\n---\n## ${b.title}\n\n${b.content}`)
        .join("");
      const finalInstructions = instructions + kbSections;
      await invoke("write_claude_config", {
        localPath:    target === "global" ? "" : target,
        instructions: finalInstructions,
        allow,
        deny,
      });
      setWriteStatus("ok");
      setWriteMsg("Written to disk.");
    } catch (e) {
      setWriteStatus("error");
      setWriteMsg(String(e));
    } finally {
      setWriting(false);
      setTimeout(() => setWriteStatus("idle"), 4000);
    }
  }

  function handleSaveProfile() {
    const name = newProfileName.trim();
    if (!name) return;
    if (activeProfileId) {
      updateConfigProfile(activeProfileId, {
        name,
        instructions,
        tools: { allow, deny },
        kbBlockIds: Array.from(selectedKbIds),
      });
    } else {
      addConfigProfile({
        name,
        instructions,
        tools: { allow, deny },
        kbBlockIds: Array.from(selectedKbIds),
      });
      // Find the newly added profile and select it
      const profiles = useAppStore.getState().configProfiles;
      setActiveProfileId(profiles[profiles.length - 1]?.id ?? null);
    }
    setNewProfileName("");
    setShowSaveDialog(false);
  }

  const targetLabel = target === "global"
    ? "global"
    : allRepos.find((r) => r.local_path === target)?.full_name ?? target;

  return (
    <div style={{ maxWidth: 900, display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <h2 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 16, fontWeight: 600 }}>
          Claude Configuration
        </h2>
        <div style={{ color: "var(--fg-muted)", fontSize: 12, marginTop: 4 }}>
          Edit CLAUDE.md instructions and tool permissions for each agent scope.
        </div>
      </div>

      {/* Target selector */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: ".06em" }}>
          target
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {(["global", ...allRepos.map((r) => r.local_path)] as string[]).map((t) => {
            const isGlobal = t === "global";
            const label = isGlobal ? "global (~/.claude/)" : (allRepos.find((r) => r.local_path === t)?.full_name ?? t);
            const on = target === t;
            return (
              <div
                key={t}
                onClick={() => setTarget(t)}
                style={{
                  padding: "5px 12px", borderRadius: 6, cursor: "pointer",
                  fontFamily: "var(--mono)", fontSize: 11,
                  background: on ? "var(--accent)" : "var(--bg-elev)",
                  color: on ? "#1a120a" : "var(--fg-muted)",
                  border: "1px solid " + (on ? "transparent" : "var(--border-soft)"),
                  fontWeight: on ? 600 : 400,
                }}
              >{label}</div>
            );
          })}
        </div>
        {allRepos.length === 0 && (
          <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-dim)" }}>
            Resolve repositories on the Projects board to unlock per-repo targets.
          </div>
        )}
      </div>

      {/* Profile bar */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "10px 14px",
        background: "var(--bg-panel)", border: "1px solid var(--border-soft)", borderRadius: 8,
      }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: ".06em" }}>profile</span>
        <select
          value={activeProfileId ?? ""}
          onChange={(e) => {
            const p = configProfiles.find((x) => x.id === e.target.value);
            if (p) loadProfile(p);
            else setActiveProfileId(null);
          }}
          style={{
            background: "var(--bg-canvas)", border: "1px solid var(--border-soft)",
            borderRadius: 4, padding: "3px 8px",
            fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg)",
          }}
        >
          <option value="">— custom / unsaved —</option>
          {configProfiles.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>

        {!showSaveDialog ? (
          <button
            className="btn ghost"
            style={{ height: 26, fontSize: 10.5 }}
            onClick={() => {
              setNewProfileName(configProfiles.find((p) => p.id === activeProfileId)?.name ?? "");
              setShowSaveDialog(true);
            }}
          >{activeProfileId ? "update profile" : "save as profile…"}</button>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input
              className="input"
              autoFocus
              value={newProfileName}
              onChange={(e) => setNewProfileName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSaveProfile(); if (e.key === "Escape") setShowSaveDialog(false); }}
              placeholder="profile name…"
              style={{ width: 160, height: 26, fontFamily: "var(--mono)", fontSize: 10.5 }}
            />
            <button className="btn primary" style={{ height: 26, fontSize: 10.5 }} onClick={handleSaveProfile}>save</button>
            <button className="btn ghost" style={{ height: 26, fontSize: 10.5 }} onClick={() => setShowSaveDialog(false)}>cancel</button>
          </div>
        )}

        {activeProfileId && (
          <button
            className="btn ghost"
            style={{ height: 26, fontSize: 10.5, color: "var(--danger)", marginLeft: 2 }}
            onClick={() => { removeConfigProfile(activeProfileId); setActiveProfileId(null); }}
          >delete</button>
        )}

        <div style={{ flex: 1 }} />
        <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-dim)" }}>
          {targetLabel}
        </span>
      </div>

      {/* Main editor grid */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 280px", gap: 14, alignItems: "start" }}>
        {/* Left: CLAUDE.md + KB selector */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{
            background: "var(--bg-panel)", border: "1px solid var(--border-soft)", borderRadius: 8,
            overflow: "hidden",
          }}>
            <div style={{
              padding: "8px 14px", borderBottom: "1px solid var(--border-soft)",
              background: "var(--bg-elev)",
              display: "flex", alignItems: "center", gap: 8,
              fontFamily: "var(--mono)", fontSize: 10,
            }}>
              <span style={{ color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: ".06em" }}>CLAUDE.md</span>
              {reading && <span style={{ color: "var(--fg-dim)" }}>loading…</span>}
              <div style={{ flex: 1 }} />
              <span style={{ color: "var(--fg-dim)" }}>{targetLabel}</span>
            </div>
            <textarea
              value={instructions}
              onChange={(e) => { setInstructions(e.target.value); setActiveProfileId(null); }}
              placeholder="# Instructions&#10;&#10;Write system-level instructions for Claude in this scope…"
              style={{
                width: "100%", minHeight: 260,
                background: "var(--bg-canvas)", border: "none", outline: "none",
                padding: "14px 16px",
                fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--fg)",
                resize: "vertical", lineHeight: 1.65,
                boxSizing: "border-box",
              }}
            />
          </div>

          {/* KB article selector */}
          <div style={{
            background: "var(--bg-panel)", border: "1px solid var(--border-soft)", borderRadius: 8,
            overflow: "hidden",
          }}>
            <div style={{
              padding: "8px 14px", borderBottom: "1px solid var(--border-soft)",
              background: "var(--bg-elev)",
              display: "flex", alignItems: "center", gap: 8,
              fontFamily: "var(--mono)", fontSize: 10,
            }}>
              <span style={{ color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: ".06em" }}>Knowledge articles</span>
              <span style={{ color: "var(--fg-dim)" }}>·</span>
              <span style={{ color: "var(--fg-dim)" }}>appended to CLAUDE.md when writing to disk</span>
              {selectedKbIds.size > 0 && (
                <span style={{
                  marginLeft: 4, padding: "0 6px", borderRadius: 99,
                  background: "color-mix(in oklch, var(--accent), transparent 80%)",
                  color: "var(--accent)", fontSize: 9,
                }}>{selectedKbIds.size} selected</span>
              )}
            </div>
            {kbBlocks.length === 0 ? (
              <div style={{ padding: "14px 16px", fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)", fontStyle: "italic" }}>
                No knowledge blocks yet. Create some in the Knowledge Store.
              </div>
            ) : (
              <div style={{ padding: "6px 0" }}>
                {kbBlocks.map((b) => {
                  const on = selectedKbIds.has(b.id);
                  return (
                    <div
                      key={b.id}
                      onClick={() => toggleKb(b.id)}
                      style={{
                        padding: "7px 16px", cursor: "pointer",
                        display: "flex", alignItems: "center", gap: 10,
                        background: on ? "color-mix(in oklch, var(--accent), transparent 92%)" : "transparent",
                        borderLeft: `3px solid ${on ? "var(--accent)" : "transparent"}`,
                      }}
                    >
                      <span style={{
                        width: 14, height: 14, borderRadius: 3, flexShrink: 0,
                        background: on ? "var(--accent)" : "var(--bg-elev)",
                        border: "1px solid " + (on ? "transparent" : "var(--border)"),
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 9, color: "#1a120a", fontWeight: 700,
                      }}>{on ? "✓" : ""}</span>
                      <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: on ? "var(--fg)" : "var(--fg-muted)", flex: 1 }}>
                        {b.title}
                      </span>
                      <div style={{ display: "flex", gap: 4 }}>
                        {b.tags.slice(0, 3).map((t) => (
                          <span key={t} className="tag" style={{ fontSize: 9 }}>{t}</span>
                        ))}
                      </div>
                      <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-dim)" }}>
                        {b.lines}L
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Right: tool permissions */}
        <div style={{
          background: "var(--bg-panel)", border: "1px solid var(--border-soft)", borderRadius: 8,
          overflow: "hidden",
        }}>
          <div style={{
            padding: "8px 14px", borderBottom: "1px solid var(--border-soft)",
            background: "var(--bg-elev)",
            fontFamily: "var(--mono)", fontSize: 10,
            color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: ".06em",
          }}>
            Tool permissions
          </div>
          <div style={{ padding: "14px 14px", display: "flex", flexDirection: "column", gap: 16 }}>
            {/* Presets */}
            <div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)", marginBottom: 7, textTransform: "uppercase", letterSpacing: ".06em" }}>quick presets</div>
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                {TOOL_PRESETS.map((p) => (
                  <span
                    key={p.label}
                    onClick={() => applyPreset(p)}
                    style={{
                      padding: "2px 8px", borderRadius: 4, cursor: "pointer",
                      fontFamily: "var(--mono)", fontSize: 10,
                      background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
                      color: "var(--fg-muted)",
                    }}
                  >{p.label}</span>
                ))}
              </div>
            </div>

            {/* Allow */}
            <div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--success)", marginBottom: 7, textTransform: "uppercase", letterSpacing: ".06em" }}>allow</div>
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 8 }}>
                {allow.length === 0 && (
                  <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-dim)", fontStyle: "italic" }}>all tools allowed</span>
                )}
                {allow.map((t) => (
                  <ToolChip key={t} label={t} onRemove={() => setAllow((a) => a.filter((x) => x !== t))} />
                ))}
              </div>
              <ChipInput
                value={allowInput}
                onChange={setAllowInput}
                onAdd={addToAllow}
                placeholder="tool name…"
              />
            </div>

            {/* Deny */}
            <div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--danger)", marginBottom: 7, textTransform: "uppercase", letterSpacing: ".06em" }}>deny</div>
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 8 }}>
                {deny.length === 0 && (
                  <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-dim)", fontStyle: "italic" }}>nothing denied</span>
                )}
                {deny.map((t) => (
                  <ToolChip key={t} label={t} onRemove={() => setDeny((d) => d.filter((x) => x !== t))} />
                ))}
              </div>
              <ChipInput
                value={denyInput}
                onChange={setDenyInput}
                onAdd={addToDeny}
                placeholder="tool name…"
              />
            </div>

            {/* Settings.json preview */}
            {(allow.length > 0 || deny.length > 0) && (
              <div style={{
                padding: "10px 12px", borderRadius: 6,
                background: "var(--bg-canvas)", border: "1px solid var(--border-soft)",
                fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)",
                whiteSpace: "pre",
              }}>
                {JSON.stringify({ permissions: { allow, deny } }, null, 2)}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Write bar */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "10px 14px",
        background: "var(--bg-panel)", border: "1px solid var(--border-soft)", borderRadius: 8,
      }}>
        {writeStatus === "ok" && (
          <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--success)" }}>✓ {writeMsg}</span>
        )}
        {writeStatus === "error" && (
          <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--danger)" }}>{writeMsg}</span>
        )}
        {writeStatus === "idle" && (
          <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)" }}>
            {selectedKbIds.size > 0
              ? `${selectedKbIds.size} KB article${selectedKbIds.size > 1 ? "s" : ""} will be appended to CLAUDE.md`
              : "CLAUDE.md and .claude/settings.json"}
          </span>
        )}
        <div style={{ flex: 1 }} />
        <button
          className="btn ghost"
          style={{ height: 28, fontSize: 11 }}
          disabled={reading}
          onClick={() => setReadTick((n) => n + 1)}
        >
          {reading ? "reading…" : "↺ read from disk"}
        </button>
        <button
          className="btn primary"
          style={{ height: 28, fontSize: 11 }}
          disabled={writing || reading}
          onClick={handleWrite}
        >
          {writing ? "writing…" : "↓ write to disk"}
        </button>
      </div>
    </div>
  );
}
