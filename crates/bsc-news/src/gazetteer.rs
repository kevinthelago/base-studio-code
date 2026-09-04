//! Places and circumstances as data.
//!
//! **Demonyms are not an afterthought.** `Russian`, `Chinese` and `Nepalese` outnumber the bare
//! country name in headlines, so a place filter without them misses most of its hits — which is why
//! every entry carries its adjective forms alongside the country and its news-relevant cities.
//!
//! Neither table is exhaustive and neither pretends to be. A gazetteer is a curation, and the honest
//! failure mode is a miss (a place not listed simply does not match) rather than a wrong hit.

/// A place: canonical key, then every surface form that means it.
pub struct Place {
    pub key: &'static str,
    pub forms: &'static [&'static str],
}

/// A circumstance: canonical key, then the words that signal it.
pub struct Circumstance {
    pub key: &'static str,
    /// The broad family this belongs to, for `entities --kind circumstance` grouping.
    pub family: &'static str,
    pub forms: &'static [&'static str],
}

/// Countries, demonyms and the cities that carry news. Ordered roughly by how often they appear.
pub const PLACES: &[Place] = &[
    Place { key: "russia", forms: &["russia", "russian", "russians", "moscow", "kremlin", "st petersburg", "petersburg", "sochi", "vladivostok"] },
    Place { key: "ukraine", forms: &["ukraine", "ukrainian", "ukrainians", "kyiv", "kiev", "odesa", "odessa", "kharkiv", "lviv", "donbas", "donetsk", "luhansk", "mariupol", "zaporizhzhia", "crimea"] },
    Place { key: "china", forms: &["china", "chinese", "beijing", "shanghai", "shenzhen", "guangzhou", "hong kong", "hongkong", "xinjiang", "tibet", "wuhan", "chengdu"] },
    Place { key: "united-states", forms: &["united states", "u.s.", "us", "usa", "america", "american", "americans", "washington", "new york", "california", "texas", "florida", "chicago", "los angeles", "pentagon", "white house", "capitol hill", "eeuu", "ee.uu", "estados unidos", "estadounidense"] },
    Place { key: "united-kingdom", forms: &["united kingdom", "britain", "british", "u.k.", "uk", "england", "english", "london", "scotland", "scottish", "wales", "welsh", "northern ireland", "westminster", "downing street"] },
    Place { key: "israel", forms: &["israel", "israeli", "israelis", "jerusalem", "tel aviv", "idf"] },
    Place { key: "palestine", forms: &["palestine", "palestinian", "palestinians", "gaza", "west bank", "ramallah", "rafah", "hamas"] },
    Place { key: "iran", forms: &["iran", "iranian", "iranians", "tehran"] },
    Place { key: "india", forms: &["india", "indian", "indians", "delhi", "new delhi", "mumbai", "kolkata", "bengaluru", "kashmir"] },
    Place { key: "nepal", forms: &["nepal", "nepali", "nepalese", "kathmandu"] },
    Place { key: "germany", forms: &["germany", "german", "germans", "berlin", "munich", "frankfurt", "hamburg"] },
    Place { key: "france", forms: &["france", "french", "paris", "marseille", "lyon"] },
    Place { key: "japan", forms: &["japan", "japanese", "tokyo", "osaka", "fukushima"] },
    Place { key: "south-korea", forms: &["south korea", "korean", "seoul"] },
    Place { key: "north-korea", forms: &["north korea", "pyongyang", "dprk"] },
    Place { key: "taiwan", forms: &["taiwan", "taiwanese", "taipei"] },
    Place { key: "turkey", forms: &["turkey", "turkish", "ankara", "istanbul", "turkiye"] },
    Place { key: "syria", forms: &["syria", "syrian", "syrians", "damascus", "aleppo"] },
    Place { key: "iraq", forms: &["iraq", "iraqi", "iraqis", "baghdad", "mosul"] },
    Place { key: "afghanistan", forms: &["afghanistan", "afghan", "afghans", "kabul", "taliban"] },
    Place { key: "pakistan", forms: &["pakistan", "pakistani", "pakistanis", "islamabad", "karachi", "lahore"] },
    Place { key: "saudi-arabia", forms: &["saudi arabia", "saudi", "saudis", "riyadh", "jeddah"] },
    Place { key: "egypt", forms: &["egypt", "egyptian", "egyptians", "cairo"] },
    Place { key: "lebanon", forms: &["lebanon", "lebanese", "beirut", "hezbollah"] },
    Place { key: "yemen", forms: &["yemen", "yemeni", "sanaa", "houthi", "houthis"] },
    Place { key: "italy", forms: &["italy", "italian", "italians", "rome", "milan", "venice"] },
    Place { key: "spain", forms: &["spain", "spanish", "madrid", "barcelona", "ceuta"] },
    Place { key: "poland", forms: &["poland", "polish", "warsaw"] },
    Place { key: "belarus", forms: &["belarus", "belarusian", "minsk"] },
    Place { key: "moldova", forms: &["moldova", "moldovan", "chisinau"] },
    Place { key: "georgia-country", forms: &["tbilisi", "georgian"] },
    Place { key: "kazakhstan", forms: &["kazakhstan", "kazakh", "astana", "almaty"] },
    Place { key: "brazil", forms: &["brazil", "brazilian", "brasilia", "sao paulo", "rio de janeiro"] },
    Place { key: "mexico", forms: &["mexico", "mexican", "mexicans", "mexico city"] },
    Place { key: "canada", forms: &["canada", "canadian", "canadians", "ottawa", "toronto", "vancouver"] },
    Place { key: "argentina", forms: &["argentina", "argentine", "argentinian", "buenos aires"] },
    Place { key: "colombia", forms: &["colombia", "colombian", "bogota"] },
    Place { key: "venezuela", forms: &["venezuela", "venezuelan", "caracas"] },
    Place { key: "australia", forms: &["australia", "australian", "australians", "canberra", "sydney", "melbourne"] },
    Place { key: "new-zealand", forms: &["new zealand", "wellington", "auckland"] },
    Place { key: "indonesia", forms: &["indonesia", "indonesian", "jakarta"] },
    Place { key: "philippines", forms: &["philippines", "filipino", "manila"] },
    Place { key: "vietnam", forms: &["vietnam", "vietnamese", "hanoi"] },
    Place { key: "thailand", forms: &["thailand", "thai", "bangkok"] },
    Place { key: "myanmar", forms: &["myanmar", "burma", "burmese", "yangon", "naypyidaw"] },
    Place { key: "bangladesh", forms: &["bangladesh", "bangladeshi", "dhaka"] },
    Place { key: "sri-lanka", forms: &["sri lanka", "sri lankan", "colombo"] },
    Place { key: "nigeria", forms: &["nigeria", "nigerian", "nigerians", "abuja", "lagos"] },
    Place { key: "kenya", forms: &["kenya", "kenyan", "kenyans", "nairobi"] },
    Place { key: "ethiopia", forms: &["ethiopia", "ethiopian", "addis ababa"] },
    Place { key: "south-africa", forms: &["south africa", "south african", "johannesburg", "pretoria", "cape town"] },
    Place { key: "sudan", forms: &["sudan", "sudanese", "khartoum", "darfur"] },
    Place { key: "algeria", forms: &["algeria", "algerian", "algerians", "algiers"] },
    Place { key: "morocco", forms: &["morocco", "moroccan", "rabat", "casablanca"] },
    Place { key: "libya", forms: &["libya", "libyan", "tripoli"] },
    Place { key: "netherlands", forms: &["netherlands", "dutch", "amsterdam", "the hague"] },
    Place { key: "belgium", forms: &["belgium", "belgian", "brussels"] },
    Place { key: "sweden", forms: &["sweden", "swedish", "stockholm"] },
    Place { key: "norway", forms: &["norway", "norwegian", "oslo"] },
    Place { key: "denmark", forms: &["denmark", "danish", "copenhagen"] },
    Place { key: "finland", forms: &["finland", "finnish", "helsinki"] },
    Place { key: "switzerland", forms: &["switzerland", "swiss", "geneva", "zurich", "bern"] },
    Place { key: "austria", forms: &["austria", "austrian", "vienna"] },
    Place { key: "greece", forms: &["greece", "greek", "athens"] },
    Place { key: "portugal", forms: &["portugal", "portuguese", "lisbon"] },
    Place { key: "ireland", forms: &["ireland", "irish", "dublin"] },
    Place { key: "hungary", forms: &["hungary", "hungarian", "budapest"] },
    Place { key: "romania", forms: &["romania", "romanian", "bucharest"] },
    Place { key: "czechia", forms: &["czech", "czechia", "prague"] },
    Place { key: "serbia", forms: &["serbia", "serbian", "belgrade"] },
    Place { key: "armenia", forms: &["armenia", "armenian", "yerevan"] },
    Place { key: "azerbaijan", forms: &["azerbaijan", "azerbaijani", "baku"] },
    Place { key: "uae", forms: &["united arab emirates", "uae", "emirati", "dubai", "abu dhabi"] },
    Place { key: "qatar", forms: &["qatar", "qatari", "doha"] },
    Place { key: "cuba", forms: &["cuba", "cuban", "havana"] },
    Place { key: "haiti", forms: &["haiti", "haitian", "port-au-prince"] },
    Place { key: "chile", forms: &["chile", "chilean", "santiago"] },
    Place { key: "peru", forms: &["peru", "peruvian", "lima"] },
    Place { key: "european-union", forms: &["european union", "eu", "brussels summit", "european commission"] },
    Place { key: "united-nations", forms: &["united nations", "un security council", "unesco", "unicef"] },
    Place { key: "nato", forms: &["nato"] },
    // Regions and continents. A headline says `Europe` far more often than it names a country, and
    // without these the region reads as an unresolved name rather than a place.
    Place { key: "europe", forms: &["europe", "european", "europeans"] },
    Place { key: "africa", forms: &["africa", "african", "africans", "sahel"] },
    Place { key: "asia", forms: &["asia", "asian", "asians", "asia-pacific", "indo-pacific"] },
    Place { key: "middle-east", forms: &["middle east", "middle-east", "gulf states", "hormuz", "strait of hormuz"] },
    Place { key: "latin-america", forms: &["latin america", "latin american", "south america", "central america"] },
    Place { key: "balkans", forms: &["balkans", "balkan", "kosovo", "bosnia", "croatia", "albania"] },
    Place { key: "arctic", forms: &["arctic", "svalbard"] },
    Place { key: "caribbean", forms: &["caribbean"] },
];

