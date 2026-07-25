// The profile-management bar for the Claude Config editor (#2128), extracted verbatim from
// ClaudeConfigCard.tsx. Handles selecting / saving / updating / deleting config profiles.

import type { ConfigProfile } from "@/store";
import { Row } from "@/shared/ui/layout/Row";
import { Spacer } from "@/shared/ui/layout/Spacer";
import { Button } from "@/shared/ui/controls/Button";
import { Box } from "@/shared/ui/layout/Box";

export function ProfileBar({
  configProfiles, activeProfileId, setActiveProfileId, loadProfile,
  showSaveDialog, setShowSaveDialog, newProfileName, setNewProfileName,
  handleSaveProfile, removeConfigProfile, targetLabel,
}: {
  configProfiles: ConfigProfile[];
  activeProfileId: string | null;
  setActiveProfileId: (id: string | null) => void;
  loadProfile: (profile: ConfigProfile) => void;
  showSaveDialog: boolean;
  setShowSaveDialog: (v: boolean) => void;
  newProfileName: string;
  setNewProfileName: (v: string) => void;
  handleSaveProfile: () => void;
  removeConfigProfile: (id: string) => void;
  targetLabel: string;
}) {
  return (
    <Row gap={10} style={{
      padding: "10px 14px",
      background: "var(--bg-panel)", border: "1px solid var(--border-soft)", borderRadius: 8,
    }}>
      <Box as="span" className="mono-label">profile</Box>
      {/* eslint-disable-next-line no-restricted-syntax -- bespoke inline select in a horizontal profile bar; a SelectField .field stack would break the Row layout */}
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
          {/* eslint-disable-next-line no-restricted-syntax -- bespoke inline save-dialog input (fixed width/height) beside Buttons in a Row; a TextField .field wrapper would break the layout */}
          <input
            className="input mono"
            // eslint-disable-next-line jsx-a11y/no-autofocus -- intentional: focus the profile-name field when the save dialog opens
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
      <Box as="span" className="mono-caption">
        {targetLabel}
      </Box>
    </Row>
  );
}
