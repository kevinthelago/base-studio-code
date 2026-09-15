//! Audition — generating many blends to measure, so a person listens to the best few rather than all.
//!
//! Pure: which voices are candidates, how a seeded random blend is drawn, how it is spelled and where
//! its clip lives. The rendering and the ranking are in `cli`, because they touch the model and disk.

use crate::kokoro::Component;

/// Which way a reference voice is labelled, read from Kokoro's own naming: the second letter of
/// `af_`, `am_`, `bf_`, `bm_`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Label {
    Female,
    Male,
}

/// English voices only. The other languages' voices are labelled too, but an English sentence read
/// by a Japanese voice measures its accent as much as its tract, and would pull the centroids.
pub fn label_of(voice: &str) -> Option<Label> {
    match voice.split_once('_')?.0 {
        "af" | "bf" => Some(Label::Female),
        "am" | "bm" => Some(Label::Male),
        _ => None,
    }
}

/// xorshift64* — a seed must reproduce a run exactly, and a dependency for twelve lines is not worth it.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Rng {
        // Zero is xorshift's one fixed point; any other constant would do.
        Rng(if seed == 0 { 0x9E37_79B9_7F4A_7C15 } else { seed })
    }

    pub fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    /// Uniform in `0..n`.
    pub fn below(&mut self, n: usize) -> usize {
        (self.next_u64() % n.max(1) as u64) as usize
    }

    /// Uniform in `[0, 1)`.
    pub fn unit(&mut self) -> f32 {
        (self.next_u64() >> 40) as f32 / (1u64 << 24) as f32
    }
}

/// One random blend: one or two female voices with one or two male ones, at random weights.
///
/// ALWAYS CROSSES THE LABELS. A blend of only female voices is still a female voice, so drawing from
/// the whole pool would spend most of a run measuring what nobody is looking for.
pub fn random_blend(rng: &mut Rng, female: &[String], male: &[String]) -> Vec<Component> {
    let mut parts = Vec::new();
    for pool in [female, male] {
        if pool.is_empty() {
            continue;
        }
        let take = 1 + rng.below(2).min(pool.len() - 1);
        let mut chosen: Vec<usize> = Vec::new();
        while chosen.len() < take {
            let i = rng.below(pool.len());
            if !chosen.contains(&i) {
                chosen.push(i);
            }
        }
        for i in chosen {
            // Never near zero: a 2% voice is inaudible and makes a duplicate of a smaller blend.
            parts.push(Component { voice: pool[i].clone(), weight: 0.15 + rng.unit() });
        }
    }
    normalise(parts)
}

fn normalise(mut parts: Vec<Component>) -> Vec<Component> {
    let total: f32 = parts.iter().map(|c| c.weight).sum();
    if total > 0.0 {
        for c in &mut parts {
            c.weight /= total;
        }
    }
    parts
}

/// The canonical spelling: voices sorted, weights to two decimals. Two draws that sound identical
/// spell identically, which is what lets a rerun find a clip it already rendered.
pub fn spec_of(parts: &[Component]) -> String {
    let mut sorted: Vec<&Component> = parts.iter().collect();
    sorted.sort_by(|a, b| a.voice.cmp(&b.voice));
    sorted.iter().map(|c| format!("{}:{:.2}", c.voice, c.weight)).collect::<Vec<_>>().join(",")
}

/// A file name for a spec. Voice names are `[a-z_]`, so swapping the two separators is enough and
/// the name stays readable in a directory listing.
pub fn clip_name(spec: &str) -> String {
    format!("{}.wav", spec.replace(':', "-").replace(',', "+"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kokoro::parse_blend;

    fn names(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn labels_come_from_the_prefix_and_other_languages_are_left_out() {
        assert_eq!(label_of("af_nova"), Some(Label::Female));
        assert_eq!(label_of("bm_lewis"), Some(Label::Male));
        assert_eq!(label_of("jf_alpha"), None, "not an English voice");
        assert_eq!(label_of("af"), None, "the bare legacy file carries no name");
    }

    #[test]
    fn a_seed_reproduces_the_same_blends() {
        let (f, m) = (names(&["af_nova", "af_sky", "bf_lily"]), names(&["am_echo", "bm_lewis"]));
        let draw = |seed| {
            let mut rng = Rng::new(seed);
            (0..20).map(|_| spec_of(&random_blend(&mut rng, &f, &m))).collect::<Vec<_>>()
        };
        assert_eq!(draw(7), draw(7));
        assert_ne!(draw(7), draw(8));
    }

    #[test]
    fn every_random_blend_crosses_the_labels_and_sums_to_one() {
        let (f, m) = (names(&["af_nova", "af_sky", "bf_lily"]), names(&["am_echo", "bm_lewis"]));
        let mut rng = Rng::new(1);
        for _ in 0..200 {
            let b = random_blend(&mut rng, &f, &m);
            assert!(b.iter().any(|c| label_of(&c.voice) == Some(Label::Female)), "{b:?}");
            assert!(b.iter().any(|c| label_of(&c.voice) == Some(Label::Male)), "{b:?}");
            let names: Vec<&str> = b.iter().map(|c| c.voice.as_str()).collect();
            let mut dedup = names.clone();
            dedup.sort();
            dedup.dedup();
            assert_eq!(dedup.len(), names.len(), "a voice is drawn once: {b:?}");
            assert!((b.iter().map(|c| c.weight).sum::<f32>() - 1.0).abs() < 1e-4);
        }
    }

    #[test]
    fn a_spec_is_canonical_and_parses_back_as_a_blend() {
        let a = parse_blend("am_echo:3,af_nova:1").unwrap();
        let b = parse_blend("af_nova:0.25,am_echo:0.75").unwrap();
        assert_eq!(spec_of(&a), spec_of(&b));
        assert_eq!(spec_of(&a), "af_nova:0.25,am_echo:0.75");
        assert_eq!(parse_blend(&spec_of(&a)).unwrap(), b);
    }

    #[test]
    fn a_clip_name_is_a_plain_file_name() {
        let n = clip_name("af_nova:0.25,am_echo:0.75");
        assert_eq!(n, "af_nova-0.25+am_echo-0.75.wav");
        assert!(!n.contains('/') && !n.contains(':') && !n.contains(','));
    }
}