/// Event types. `family` groups them so a question like "what disasters is anyone covering" is
/// answerable without naming one.
pub const CIRCUMSTANCES: &[Circumstance] = &[
    Circumstance { key: "flood", family: "disaster", forms: &["flood", "floods", "flooding", "floodwaters", "inundated", "deluge"] },
    Circumstance { key: "earthquake", family: "disaster", forms: &["earthquake", "earthquakes", "quake", "tremor", "aftershock", "seismic"] },
    Circumstance { key: "landslide", family: "disaster", forms: &["landslide", "landslides", "mudslide", "rockfall"] },
    Circumstance { key: "wildfire", family: "disaster", forms: &["wildfire", "wildfires", "bushfire", "blaze", "firefighters"] },
    Circumstance { key: "storm", family: "disaster", forms: &["hurricane", "typhoon", "cyclone", "tornado", "storm", "blizzard"] },
    Circumstance { key: "drought", family: "disaster", forms: &["drought", "famine", "crop failure", "water shortage"] },
    Circumstance { key: "airstrike", family: "conflict", forms: &["airstrike", "airstrikes", "air strike", "bombardment", "shelling", "missile strike", "drone strike"] },
    Circumstance { key: "offensive", family: "conflict", forms: &["offensive", "invasion", "incursion", "counteroffensive", "advance", "front line", "frontline"] },
    Circumstance { key: "ceasefire", family: "conflict", forms: &["ceasefire", "truce", "armistice", "peace deal", "peace talks", "settlement"] },
    Circumstance { key: "casualties", family: "conflict", forms: &["casualties", "death toll", "fatalities", "wounded", "civilian deaths"] },
    Circumstance { key: "terrorism", family: "conflict", forms: &["terror attack", "bombing", "suicide bomber", "hostage", "hostages"] },
    Circumstance { key: "election", family: "politics", forms: &["election", "elections", "ballot", "vote", "referendum", "polls", "campaign trail"] },
    Circumstance { key: "summit", family: "politics", forms: &["summit", "state visit", "bilateral talks", "delegation", "envoy"] },
    Circumstance { key: "sanctions", family: "politics", forms: &["sanctions", "sanctioned", "embargo", "export controls", "blacklist"] },
    Circumstance { key: "coup", family: "politics", forms: &["coup", "junta", "seized power", "impeachment", "no-confidence"] },
    Circumstance { key: "protest", family: "unrest", forms: &["protest", "protests", "protesters", "demonstration", "rally", "riot", "riots", "unrest", "crackdown"] },
    Circumstance { key: "labor-action", family: "unrest", forms: &["walkout", "picket", "union strike", "industrial action", "work stoppage"] },
    Circumstance { key: "trial", family: "justice", forms: &["trial", "verdict", "convicted", "acquitted", "sentencing", "sentenced", "indictment", "indicted", "jury"] },
    Circumstance { key: "investigation", family: "justice", forms: &["investigation", "probe", "inquiry", "subpoena", "raid on", "charges"] },
    Circumstance { key: "corruption", family: "justice", forms: &["corruption", "bribery", "embezzlement", "fraud", "kickback"] },
    Circumstance { key: "crash", family: "accident", forms: &["crash", "crashed", "derailment", "collision", "capsized", "shipwreck"] },
    Circumstance { key: "explosion", family: "accident", forms: &["explosion", "blast", "detonated"] },
    Circumstance { key: "collapse", family: "accident", forms: &["collapse", "collapsed", "cave-in", "trapped workers"] },
    Circumstance { key: "outbreak", family: "health", forms: &["outbreak", "epidemic", "pandemic", "virus", "infections", "quarantine"] },
    Circumstance { key: "inflation", family: "economy", forms: &["inflation", "cost of living", "price rises", "consumer prices"] },
    Circumstance { key: "trade", family: "economy", forms: &["tariff", "tariffs", "trade war", "trade deal", "export ban"] },
    Circumstance { key: "markets", family: "economy", forms: &["stock market", "shares fell", "shares rose", "recession", "bankruptcy", "layoffs"] },
    Circumstance { key: "migration", family: "society", forms: &["migration", "asylum", "border crossing", "deportation", "refugee camp"] },
    Circumstance { key: "climate", family: "society", forms: &["climate change", "emissions", "global warming", "cop29", "cop30"] },
];

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn place_keys_are_unique_and_slug_shaped() {
        let keys: BTreeSet<_> = PLACES.iter().map(|p| p.key).collect();
        assert_eq!(keys.len(), PLACES.len(), "a duplicate key would silently merge two places");
        for p in PLACES {
            assert!(
                p.key.chars().all(|c| c.is_ascii_lowercase() || c == '-'),
                "{} must be a slug so it can be typed as a filter",
                p.key
            );
        }
    }

    #[test]
    fn every_form_is_lowercase_and_non_empty() {
        // Matching lowercases the text, so an uppercase form here could never fire.
        for p in PLACES {
            assert!(!p.forms.is_empty(), "{} needs forms", p.key);
            for f in p.forms {
                assert_eq!(*f, f.to_lowercase(), "place form '{f}' must be lowercase");
                assert!(!f.trim().is_empty());
            }
        }
        for c in CIRCUMSTANCES {
            assert!(!c.forms.is_empty(), "{} needs forms", c.key);
            for f in c.forms {
                assert_eq!(*f, f.to_lowercase(), "circumstance form '{f}' must be lowercase");
            }
        }
    }

    #[test]
    fn every_country_carries_its_demonym() {
        // The whole reason the table has `forms` rather than a name: `Russian` and `Chinese` beat
        // the bare country name in headlines, so a table without them misses most of its hits.
        for (key, demonym) in
            [("russia", "russian"), ("china", "chinese"), ("nepal", "nepalese"), ("ukraine", "ukrainian")]
        {
            let p = PLACES.iter().find(|p| p.key == key).expect(key);
            assert!(p.forms.contains(&demonym), "{key} must match its demonym '{demonym}'");
        }
    }

    #[test]
    fn no_form_belongs_to_two_places() {
        // An ambiguous form would make a filter silently return another country's articles.
        let mut seen: std::collections::BTreeMap<&str, &str> = Default::default();
        for p in PLACES {
            for f in p.forms {
                if let Some(other) = seen.insert(f, p.key) {
                    panic!("form '{f}' is claimed by both {other} and {}", p.key);
                }
            }
        }
    }

    #[test]
    fn circumstance_keys_are_unique_and_families_are_named() {
        let keys: BTreeSet<_> = CIRCUMSTANCES.iter().map(|c| c.key).collect();
        assert_eq!(keys.len(), CIRCUMSTANCES.len());
        for c in CIRCUMSTANCES {
            assert!(!c.family.is_empty(), "{} needs a family", c.key);
        }
    }

    #[test]
    fn the_ambiguous_word_strike_is_never_a_bare_form() {
        // `strike` means an airstrike, a labour walkout or a football shot depending on context, and
        // this layer cannot tell which. Every circumstance using it must qualify it, so the filter
        // does not quietly conflate three unrelated events.
        for c in CIRCUMSTANCES {
            for f in c.forms {
                assert_ne!(*f, "strike", "{} must qualify `strike`, not match it bare", c.key);
                assert_ne!(*f, "strikes", "{} must qualify `strikes`, not match it bare", c.key);
            }
        }
    }
}
