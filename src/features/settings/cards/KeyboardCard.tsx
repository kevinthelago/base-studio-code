import { useEffect, useState } from "react";
import { SHORTCUT_GROUPS } from "../lib/shortcuts";
import { useAppStore } from "@/store";
import { Card } from "@/shared/ui/data/Card";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { Grid } from "@/shared/ui/layout/Grid";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import {
  REBINDABLE_IDS,
  chordToCaps,
  eventToChord,
  isModifierCode,
  findConflict,
  REBINDABLE,
  LEADER_IDS,
  LEADER_OPTIONS,
  LEADER_META,
  DEFAULT_LEADERS,
  effectiveLeader,
  leaderToCaps,
  findLeaderConflict,
  type RebindableId,
  type LeaderId,
} from "../lib/keybindings";

const REBINDABLE_SET = new Set<string>(REBINDABLE_IDS);
const LEADER_SET = new Set<string>(LEADER_IDS);
const labelOf = (id: string) =>
  REBINDABLE.find((r) => r.id === id)?.label ??
  LEADER_META.find((r) => r.id === id)?.label ??
  id;

function KeyCap({ children, active }: { children: React.ReactNode; active?: boolean }) {
  return (
    <kbd className="mono" style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      minWidth: 20, height: 22, padding: "0 7px",
      fontSize: 11, color: active ? "var(--accent)" : "var(--fg)",
      background: "var(--bg-elev2)",
      border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
      borderRadius: 5, boxShadow: "0 1px 0 var(--border)",
    }}>{children}</kbd>
  );
}

/** Render a list of key caps with "+" separators. */
function Chord({ caps, active }: { caps: string[]; active?: boolean }) {
  return (
    <Row gap={4} wrap justify="end">
      {caps.map((k, ki) => (
        <Box as="span" key={ki} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          {ki > 0 && <Text tone="dim" size="xs">+</Text>}
          <KeyCap active={active}>{k}</KeyCap>
        </Box>
      ))}
    </Row>
  );
}

