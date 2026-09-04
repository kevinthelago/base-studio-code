//! The survival corpus model — pure data + serde, no I/O, so every rule below is unit-testable.
//!
//! Two entities, because the two questions a person actually asks in the field are different shapes:
//!
//! - A [`Procedure`] is a THING YOU DO with materials — boil water, start a fire, dress a wound. Its
//!   inverse lookup is "what can I make with what is in my hands", so its materials carry substitutes.
//! - A [`Remedy`] is a THING THAT GROWS (or is kept) with a medicinal function — an antiseptic, a
//!   clotting agent, an analgesic. Its lookups are by FUNCTION and by LOCATION, so it carries both.
//!
//! # Two fields here are safety mechanisms, not documentation
//!
//! [`Procedure::limits`] is what the procedure does NOT do, and it is required rather than optional
//! because the failure mode of this corpus is a confident half-truth. An improvised bottle filter
//! clears turbidity and does not make water safe to drink; a row that cannot say so is a row that
//! lies to the one person who cannot check it.
//!
//! [`Remedy::lookalikes`] is the same idea for plants, where misidentification is the way this
//! material actually kills — yarrow and poison hemlock share a habitat and a silhouette. A look-alike
//! is stored with the TELL that separates the two, because naming the danger without naming the
//! difference leaves a reader no better off.

use serde::{Deserialize, Serialize};

/// What kind of problem a [`Procedure`] solves. Ordered roughly by how fast the problem kills you,
/// which is also the order [`crate::engine::Engine::compile`] renders them in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Category {
    /// Stopping blood loss, treating a wound, managing exposure.
    Medical,
    /// Getting out of the weather.
    Shelter,
    /// Making water safe to drink.
    Water,
    /// Ignition, tinder, and the fire lay.
    Fire,
    /// Being found — ground signals, mirrors, sound.
    Signal,
    /// Knowing which way you are going.
    Navigation,
    /// Cordage, containers, and the tools the rest depend on.
    Tools,
    /// Calories.
    Food,
}

impl Category {
    /// The lowercase token used in `--category` and in the store's index column.
    pub fn as_str(self) -> &'static str {
        match self {
            Category::Medical => "medical",
            Category::Shelter => "shelter",
            Category::Water => "water",
            Category::Fire => "fire",
            Category::Signal => "signal",
            Category::Navigation => "navigation",
            Category::Tools => "tools",
            Category::Food => "food",
        }
    }

    /// Parse a category token (case-insensitive), accepting the obvious aliases a person types.
    pub fn parse(s: &str) -> Option<Category> {
        match s.trim().to_ascii_lowercase().as_str() {
            "medical" | "med" | "first-aid" | "first_aid" | "medicine" => Some(Category::Medical),
            "shelter" | "warmth" => Some(Category::Shelter),
            "water" | "hydration" => Some(Category::Water),
            "fire" | "ignition" => Some(Category::Fire),
            "signal" | "signalling" | "signaling" | "rescue" => Some(Category::Signal),
            "navigation" | "nav" | "direction" => Some(Category::Navigation),
            "tools" | "tool" | "cordage" | "craft" => Some(Category::Tools),
            "food" | "forage" | "calories" => Some(Category::Food),
            _ => None,
        }
    }

    /// Every category, in the survival-priority order the enum declares.
    pub fn all() -> Vec<Category> {
        vec![
            Category::Medical,
            Category::Shelter,
            Category::Water,
            Category::Fire,
            Category::Signal,
            Category::Navigation,
            Category::Tools,
            Category::Food,
        ]
    }
}

/// What a [`Remedy`] is FOR — the axis `bsc survival remedy list --function <f>` filters on.
///
/// `Hemostatic` is the clotting axis and is deliberately its own function rather than a tag under
/// `Antiseptic`: "what stops this bleeding" and "what keeps this from going septic" are asked minutes
/// apart under very different pressure, and an answer to one is not an answer to the other.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Function {
    /// Slows or stops bleeding — a styptic or clotting agent.
    Hemostatic,
    /// Discourages infection in or around a wound.
    Antiseptic,
    /// Dulls pain.
    Analgesic,
    /// Reduces swelling and irritation.
    AntiInflammatory,
    /// Acts against fungal infection — athlete's foot, ringworm, thrush.
    Antifungal,
    /// Draws tissue together; the tannin-bearing wound washes and gargles.
    Astringent,
    /// Burn and scald care.
    Burn,
    /// Repels or treats insect bites and stings.
    Insect,
    /// Settles or moves the gut.
    Digestive,
    /// Eaten for calories or a specific nutrient.
    Nutrition,
}

