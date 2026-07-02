import { useState, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import type { ConfigProfile } from "@/store";
import { projectRepoCwd, isKnownPublishedKey } from "@/shared/lib/core/projectPaths";
import { TOOL_PRESETS } from "../lib/toolPresets";
import { ToolChip, ChipInput } from "../ToolPermissionInputs";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Grid } from "@/shared/ui/layout/Grid";
import { Spacer } from "@/shared/ui/layout/Spacer";
import { Button } from "@/shared/ui/controls/Button";

export function ClaudeConfigCard() {
  const {
    projectLocalRepos, bscBaseDir, projectKeyAlias,
    configProfiles, addConfigProfile, updateConfigProfile, removeConfigProfile,
  } = useAppStore();

  // All unique cloned repos across all projects, with their local clone paths.
  // Repos live under `<base>/projects/<projectKey>/<repoShort>`, so the path is
  // derived from the project key each repo was cloned under.
  const allRepos = useMemo(() => {
    const seen = new Map<string, string>(); // full_name → local_path (first seen wins)
    for (const [projectKey, fullNames] of Object.entries(projectLocalRepos)) {
      // Published hubs live under projects/, drafts under draft/ (#904). The key may be a board
      // node id (a key in the alias) or a folder key (a value) — either means published.
      const published = projectKey in projectKeyAlias || isKnownPublishedKey(projectKey, projectKeyAlias);
      for (const fullName of fullNames) {
        if (!seen.has(fullName)) seen.set(fullName, projectRepoCwd(bscBaseDir, projectKey, fullName, published));
      }
    }
    return Array.from(seen.entries()).map(([fullName, local_path]) => ({
      full_name: fullName,
      local_path,
    }));
  }, [projectLocalRepos, bscBaseDir, projectKeyAlias]);

  // Editor state
  const [target, setTarget]                 = useState("global");
  const [instructions, setInstructions]     = useState("");
  const [allow, setAllow]                   = useState<string[]>([]);
  const [deny, setDeny]                     = useState<string[]>([]);
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

  async function handleWrite() {
    setWriting(true);
    setWriteStatus("idle");
    try {
      await invoke("write_claude_config", {
        localPath:    target === "global" ? "" : target,
        instructions,
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
      });
    } else {
      addConfigProfile({
        name,
        instructions,
        tools: { allow, deny },
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
    <Stack gap={20} style={{ maxWidth: 900 }}>
      <div>
        <h2 className="mono" style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
          Claude Configuration
        </h2>
        <div style={{ color: "var(--fg-muted)", fontSize: 12, marginTop: 4 }}>
          Edit CLAUDE.md instructions and tool permissions for each agent scope.
        </div>
      </div>

      {/* Target selector */}
      <Stack gap={6}>
        <div className="mono-label">
          target
        </div>
        <Row gap={6} align="stretch" wrap>
          {(["global", ...allRepos.map((r) => r.local_path)] as string[]).map((t) => {
            const isGlobal = t === "global";
            const label = isGlobal ? "global (~/.claude/)" : (allRepos.find((r) => r.local_path === t)?.full_name ?? t);
            const on = target === t;
            return (
              <div
                key={t}
                className="mono"
                onClick={() => setTarget(t)}
                style={{
                  padding: "5px 12px", borderRadius: 6, cursor: "pointer",
                  fontSize: 11,
                  background: on ? "var(--accent)" : "var(--bg-elev)",
                  color: on ? "#1a120a" : "var(--fg-muted)",
                  border: "1px solid " + (on ? "transparent" : "var(--border-soft)"),
                  fontWeight: on ? 600 : 400,
                }}
              >{label}</div>
            );
          })}
        </Row>
        {allRepos.length === 0 && (
          <div className="mono-caption">
            Resolve repositories on the Projects board to unlock per-repo targets.
          </div>
        )}
      </Stack>

      {/* Profile bar */}
      <Row gap={10} style={{
        padding: "10px 14px",
        background: "var(--bg-panel)", border: "1px solid var(--border-soft)", borderRadius: 8,
      }}>
        <span className="mono-label">profile</span>
        <select
          value={activeProfileId ?? ""}
          onChange={(e) => {
            const p = configProfiles.find((x) => x.id === e.target.value);
            if (p) loadProfile(p);
            else setActiveProfileId(null);
          }}
          className="mono"
          style={{
            background: "var(--bg-canvas)", border: "1px solid var(--border-soft)",
            borderRadius: 4, padding: "3px 8px",
            fontSize: 11, color: "var(--fg)",
          }}
        >
          <option value="">— custom / unsaved —</option>
          {configProfiles.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>

        {!showSaveDialog ? (
          <Button
            variant="ghost"
            style={{ height: 26, fontSize: 10.5 }}
            onClick={() => {
              setNewProfileName(configProfiles.find((p) => p.id === activeProfileId)?.name ?? "");
              setShowSaveDialog(true);
            }}
          >{activeProfileId ? "update profile" : "save as profile…"}</Button>
        ) : (
          <Row gap={6}>
            <input
              className="input mono"
              autoFocus
              value={newProfileName}
              onChange={(e) => setNewProfileName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSaveProfile(); if (e.key === "Escape") setShowSaveDialog(false); }}
              placeholder="profile name…"
              style={{ width: 160, height: 26, fontSize: 10.5 }}
            />
            <Button variant="primary" style={{ height: 26, fontSize: 10.5 }} onClick={handleSaveProfile}>save</Button>
            <Button variant="ghost" style={{ height: 26, fontSize: 10.5 }} onClick={() => setShowSaveDialog(false)}>cancel</Button>
          </Row>
        )}

        {activeProfileId && (
          <Button
            variant="ghost"
            style={{ height: 26, fontSize: 10.5, color: "var(--danger)", marginLeft: 2 }}
            onClick={() => { removeConfigProfile(activeProfileId); setActiveProfileId(null); }}
          >delete</Button>
        )}

        <Spacer />
        <span className="mono-caption">
          {targetLabel}
        </span>
      </Row>

      {/* Main editor grid */}
      <Grid cols="1fr 280px" gap={14} align="start">
        {/* Left: CLAUDE.md */}
        <Stack gap={10}>
          <div style={{
            background: "var(--bg-panel)", border: "1px solid var(--border-soft)", borderRadius: 8,
            overflow: "hidden",
          }}>
            <Row className="mono" gap={8} style={{
              padding: "8px 14px", borderBottom: "1px solid var(--border-soft)",
              background: "var(--bg-elev)",
              fontSize: 10,
            }}>
              <span style={{ color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: ".06em" }}>CLAUDE.md</span>
              {reading && <span style={{ color: "var(--fg-dim)" }}>loading…</span>}
              <Spacer />
              <span style={{ color: "var(--fg-dim)" }}>{targetLabel}</span>
            </Row>
            <textarea
              className="mono"
              value={instructions}
              onChange={(e) => { setInstructions(e.target.value); setActiveProfileId(null); }}
              placeholder="# Instructions&#10;&#10;Write system-level instructions for Claude in this scope…"
              style={{
                width: "100%", minHeight: 260,
                background: "var(--bg-canvas)", border: "none", outline: "none",
                padding: "14px 16px",
                fontSize: 11.5, color: "var(--fg)",
                resize: "vertical", lineHeight: 1.65,
                boxSizing: "border-box",
              }}
            />
          </div>
        </Stack>

        {/* Right: tool permissions */}
        <div style={{
          background: "var(--bg-panel)", border: "1px solid var(--border-soft)", borderRadius: 8,
          overflow: "hidden",
        }}>
          <div className="mono" style={{
            padding: "8px 14px", borderBottom: "1px solid var(--border-soft)",
            background: "var(--bg-elev)",
            fontSize: 10,
            color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: ".06em",
          }}>
            Tool permissions
          </div>
          <Stack gap={16} style={{ padding: "14px 14px" }}>
            {/* Presets */}
            <div>
              <div className="mono" style={{ fontSize: 9.5, color: "var(--fg-dim)", marginBottom: 7, textTransform: "uppercase", letterSpacing: ".06em" }}>quick presets</div>
              <Row gap={5} align="stretch" wrap>
                {TOOL_PRESETS.map((p) => (
                  <span
                    key={p.label}
                    className="mono"
                    onClick={() => applyPreset(p)}
                    style={{
                      padding: "2px 8px", borderRadius: 4, cursor: "pointer",
                      fontSize: 10,
                      background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
                      color: "var(--fg-muted)",
                    }}
                  >{p.label}</span>
                ))}
              </Row>
            </div>

            {/* Allow */}
            <div>
              <div className="mono" style={{ fontSize: 9.5, color: "var(--success)", marginBottom: 7, textTransform: "uppercase", letterSpacing: ".06em" }}>allow</div>
              <Row gap={5} align="stretch" wrap style={{ marginBottom: 8 }}>
                {allow.length === 0 && (
                  <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-dim)", fontStyle: "italic" }}>all tools allowed</span>
                )}
                {allow.map((t) => (
                  <ToolChip key={t} label={t} onRemove={() => setAllow((a) => a.filter((x) => x !== t))} />
                ))}
              </Row>
              <ChipInput
                value={allowInput}
                onChange={setAllowInput}
                onAdd={addToAllow}
                placeholder="tool name…"
              />
            </div>

            {/* Deny */}
            <div>
              <div className="mono" style={{ fontSize: 9.5, color: "var(--danger)", marginBottom: 7, textTransform: "uppercase", letterSpacing: ".06em" }}>deny</div>
              <Row gap={5} align="stretch" wrap style={{ marginBottom: 8 }}>
                {deny.length === 0 && (
                  <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-dim)", fontStyle: "italic" }}>nothing denied</span>
                )}
                {deny.map((t) => (
                  <ToolChip key={t} label={t} onRemove={() => setDeny((d) => d.filter((x) => x !== t))} />
                ))}
              </Row>
              <ChipInput
                value={denyInput}
                onChange={setDenyInput}
                onAdd={addToDeny}
                placeholder="tool name…"
              />
            </div>

            {/* Settings.json preview */}
            {(allow.length > 0 || deny.length > 0) && (
              <div className="mono" style={{
                padding: "10px 12px", borderRadius: 6,
                background: "var(--bg-canvas)", border: "1px solid var(--border-soft)",
                fontSize: 9.5, color: "var(--fg-dim)",
                whiteSpace: "pre",
              }}>
                {JSON.stringify({ permissions: { allow, deny } }, null, 2)}
              </div>
            )}
          </Stack>
        </div>
      </Grid>

      {/* Write bar */}
      <Row gap={10} style={{
        padding: "10px 14px",
        background: "var(--bg-panel)", border: "1px solid var(--border-soft)", borderRadius: 8,
      }}>
        {writeStatus === "ok" && (
          <span className="mono" style={{ fontSize: 11, color: "var(--success)" }}>✓ {writeMsg}</span>
        )}
        {writeStatus === "error" && (
          <span className="mono" style={{ fontSize: 11, color: "var(--danger)" }}>{writeMsg}</span>
        )}
        {writeStatus === "idle" && (
          <span className="mono" style={{ fontSize: 11, color: "var(--fg-dim)" }}>
            CLAUDE.md and .claude/settings.json
          </span>
        )}
        <Spacer />
        <Button
          variant="ghost"
          style={{ height: 28, fontSize: 11 }}
          disabled={reading}
          onClick={() => setReadTick((n) => n + 1)}
        >
          {reading ? "reading…" : "↺ read from disk"}
        </Button>
        <Button
          variant="primary"
          style={{ height: 28, fontSize: 11 }}
          disabled={writing || reading}
          onClick={handleWrite}
        >
          {writing ? "writing…" : "↓ write to disk"}
        </Button>
      </Row>
    </Stack>
  );
}
