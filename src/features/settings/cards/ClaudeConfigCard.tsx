import { useState, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import type { ConfigProfile } from "@/store";
import { TOOL_PRESETS } from "../lib/toolPresets";
import { Stack } from "@/shared/ui/layout/Stack";
import { Grid } from "@/shared/ui/layout/Grid";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { deriveAllRepos } from "./claudeConfig.helpers";
import { TargetSelector } from "./TargetSelector";
import { ProfileBar } from "./ProfileBar";
import { ClaudeMdEditor } from "./ClaudeMdEditor";
import { ToolPermissionsPanel } from "./ToolPermissionsPanel";
import { WriteBar } from "./WriteBar";

export function ClaudeConfigCard() {
  const {
    projectLocalRepos, bscBaseDir,
    configProfiles, addConfigProfile, updateConfigProfile, removeConfigProfile,
  } = useAppStore();

  // All unique cloned repos across all projects, with their local clone paths.
  // Repos live under `<base>/projects/<projectKey>/<repoShort>`, so the path is
  // derived from the project key each repo was cloned under.
  const allRepos = useMemo(
    () => deriveAllRepos(projectLocalRepos, bscBaseDir),
    [projectLocalRepos, bscBaseDir],
  );

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
      <Box>
        <Text as="h2" mono size={16} weight={600} style={{ margin: 0 }}>
          Claude Configuration
        </Text>
        <Text as="div" tone="muted" size={12} style={{ marginTop: 4 }}>
          Edit CLAUDE.md instructions and tool permissions for each agent scope.
        </Text>
      </Box>

      {/* Target selector */}
      <TargetSelector allRepos={allRepos} target={target} setTarget={setTarget} />

      {/* Profile bar */}
      <ProfileBar
        configProfiles={configProfiles}
        activeProfileId={activeProfileId}
        setActiveProfileId={setActiveProfileId}
        loadProfile={loadProfile}
        showSaveDialog={showSaveDialog}
        setShowSaveDialog={setShowSaveDialog}
        newProfileName={newProfileName}
        setNewProfileName={setNewProfileName}
        handleSaveProfile={handleSaveProfile}
        removeConfigProfile={removeConfigProfile}
        targetLabel={targetLabel}
      />

      {/* Main editor grid */}
      <Grid cols="1fr 280px" gap={14} align="start">
        {/* Left: CLAUDE.md */}
        <ClaudeMdEditor
          instructions={instructions}
          setInstructions={setInstructions}
          setActiveProfileId={setActiveProfileId}
          reading={reading}
          targetLabel={targetLabel}
        />

        {/* Right: tool permissions */}
        <ToolPermissionsPanel
          allow={allow}
          setAllow={setAllow}
          deny={deny}
          setDeny={setDeny}
          allowInput={allowInput}
          setAllowInput={setAllowInput}
          denyInput={denyInput}
          setDenyInput={setDenyInput}
          applyPreset={applyPreset}
          addToAllow={addToAllow}
          addToDeny={addToDeny}
        />
      </Grid>

      {/* Write bar */}
      <WriteBar
        writeStatus={writeStatus}
        writeMsg={writeMsg}
        reading={reading}
        writing={writing}
        setReadTick={setReadTick}
        handleWrite={handleWrite}
      />
    </Stack>
  );
}