impl Function {
    /// The lowercase token used in `--function` and in the store's index column.
    pub fn as_str(self) -> &'static str {
        match self {
            Function::Hemostatic => "hemostatic",
            Function::Antiseptic => "antiseptic",
            Function::Analgesic => "analgesic",
            Function::AntiInflammatory => "anti_inflammatory",
            Function::Antifungal => "antifungal",
            Function::Astringent => "astringent",
            Function::Burn => "burn",
            Function::Insect => "insect",
            Function::Digestive => "digestive",
            Function::Nutrition => "nutrition",
        }
    }

    /// Parse a function token (case-insensitive). The aliases matter more here than elsewhere: nobody
    /// under pressure types "hemostatic" — they type "clotting", or "stop bleeding".
    pub fn parse(s: &str) -> Option<Function> {
        match s.trim().to_ascii_lowercase().replace(['-', ' '], "_").as_str() {
            "hemostatic" | "haemostatic" | "clotting" | "clot" | "styptic" | "stop_bleeding" | "bleeding" => {
                Some(Function::Hemostatic)
            }
            "antiseptic" | "antibacterial" | "antimicrobial" | "disinfectant" | "infection" => {
                Some(Function::Antiseptic)
            }
            "analgesic" | "painkiller" | "pain" | "anodyne" => Some(Function::Analgesic),
            "anti_inflammatory" | "antiinflammatory" | "swelling" => Some(Function::AntiInflammatory),
            "antifungal" | "fungal" | "fungus" => Some(Function::Antifungal),
            "astringent" | "tannin" => Some(Function::Astringent),
            "burn" | "burns" | "scald" => Some(Function::Burn),
            "insect" | "bite" | "bites" | "sting" | "repellent" => Some(Function::Insect),
            "digestive" | "gut" | "stomach" | "digestion" => Some(Function::Digestive),
            "nutrition" | "food" | "nutrient" | "calories" => Some(Function::Nutrition),
            _ => None,
        }
    }

    /// Every function.
    pub fn all() -> Vec<Function> {
        vec![
            Function::Hemostatic,
            Function::Antiseptic,
            Function::Analgesic,
            Function::AntiInflammatory,
            Function::Antifungal,
            Function::Astringent,
            Function::Burn,
            Function::Insect,
            Function::Digestive,
            Function::Nutrition,
        ]
    }
}

/// One thing a procedure needs. `substitutes` is what makes the inverse lookup work: a person has a
/// tin can, not "a metal container", and the corpus is the only place that equivalence can live.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Material {
    /// The canonical name of the material.
    pub item: String,
    /// Other things that serve the same role here. Checked by [`Material::satisfied_by`].
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub substitutes: Vec<String>,
    /// The procedure works without it — it is better with it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub optional: bool,
}

impl Material {
    /// Does something a person says they have satisfy this material?
    ///
    /// Matching is case-insensitive containment IN BOTH DIRECTIONS against the item and every
    /// substitute, because the two sides are written by different people under different pressure:
    /// the corpus says `metal container`, the person says `pot`, and the person also says
    /// `an old paint can` when the corpus says `can`. Containment either way catches both; requiring
    /// equality catches neither.
    pub fn satisfied_by(&self, have: &str) -> bool {
        let h = have.trim().to_ascii_lowercase();
        if h.is_empty() {
            return false;
        }
        std::iter::once(&self.item)
            .chain(self.substitutes.iter())
            .any(|c| {
                let c = c.to_ascii_lowercase();
                c.contains(&h) || h.contains(&c)
            })
    }
}

/// One numbered step. `why` is separate from `text` so a step can be followed under stress and
/// understood later — the reason is what lets a person adapt when the materials are not the ones
/// the step assumed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Step {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
}

/// A thing you DO. Keyed by `id`, which is the store key and the `get` argument.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Procedure {
    pub id: String,
    pub category: Category,
    pub name: String,
    /// One line: what this gets you.
    pub summary: String,
    /// Rough wall clock, when it is worth knowing before you start.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time: Option<String>,
    #[serde(default)]
    pub materials: Vec<Material>,
    #[serde(default)]
    pub steps: Vec<Step>,
    /// How you know it worked — the check that separates "done" from "assumed".
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub verify: Vec<String>,
    /// What this does NOT do. Required by the seed guard; see the module docs.
    pub limits: Vec<String>,
    /// How it hurts you if you get it wrong.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cautions: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
}

impl Procedure {
    /// The words this row can be searched by — name, summary, tags, and its materials.
    pub fn haystack(&self) -> String {
        let mut s = format!("{} {} {}", self.name, self.summary, self.tags.join(" "));
        for m in &self.materials {
            s.push(' ');
            s.push_str(&m.item);
            for sub in &m.substitutes {
                s.push(' ');
                s.push_str(sub);
            }
        }
        s.to_ascii_lowercase()
    }
}

/// A plant (or fungus, or lichen) that could be mistaken for the remedy, and the difference that
/// tells them apart.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Lookalike {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latin: Option<String>,
    /// What happens if you get it wrong.
    pub danger: String,
    /// The observable difference. A look-alike without a tell is a warning with no exit.
    pub tell: String,
}

/// How a remedy is made ready to use.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Preparation {
    /// `poultice`, `infusion`, `decoction`, `wash`, `salve`, `chewed`, …
    pub form: String,
    /// How to make it.
    pub method: String,
    /// What that preparation is for.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub for_use: String,
}

