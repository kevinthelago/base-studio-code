//! The app learns ONE voice — the maintainer's — and tells it from everyone else.
//!
//! This is deliberately not speaker naming. The maintainer asked for the opposite of a directory of
//! names: know which speech is MINE, and give every other person an anonymous id for their
//! protection. That turns an open-ended "who is everyone" into a closed "is this me", which is a
//! binary match against one reference — far more tractable than clustering a room into the right
//! number of strangers, and it is what the diarization epic meant by "one cluster enrollable as the
//! maintainer".
//!
//! **An imprint LEARNS, it is not enrolled once.** The store accumulates reference voiceprints
//! rather than replacing them, so hearing the maintainer again sharpens the reference instead of
//! overwriting it. The always-on ear can later add high-confidence matches on its own, so the
//! imprint tracks the voice across days and capture chains — the self-improving loop. This module is
//! the pure core of that: it holds the prints and answers "is this me", and it does not care whether
//! a print arrived from a hand-picked clip or from live capture.
//!
//! **It rides on [`crate::diarize::Voiceprint`]**, so it inherits that fingerprint's ceiling exactly:
//! cheap pitch + timbre features match the maintainer only as well as they separate anyone. A friend
//! with a similar voice can false-match; the maintainer on an off day can be missed. The reliability
//! upgrade is the neural embedding model, and this first cut is what MEASURES whether the me/not-me
//! question specifically needs it. And because it inherits the fingerprint's channel-sensitivity,
//! the reference must come from a comparable chain — a headset-recorded imprint will not reliably
//! find the maintainer in a phone recording.

use crate::diarize::{distance, Voiceprint};
use serde::{Deserialize, Serialize};

/// What the app has learned of one person's voice — the maintainer's, in practice.
#[derive(Clone, PartialEq, Debug, Default, Serialize, Deserialize)]
pub struct Imprint {
    /// A human label for whose voice this is. "you" by default; the point is that exactly one person
    /// is named and everyone else stays anonymous.
    pub name: String,
    /// The accumulated reference prints. More is better and never worse: a turn is judged against
    /// the NEAREST of them, so adding a print can only make a genuine match easier to find, never
    /// harder. This is what makes the imprint able to learn.
    pub prints: Vec<Voiceprint>,
    /// The accumulated speaker EMBEDDINGS (ECAPA-TDNN, L2-normalised). These are the recognition
    /// path: unlike `prints`, an embedding is session/channel invariant, so a turn matches the
    /// maintainer across recordings, not only within one. Empty on a voiceprint-only imprint; when
    /// present, recognition uses these and ignores `prints`.
    #[serde(default)]
    pub embeddings: Vec<Vec<f32>>,
}

impl Imprint {
    pub fn new(name: &str) -> Self {
        Imprint { name: name.to_string(), prints: Vec::new(), embeddings: Vec::new() }
    }

    /// Learn from another reference clip. Additive on purpose — see [`Imprint::prints`].
    pub fn learn(&mut self, print: Voiceprint) {
        self.prints.push(print);
    }

    /// Learn a reference EMBEDDING (the recognition path). Additive, like [`Imprint::learn`].
    pub fn learn_embedding(&mut self, embedding: Vec<f32>) {
        self.embeddings.push(embedding);
    }

    /// Whether this imprint recognises by embedding (has at least one) rather than by voiceprint.
    pub fn has_embeddings(&self) -> bool {
        !self.embeddings.is_empty()
    }

    /// Cosine distance to the NEAREST enrolled embedding, or `None` if none learned.
    pub fn cosine_to(&self, embedding: &[f32]) -> Option<f32> {
        self.embeddings
            .iter()
            .map(|e| crate::embed::cosine_distance(e, embedding))
            .min_by(|a, b| a.partial_cmp(b).unwrap())
    }

    /// How far this turn is from the imprint: the distance to the NEAREST reference print, or `None`
    /// when nothing has been learned yet (an empty imprint matches no one rather than everyone).
    pub fn distance_to(&self, turn: &Voiceprint) -> Option<f32> {
        self.prints.iter().map(|p| distance(p, turn)).min_by(|a, b| a.partial_cmp(b).unwrap()).filter(|_| !self.prints.is_empty())
    }
}

/// A turn is the maintainer's if its embedding is within this COSINE distance of a reference. Set
/// from the measurement: same-speaker-across-sessions landed at 0.35–0.57 and a different speaker at
/// 0.88–1.07, so 0.65 sits in the clean gap between them. Tuned against real clips, not reasoned out.
pub const IS_ME_COSINE: f32 = 0.65;

