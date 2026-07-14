// The Sounds tab (#3072, epic #3071) — the synthesis-first audio library, folded into the Planner as the
// "sounds" page-mode alongside Components/Algorithms. Phase 1 is the PLAYABLE library: the starter kit's
// cues, grouped by category, each a card you press to hear it synthesized live (Web Audio). The full
// composition GRAPH (GraphCanvas + rail + inspector + Primitive/Voice/Cue swimlanes) is Phase 2.
import { useState } from "react";
import { Play } from "lucide-react";
import { Box } from "@/shared/ui/layout/Box";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { Text } from "@/shared/ui/typography/Text";
import { Eyebrow } from "@/shared/ui/typography/Eyebrow";
import { Card } from "@/shared/ui/data/Card";
import { useCrumbEntity } from "@/shared/hooks/useCrumbEntity";
import { SOUND_CATEGORIES, CATEGORY_LABEL, type Cue, type SoundKit } from "./lib/soundDescriptor";
import { playCue } from "./lib/synth";
import { STARTER_KIT } from "./lib/soundSeeds";

/** One playable cue — click anywhere on the card to synthesize + hear it; a brief accent pulse confirms. */
function CueCard({ cue, kit }: { cue: Cue; kit: SoundKit }) {
  const [playing, setPlaying] = useState(false);
  const play = () => {
    const dur = playCue(cue, kit); // seconds (0 where Web Audio is unavailable)
    setPlaying(true);
    window.setTimeout(() => setPlaying(false), Math.max(160, dur * 1000));
  };
  const n = cue.layers.length;
  return (
    <Card interactive onClick={play} pad="sm" tone={playing ? "var(--accent)" : undefined}
      tooltip={`Play "${cue.name}" — ${n} voice${n === 1 ? "" : "s"}`}>
      <Row justify="between" align="center" gap="sm">
        <Box style={{ minWidth: 0 }}>
          <Text mono weight={600} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{cue.name}</Text>
          <Text as="div" tone="dim" size="xs">{n} voice{n === 1 ? "" : "s"}</Text>
        </Box>
        <Box aria-hidden style={{ flex: "none", display: "flex", alignItems: "center", justifyContent: "center",
          width: 26, height: 26, borderRadius: "50%", color: "var(--accent)",
          background: "color-mix(in oklch, var(--accent) 14%, transparent)" }}>
          <Play size={13} fill="currentColor" />
        </Box>
      </Row>
    </Card>
  );
}

export function SoundsWorkspace() {
  // Phase 1 reads the seed kit directly (the durable bsc-sound store is Phase 3).
  const kit = STARTER_KIT;
  // Name the active kit in the titlebar crumb, like the sibling library pages (#3041).
  useCrumbEntity("sounds", kit.name);

  const cuesFor = (cat: string) => kit.cues.filter((c) => c.category === cat);
  const usedCategories = SOUND_CATEGORIES.filter((cat) => cuesFor(cat).length > 0);

  return (
    <Box style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "20px 24px" }}>
      <Stack gap="lg" style={{ maxWidth: 980, margin: "0 auto" }}>
        <Box>
          <Eyebrow size={10}>Sounds</Eyebrow>
          <Text as="div" size="lg" weight={600}>{kit.name} kit</Text>
          <Text as="div" tone="dim" size="sm">
            {kit.cues.length} cues · {kit.voices.length} voices · {kit.primitives.length} primitives · synthesized live
          </Text>
        </Box>

        {usedCategories.map((cat) => (
          <Box key={cat}>
            <Eyebrow size={10}>{CATEGORY_LABEL[cat]}</Eyebrow>
            <Box style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 12, marginTop: 8 }}>
              {cuesFor(cat).map((cue) => <CueCard key={cue.id} cue={cue} kit={kit} />)}
            </Box>
          </Box>
        ))}
      </Stack>
    </Box>
  );
}
