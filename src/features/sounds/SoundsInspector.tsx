// The Sounds page inspector (#3077) — the selected node's details: a cue's layers, a voice's synth
// params, or a primitive's source. Cues + voices get a Play button (a primitive has no envelope of its
// own, so it's shown but not played). Mirrors the Algorithms/Designs inspector shape.
import { Play } from "lucide-react";
import { Box } from "@/shared/ui/layout/Box";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { Text } from "@/shared/ui/typography/Text";
import { Eyebrow } from "@/shared/ui/typography/Eyebrow";
import { Button } from "@/shared/ui/controls/Button";
import { CATEGORY_LABEL, type SoundKit } from "./lib/soundDescriptor";
import { playableCueForNode, type SoundNode } from "./lib/soundGraph";

function Field({ label, value }: { label: string; value: string }) {
  return (
    <Row justify="between" align="baseline" gap="sm">
      <Text size="xs" tone="dim">{label}</Text>
      <Text mono size="xs" style={{ textAlign: "right" }}>{value}</Text>
    </Row>
  );
}

export function SoundsInspector({ node, kit, onPlay }: {
  node: SoundNode | null;
  kit: SoundKit;
  onPlay: (node: SoundNode) => void;
}) {
  if (!node) {
    return (
      <Box style={{ padding: 16 }}>
        <Text size="sm" tone="dim">Select a sound to inspect it — cues, voices, and primitives.</Text>
      </Box>
    );
  }

  const playable = playableCueForNode(node, kit) != null;

  return (
    <Box style={{ padding: 16 }}>
      <Stack gap="md">
        <Box>
          <Eyebrow size={10}>{node.kind}</Eyebrow>
          <Text as="div" size="md" weight={600}>{node.label}</Text>
        </Box>

        {node.kind === "cue" && (() => {
          const cue = kit.cues.find((c) => c.id === node.refId);
          if (!cue) return null;
          return (
            <Stack gap="sm">
              <Field label="category" value={CATEGORY_LABEL[cue.category]} />
              <Box>
                <Eyebrow size={9}>Layers</Eyebrow>
                <Stack gap="xs" style={{ marginTop: 4 }}>
                  {cue.layers.map((l, i) => {
                    const v = kit.voices.find((x) => x.id === l.voice);
                    return <Field key={i} label={v?.name ?? l.voice} value={`@ ${l.at}s`} />;
                  })}
                </Stack>
              </Box>
            </Stack>
          );
        })()}

        {node.kind === "voice" && (() => {
          const v = kit.voices.find((x) => x.id === node.refId);
          if (!v) return null;
          const prim = kit.primitives.find((p) => p.id === v.primitive);
          return (
            <Stack gap="sm">
              <Field label="source" value={prim ? prim.name : v.primitive} />
              <Field label="frequency" value={v.pitchTo != null ? `${v.freq} → ${v.pitchTo} Hz` : `${v.freq} Hz`} />
              {v.detune ? <Field label="detune" value={`${v.detune} cents`} /> : null}
              <Field label="envelope" value={`a ${v.env.attack} · d ${v.env.decay} · s ${v.env.sustain} · r ${v.env.release}`} />
              {v.filter ? <Field label="filter" value={`${v.filter.type} @ ${v.filter.cutoff} Hz`} /> : null}
              <Field label="gain" value={String(v.gain)} />
            </Stack>
          );
        })()}

        {node.kind === "primitive" && (() => {
          const p = kit.primitives.find((x) => x.id === node.refId);
          if (!p) return null;
          return (
            <Stack gap="sm">
              <Field label="kind" value={p.kind === "osc" ? "oscillator" : "noise"} />
              {p.waveform ? <Field label="waveform" value={p.waveform} /> : null}
              <Text size="xs" tone="dim" as="div">A primitive is a source — hear it through a voice built on it.</Text>
            </Stack>
          );
        })()}

        {playable && (
          <Button size="sm" variant="primary" onClick={() => onPlay(node)}>
            <Play size={13} fill="currentColor" /> Play
          </Button>
        )}
      </Stack>
    </Box>
  );
}
