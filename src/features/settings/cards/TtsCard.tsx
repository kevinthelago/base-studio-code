import { useAppStore } from "@/store";
import { ToggleRow, SettingsRow, SettingsSelect } from "../pages/SettingsControls";
import { Card } from "@/shared/ui/data/Card";
import { Button } from "@/shared/ui/controls/Button";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { isSpeechSupported, listVoices, speak, type TtsVerbosity } from "@/shared/lib/a11y/speech";

/** Settings → Accessibility: opt-in spoken fleet coordination (#3804, a11y epic #2725 Tier 1). */
export function TtsCard() {
  const {
    ttsEnabled, setTtsEnabled, ttsRate, setTtsRate, ttsVoice, setTtsVoice, ttsVerbosity, setTtsVerbosity,
  } = useAppStore();
  const supported = isSpeechSupported();
  const voices = supported ? listVoices() : [];

  return (
    <Card title="Spoken coordination" hint="opt-in — off by default">
      <ToggleRow
        on={ttsEnabled}
        onToggle={() => setTtsEnabled(!ttsEnabled)}
        title="Speak fleet coordination events aloud"
      >
        Reads <b>new</b> coordination events aloud — a worker pausing for you, a question to answer, a PR
        landing — so you can drive the fleet <b>by ear</b>. It speaks the structured events, never the raw
        terminal stream. Separate from your screen reader; nothing is spoken until you enable it.
      </ToggleRow>

      {!supported && (
        <Text as="div" size={11} tone="dim" style={{ marginTop: 10 }}>
          Text-to-speech isn't available in this environment.
        </Text>
      )}

      {ttsEnabled && supported && (
        <Box style={{ marginTop: 12 }}>
          <SettingsRow label="Verbosity" hint="terse speaks only what needs you; verbose adds progress (landings, ready gates)">
            <SettingsSelect
              value={ttsVerbosity}
              options={[{ label: "Terse", value: "terse" }, { label: "Verbose", value: "verbose" }]}
              onChange={(v) => setTtsVerbosity(v as TtsVerbosity)}
            />
          </SettingsRow>
          <SettingsRow label="Rate" hint="speech speed">
            <SettingsSelect
              value={ttsRate}
              options={[
                { label: "0.75×", value: 0.75 }, { label: "1×", value: 1 }, { label: "1.25×", value: 1.25 },
                { label: "1.5×", value: 1.5 }, { label: "1.75×", value: 1.75 },
              ]}
              onChange={(v) => setTtsRate(Number(v))}
            />
          </SettingsRow>
          <SettingsRow label="Voice" hint="the platform voice used">
            <SettingsSelect
              value={ttsVoice}
              options={[{ label: "Default", value: "" }, ...voices.map((v) => ({ label: `${v.name} (${v.lang})`, value: v.voiceURI }))]}
              onChange={(v) => setTtsVoice(String(v))}
            />
          </SettingsRow>
          <Box style={{ marginTop: 10 }}>
            <Button
              variant="ghost"
              onClick={() => speak("Worker api-stream is paused, waiting for you.", { rate: ttsRate, voiceURI: ttsVoice || undefined })}
            >
              Test voice
            </Button>
          </Box>
        </Box>
      )}
    </Card>
  );
}