/// Is this turn the maintainer, by embedding? `false` for an imprint with no embeddings.
pub fn identify_embedding(embedding: &[f32], me: &Imprint, threshold: f32) -> bool {
    me.cosine_to(embedding).is_some_and(|d| d <= threshold)
}

/// A turn is the maintainer's if it lands within this scaled distance of the imprint. Same distance
/// space as [`crate::diarize::SAME_SPEAKER`] and the same kind of knob — an explicit placeholder to
/// be tuned against a labelled reference, not reasoned out. It is set a touch TIGHTER than
/// `SAME_SPEAKER`: a false "you" (mistaking a friend for the maintainer) attributes someone else's
/// words to the user, which is the worse error here than missing one of the user's own turns.
pub const IS_ME: f32 = 0.85;

/// Is this turn the maintainer's voice? `false` for an empty imprint — nothing learned yet means
/// nobody is recognised, never everybody.
pub fn identify(turn: &Voiceprint, me: &Imprint, threshold: f32) -> bool {
    me.distance_to(turn).is_some_and(|d| d <= threshold)
}

/// Who a turn belongs to, once the maintainer is known.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub enum Who {
    /// The maintainer, recognised by the imprint.
    You,
    /// Some other person, kept anonymous. The number groups the strangers within one recording; it
    /// is not an identity and it is not stable across recordings.
    Other(usize),
}

/// Label every turn as the maintainer or an anonymous stranger.
///
/// The maintainer is decided PER TURN by the imprint, which is what collapses the diarizer's
/// over-split for the one voice that matters: however many fragments the clustering broke the
/// maintainer into, each fragment matches the reference and all of them read `You`. The strangers
/// keep their cluster ids, renumbered 0.. by first appearance so the anonymous labels read in order;
/// their exact count is not load-bearing, because they are anonymous by design.
///
/// `labels` is the diarizer's per-turn cluster id (`None` for an unplaceable turn). A turn with no
/// print, or an unplaceable one that still matches the imprint, is handled the obvious way: no print
/// means no decision (`None`), and matching the imprint always wins over being anonymous.
pub fn label(
    prints: &[Option<Voiceprint>],
    labels: &[Option<usize>],
    me: &Imprint,
    threshold: f32,
) -> Vec<Option<Who>> {
    let present: Vec<bool> = prints.iter().map(|p| p.is_some()).collect();
    let is_me: Vec<bool> =
        prints.iter().map(|p| p.as_ref().is_some_and(|vp| identify(vp, me, threshold))).collect();
    label_core(&present, &is_me, labels)
}

/// Label every turn as the maintainer or an anonymous stranger, by EMBEDDING — the recognition path
/// that generalises across sessions. `turn_embeddings` is one per turn (`None` for an unplaceable
/// turn); a turn is the maintainer if its embedding is within `threshold` cosine of a reference.
pub fn label_embeddings(
    turn_embeddings: &[Option<Vec<f32>>],
    labels: &[Option<usize>],
    me: &Imprint,
    threshold: f32,
) -> Vec<Option<Who>> {
    let present: Vec<bool> = turn_embeddings.iter().map(|e| e.is_some()).collect();
    let is_me: Vec<bool> = turn_embeddings
        .iter()
        .map(|e| e.as_ref().is_some_and(|emb| identify_embedding(emb, me, threshold)))
        .collect();
    label_core(&present, &is_me, labels)
}