export function KeyboardCard() {
  const keybindings = useAppStore((s) => s.keybindings);
  const setKeybinding = useAppStore((s) => s.setKeybinding);
  const resetKeybinding = useAppStore((s) => s.resetKeybinding);
  const resetAllKeybindings = useAppStore((s) => s.resetAllKeybindings);

  const [capturingId, setCapturingId] = useState<RebindableId | null>(null);
  const [error, setError] = useState<string | null>(null);

  const overrideCount =
    REBINDABLE_IDS.filter((id) => keybindings[id]).length +
    LEADER_IDS.filter((id) => keybindings[id]).length;

  // While capturing, intercept the next chord on the document (capture phase, so
  // it beats anything else) and assign it — unless it collides with another
  // rebindable action, in which case we flag it and keep listening. Esc cancels.
  useEffect(() => {
    if (!capturingId) return;
    function onKey(e: KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Escape") { setCapturingId(null); setError(null); return; }
      if (isModifierCode(e.code)) return; // wait for a real key with its modifiers
      const chord = eventToChord(e);
      if (!chord) return;
      const id = capturingId!;
      const conflict = findConflict(useAppStore.getState().keybindings, id, chord);
      if (conflict) {
        setError(`That combination is already used by "${labelOf(conflict)}".`);
        return; // stay in capture so the user can try another
      }
      setKeybinding(id, chord);
      setCapturingId(null);
      setError(null);
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [capturingId, setKeybinding]);

  function startCapture(id: RebindableId) {
    setError(null);
    setCapturingId((cur) => (cur === id ? null : id));
  }

  function changeLeader(id: LeaderId, leader: string) {
    setError(null);
    const conflict = findLeaderConflict(keybindings, id, leader);
    if (conflict) {
      setError(`Those modifiers are already used by "${labelOf(conflict)}".`);
      return;
    }
    if (leader === DEFAULT_LEADERS[id]) resetKeybinding(id);
    else setKeybinding(id, leader);
  }

  return (
    <Box style={{ maxWidth: 820 }}>
      <h2 className="mono" style={{ fontSize: 18, margin: "0 0 4px", fontWeight: 600 }}>Keyboard</h2>
      <p style={{ color: "var(--fg-muted)", margin: "0 0 18px", fontSize: 12 }}>
        Every keyboard shortcut, grouped by what it affects. Click a shortcut and press a new
        combination to rebind it; for number-range shortcuts, pick the modifier leader from the
        dropdown.
      </p>

      {(overrideCount > 0 || capturingId) && (
        <Row gap={10} style={{ marginBottom: 14 }}>
          {capturingId ? (
            <Text as="span" mono size="md" tone="accent">
              Press a key combination… <Text tone="dim">(Esc to cancel)</Text>
            </Text>
          ) : (
            <Text as="span" size="md" tone="muted">
              {overrideCount} custom binding{overrideCount === 1 ? "" : "s"}.
            </Text>
          )}
          {overrideCount > 0 && !capturingId && (
            // eslint-disable-next-line no-restricted-syntax -- bespoke transparent-bordered mono button with custom styling; not the .btn family
            <button
              onClick={() => { resetAllKeybindings(); setError(null); }}
              className="mono"
              style={{
                fontSize: 11, color: "var(--fg-muted)",
                background: "transparent", border: "1px solid var(--border)", borderRadius: 5,
                padding: "3px 9px", cursor: "pointer",
              }}
            >
              Reset all to defaults
            </button>
          )}
        </Row>
      )}

      {error && (
        <Box style={{ fontSize: 12, color: "var(--danger, #e06c75)", marginBottom: 12 }}>{error}</Box>
      )}

      {SHORTCUT_GROUPS.map((group) => (
        <Card key={group.title} title={group.title} style={{ marginBottom: 16 }}>
          <Stack gap={1}>
            {group.items.map((s, i) => {
              const isChord = s.id != null && REBINDABLE_SET.has(s.id);
              const isLeader = s.id != null && LEADER_SET.has(s.id);
              const id = s.id;
              const isCapturing = isChord && capturingId === id;
              const overridden = (isChord || isLeader) && id != null && keybindings[id] != null;
              // Range cap (e.g. "1–9") is the last documented key; the leader caps
              // precede it and reflect the live selection.
              const rangeCap = s.keys[s.keys.length - 1];
              // Show documented caps for a default (nice for F-keys / Ctrl +), the
              // captured chord once a chord is customized, the live leader for ranges.
              const caps = isLeader && id != null
                ? [...leaderToCaps(effectiveLeader(keybindings, id as LeaderId)), rangeCap]
                : overridden && id != null ? chordToCaps(keybindings[id]!) : s.keys;
              return (
                <Grid
                  key={s.desc}
                  cols="1fr auto"
                  gap={14}
                  align="center"
                  style={{
                    padding: "9px 12px", borderRadius: 6,
                    background: i % 2 ? "var(--bg-panel)" : "var(--bg-elev)",
                    outline: isCapturing ? "1px solid var(--accent)" : "none",
                  }}
                >
                  <Row align="baseline" gap={8} style={{ minWidth: 0 }}>
                    <Text as="span" size="md" style={{ color: "var(--fg)" }}>{s.desc}</Text>
                    <Text as="span" mono size={9.5} tone="dim">{s.scope}</Text>
                    {overridden && (
                      // eslint-disable-next-line no-restricted-syntax -- bespoke borderless underlined mono text-link button; not the .btn family
                      <button
                        onClick={() => { resetKeybinding(id!); setError(null); }}
                        title="Reset to default"
                        className="mono"
                        style={{
                          fontSize: 9.5, color: "var(--fg-muted)",
                          background: "transparent", border: "none", padding: 0, cursor: "pointer",
                          textDecoration: "underline",
                        }}
                      >
                        reset
                      </button>
                    )}
                  </Row>
                  {isChord ? (
                    // eslint-disable-next-line no-restricted-syntax -- bespoke transparent borderless wrapper button around a key-cap chord display; not the .btn family
                    <button
                      onClick={() => startCapture(id as RebindableId)}
                      aria-label={`Rebind ${s.desc}`}
                      title="Click to rebind, then press a key combination"
                      style={{ background: "transparent", border: "none", padding: 0, cursor: "pointer" }}
                    >
                      {isCapturing
                        ? <Text as="span" mono size="sm" tone="accent">Press keys…</Text>
                        : <Chord caps={caps} active={overridden} />}
                    </button>
                  ) : isLeader && id != null ? (
                    <Row gap={6} justify="end">
                      {/* eslint-disable-next-line no-restricted-syntax -- bespoke inline mono select (custom accent border/bg) beside a "+" and KeyCap in a Row; a SelectField .field stack would break the layout */}
                      <select
                        aria-label={`Leader for ${s.desc}`}
                        value={effectiveLeader(keybindings, id as LeaderId)}
                        onChange={(e) => changeLeader(id as LeaderId, e.target.value)}
                        className="mono"
                        style={{
                          fontSize: 11,
                          color: overridden ? "var(--accent)" : "var(--fg)",
                          background: "var(--bg-elev2)",
                          border: `1px solid ${overridden ? "var(--accent)" : "var(--border)"}`,
                          borderRadius: 5, padding: "2px 4px", cursor: "pointer",
                        }}
                      >
                        {LEADER_OPTIONS.map((o) => (
                          <option key={o} value={o}>{o.replace(/\+/g, " + ")}</option>
                        ))}
                      </select>
                      <Text tone="dim" size="xs">+</Text>
                      <KeyCap>{rangeCap}</KeyCap>
                    </Row>
                  ) : (
                    <Chord caps={caps} />
                  )}
                </Grid>
              );
            })}
          </Stack>
        </Card>
      ))}
    </Box>
  );
}