/// A thing that GROWS (or is kept) and does something medicinal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Remedy {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latin: Option<String>,
    /// The functions this is reached for — the `--function` axis.
    pub functions: Vec<Function>,
    /// Where it grows — the `--region` axis. `worldwide` matches every query; see
    /// [`Remedy::grows_in`].
    #[serde(default)]
    pub regions: Vec<String>,
    /// The ground it is found on, in prose.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub habitat: String,
    /// Which parts are used.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub parts: Vec<String>,
    /// Identification marks, in the order you would check them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub identify: Vec<String>,
    /// What it can be confused with, and the tell. See the module docs.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub lookalikes: Vec<Lookalike>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub preparations: Vec<Preparation>,
    /// Required by the seed guard: who must not use this, and what it interacts with.
    pub cautions: Vec<String>,
    /// How well attested the use is — plainly, so traditional use is not read as clinical evidence.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence: Option<String>,
}

impl Remedy {
    /// Does this grow where the caller is asking about?
    ///
    /// The same containment rule [`crate::types::Material::satisfied_by`] uses would be wrong here —
    /// `asia` must not match `australasia`. So this is exact, plus the `-` hierarchy in both
    /// directions (`north-america` answers `north-america-west` and the reverse), plus `worldwide`.
    /// An empty query matches everything; a remedy with no regions recorded matches nothing but a
    /// blank query, because silence about range is not a claim of range.
    pub fn grows_in(&self, region: &str) -> bool {
        let q = region.trim().to_ascii_lowercase();
        if q.is_empty() {
            return true;
        }
        self.regions.iter().any(|r| {
            let r = r.to_ascii_lowercase();
            r == "worldwide"
                || r == q
                || q.starts_with(&format!("{r}-"))
                || r.starts_with(&format!("{q}-"))
        })
    }

    /// The words this row can be searched by.
    pub fn haystack(&self) -> String {
        let mut s = format!("{} {} {}", self.name, self.latin.clone().unwrap_or_default(), self.habitat);
        for f in &self.functions {
            s.push(' ');
            s.push_str(f.as_str());
        }
        for p in &self.parts {
            s.push(' ');
            s.push_str(p);
        }
        for p in &self.preparations {
            s.push(' ');
            s.push_str(&p.form);
            s.push(' ');
            s.push_str(&p.for_use);
        }
        s.to_ascii_lowercase()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn category_round_trips_through_its_token() {
        for c in Category::all() {
            assert_eq!(Category::parse(c.as_str()), Some(c));
        }
        assert_eq!(Category::parse("First-Aid"), Some(Category::Medical));
        assert_eq!(Category::parse("nonsense"), None);
    }

    #[test]
    fn function_round_trips_and_accepts_what_a_person_actually_types() {
        for f in Function::all() {
            assert_eq!(Function::parse(f.as_str()), Some(f));
        }
        // The clotting axis is the one nobody reaches for by its clinical name.
        for typed in ["clotting", "styptic", "stop bleeding", "STOP-BLEEDING", "haemostatic"] {
            assert_eq!(Function::parse(typed), Some(Function::Hemostatic), "{typed}");
        }
        assert_eq!(Function::parse("antimicrobial"), Some(Function::Antiseptic));
        assert_eq!(Function::parse("painkiller"), Some(Function::Analgesic));
        assert_eq!(Function::parse("nonsense"), None);
    }

    #[test]
    fn a_material_is_satisfied_by_containment_in_both_directions() {
        let m = Material {
            item: "metal container".into(),
            substitutes: vec!["tin can".into(), "canteen cup".into()],
            optional: false,
        };
        assert!(m.satisfied_by("can"), "the person's shorter word is inside a substitute");
        assert!(m.satisfied_by("an old tin can"), "the substitute is inside the person's longer phrase");
        assert!(m.satisfied_by("METAL CONTAINER"), "case-insensitive");
        assert!(!m.satisfied_by("birch bark"));
        assert!(!m.satisfied_by("   "), "an empty hand satisfies nothing");
    }

    #[test]
    fn grows_in_walks_the_region_hierarchy_and_refuses_a_prefix_that_is_not_one() {
        let r = |regions: &[&str]| Remedy {
            id: "x".into(),
            name: "x".into(),
            latin: None,
            functions: vec![Function::Hemostatic],
            regions: regions.iter().map(|s| s.to_string()).collect(),
            habitat: String::new(),
            parts: vec![],
            identify: vec![],
            lookalikes: vec![],
            preparations: vec![],
            cautions: vec!["c".into()],
            evidence: None,
        };
        // Exact, and both directions of the `-` hierarchy.
        assert!(r(&["north-america"]).grows_in("north-america"));
        assert!(r(&["north-america"]).grows_in("north-america-west"));
        assert!(r(&["north-america-west"]).grows_in("north-america"));
        // A bare string prefix is NOT a region prefix.
        assert!(!r(&["australasia"]).grows_in("asia"));
        assert!(!r(&["asia"]).grows_in("australasia"));
        // `worldwide` answers everything; an empty query asks nothing.
        assert!(r(&["worldwide"]).grows_in("patagonia"));
        assert!(r(&[]).grows_in(""));
        assert!(!r(&[]).grows_in("europe"), "no recorded range is not a claim of range");
    }
}