/// The shared labelling: `You` for a maintainer turn, an anonymous `Other(n)` for the rest (cluster
/// ids remapped 0.. by first appearance), `None` for an absent turn. The matching method — voiceprint
/// or embedding — is the caller's; this only turns per-turn is-me + cluster ids into labels.
fn label_core(present: &[bool], is_me: &[bool], labels: &[Option<usize>]) -> Vec<Option<Who>> {
    let mut remap: std::collections::BTreeMap<usize, usize> = std::collections::BTreeMap::new();
    for (i, lab) in labels.iter().enumerate() {
        if is_me[i] {
            continue;
        }
        if let Some(cid) = lab {
            let next = remap.len();
            remap.entry(*cid).or_insert(next);
        }
    }
    (0..present.len())
        .map(|i| {
            if !present[i] {
                return None;
            }
            if is_me[i] {
                return Some(Who::You);
            }
            labels[i].and_then(|cid| remap.get(&cid)).map(|&anon| Who::Other(anon))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diarize::voiceprint;
    use std::f32::consts::PI;

    const SR: u32 = 16000;

    fn voice(f0: f32, seconds: f32, bright: bool) -> Vec<f32> {
        let n = (SR as f32 * seconds) as usize;
        (0..n)
            .map(|i| {
                let t = i as f32 / SR as f32;
                let mut s = 0.0f32;
                for h in 1..=6 {
                    let amp = if bright { 1.0 / h as f32 } else { 1.0 / (h * h) as f32 };
                    s += amp * (2.0 * PI * f0 * h as f32 * t).sin();
                }
                s * 0.2
            })
            .collect()
    }
    fn vp(f0: f32, seconds: f32, bright: bool) -> Voiceprint {
        voiceprint(&voice(f0, seconds, bright), SR)
    }

    /// The imprint learns incrementally, and a turn of the maintainer's own voice is recognised
    /// while a clearly different voice is not.
    #[test]
    fn the_maintainer_is_recognised_and_a_stranger_is_not() {
        let mut me = Imprint::new("you");
        assert!(!identify(&vp(115.0, 1.2, false), &me, IS_ME), "an empty imprint recognises no one");
        me.learn(vp(112.0, 1.5, false));
        me.learn(vp(116.0, 1.4, false));
        assert!(identify(&vp(114.0, 1.3, false), &me, IS_ME), "the maintainer's own voice is me");
        assert!(!identify(&vp(225.0, 1.3, true), &me, IS_ME), "a clearly different voice is not me");
    }

    /// Learning only ever helps: adding a reference print cannot turn a recognised turn into an
    /// unrecognised one, because a turn is judged against the NEAREST print.
    #[test]
    fn learning_more_never_loses_a_match() {
        let probe = vp(114.0, 1.3, false);
        let mut me = Imprint::new("you");
        me.learn(vp(180.0, 1.3, true)); // a poor first reference
        let before = me.distance_to(&probe).unwrap();
        me.learn(vp(113.0, 1.4, false)); // a good one
        let after = me.distance_to(&probe).unwrap();
        assert!(after <= before, "a nearer reference can only reduce the distance: {before} -> {after}");
    }

    /// The over-split payoff: the maintainer broken into several clusters still reads entirely `You`,
    /// while the strangers keep anonymous ids numbered by first appearance.
    #[test]
    fn the_maintainers_fragments_all_collapse_to_you() {
        let mut me = Imprint::new("you");
        me.learn(vp(112.0, 1.5, false));
        // Turns: me(clustered 0), stranger(1), me-fragment(clustered 2 — over-split), stranger(1).
        let prints = vec![
            Some(vp(111.0, 1.3, false)),
            Some(vp(228.0, 1.3, true)),
            Some(vp(115.0, 1.3, false)),
            Some(vp(224.0, 1.3, true)),
        ];
        let labels = vec![Some(0), Some(1), Some(2), Some(1)];
        let who = label(&prints, &labels, &me, IS_ME);
        assert_eq!(who[0], Some(Who::You));
        assert_eq!(who[2], Some(Who::You), "the over-split maintainer fragment still reads You");
        assert_eq!(who[1], Some(Who::Other(0)), "the first stranger is anonymous 0");
        assert_eq!(who[3], Some(Who::Other(0)), "the same stranger cluster keeps its anon id");
    }

    /// A turn that matches nobody imprinted is anonymous, never guessed into You — the bite: with the
    /// imprint EMPTY the same turn cannot be You however close the threshold, so it is the imprint
    /// doing the recognising, not the labeller defaulting.
    #[test]
    fn an_unmatched_turn_is_anonymous_not_you() {
        let stranger = vec![Some(vp(230.0, 1.3, true))];
        let labels = vec![Some(0)];
        let mut me = Imprint::new("you");
        me.learn(vp(112.0, 1.5, false));
        assert_eq!(label(&stranger, &labels, &me, IS_ME)[0], Some(Who::Other(0)));

        // Even a giant threshold does not make an EMPTY imprint claim the turn — nothing learned,
        // nobody recognised.
        let empty = Imprint::new("you");
        assert_eq!(label(&stranger, &labels, &empty, 1e9)[0], Some(Who::Other(0)));
        // And a turn with no print at all is undecided, not You.
        assert_eq!(label(&[None], &[None], &me, IS_ME)[0], None);
    }
}
