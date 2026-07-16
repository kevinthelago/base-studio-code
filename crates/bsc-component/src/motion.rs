//! The motion COMPILER (#3163) — the Rust port of `compileAnimationsCss` (`src/shared/ui/kit/animations.ts`),
//! so `bsc ui kit emit-motion-css` can print the SAME compiled CSS an author's motion renders as: the
//! `@keyframes` blocks + the `prefers-reduced-motion`-guarded applying rules (+ delays + the per-element
//! stagger ramp) — the black box made inspectable.
//!
//! Like the frontend compiler this turns LLM-authored data into live CSS, so it carries the SAME closed
//! safety grammar (a kit/name must be a safe ident, a stop must be `from`/`to`/`N%`, a property must be
//! `[a-z-]+`, no value may inject CSS, a child `selector` must be selector-safe) and SKIPS anything that
//! fails — never emitting it. It also mirrors the #3163 component NAMESPACING: a def carrying a
//! `component` compiles to `bsc-<kit>-<component>-<name>` / `.<kit>-<component>-anim-<name>` so two
//! components' same-named animations don't collide. Kept in lockstep with animations.ts.

use serde_json::{Map, Value};

const DUR_DEFAULT: &str = "var(--dur-base)";
const EASE_DEFAULT: &str = "var(--ease-standard)";
/// Cap on the stagger nth-child ramp (mirrors animations.ts `STAGGER_MAX`).
const STAGGER_MAX: usize = 32;

/// A safe CSS identifier — `^[a-z][a-z0-9-]*$` (mirrors animations.ts `SAFE_IDENT`).
fn is_safe_ident(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_lowercase() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// A keyframe stop selector — `from`, `to`, or a 1–3 digit percentage (mirrors `SAFE_STOP`).
fn is_safe_stop(s: &str) -> bool {
    if s == "from" || s == "to" {
        return true;
    }
    match s.strip_suffix('%') {
        Some(num) => (1..=3).contains(&num.len()) && num.chars().all(|c| c.is_ascii_digit()),
        None => false,
    }
}

/// A CSS declaration property — `^[a-z-]+$`, non-empty (mirrors `SAFE_PROP`).
fn is_safe_prop(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_lowercase() || c == '-')
}

/// A non-empty CHILD selector using ONLY selector-safe characters (mirrors `SAFE_SELECTOR`).
fn is_safe_selector(s: &str) -> bool {
    !s.is_empty()
        && s.chars().all(|c| {
            c.is_ascii_alphanumeric()
                || matches!(
                    c,
                    ' ' | '.' | '_' | '#' | '>' | '[' | ']' | '=' | '"' | '\'' | '-' | ':' | '(' | ')'
                        | ',' | '*' | '+' | '~'
                )
        })
}

/// A declaration/duration/easing VALUE that cannot end the declaration or inject CSS (mirrors `safeValue`).
fn is_safe_value(v: &str) -> bool {
    if v.is_empty() {
        return false;
    }
    if v.chars().any(|c| matches!(c, ';' | '{' | '}' | '<' | '>' | '\\')) {
        return false;
    }
    let lower = v.to_ascii_lowercase();
    !(lower.contains("url(") || lower.contains("expression(") || lower.contains("@import") || lower.contains("/*"))
}

/// Sanitize a component name into a safe CSS-identifier SEGMENT for keyframe/class namespacing (#3163) —
/// the exact mirror of animations.ts `identSegment`: lowercased, each maximal run of non-`[a-z0-9-]`
/// chars collapsed to a single `-`, leading/trailing `-` stripped; "" if the result isn't a safe ident.
fn ident_segment(s: &str) -> String {
    let lower = s.to_ascii_lowercase();
    let mut out = String::with_capacity(lower.len());
    let mut in_bad_run = false;
    for c in lower.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' {
            out.push(c);
            in_bad_run = false;
        } else if !in_bad_run {
            out.push('-');
            in_bad_run = true;
        }
    }
    let slug = out.trim_matches('-');
    if is_safe_ident(slug) {
        slug.to_string()
    } else {
        String::new()
    }
}

fn get_str<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

/// The `@keyframes` NAME for a def — namespaced by `component` when one resolves (#3163).
fn keyframe_name(component: &str, kit: &str, name: &str) -> String {
    let seg = ident_segment(component);
    if seg.is_empty() {
        format!("bsc-{kit}-{name}")
    } else {
        format!("bsc-{kit}-{seg}-{name}")
    }
}

/// The applying CLASS hook for a def — the component-namespaced twin of {@link keyframe_name} (#3163).
fn class_name(component: &str, kit: &str, name: &str) -> String {
    let seg = ident_segment(component);
    if seg.is_empty() {
        format!("{kit}-anim-{name}")
    } else {
        format!("{kit}-{seg}-anim-{name}")
    }
}

/// Compile one animation's `@keyframes` block, or "" when no stop/declaration passes the guards.
fn keyframes_css(d: &Value, anim: &str) -> String {
    let mut stops: Vec<String> = Vec::new();
    if let Some(kf) = d.get("keyframes").and_then(Value::as_object) {
        for (stop, decls) in kf {
            if !is_safe_stop(stop) {
                continue;
            }
            let mut lines: Vec<String> = Vec::new();
            if let Some(obj) = decls.as_object() {
                for (prop, value) in obj {
                    if is_safe_prop(prop) {
                        if let Some(vs) = value.as_str() {
                            if is_safe_value(vs) {
                                lines.push(format!("    {prop}: {vs};"));
                            }
                        }
                    }
                }
            }
            if !lines.is_empty() {
                stops.push(format!("  {stop} {{\n{}\n  }}", lines.join("\n")));
            }
        }
    }
    if stops.is_empty() {
        String::new()
    } else {
        format!("@keyframes {anim} {{\n{}\n}}", stops.join("\n"))
    }
}

/// STATIC declarations (`set`) applied on the rule body — each guarded like a keyframe declaration.
fn set_css(d: &Value) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(set) = d.get("set").and_then(Value::as_object) {
        for (prop, value) in set {
            if is_safe_prop(prop) {
                if let Some(vs) = value.as_str() {
                    if is_safe_value(vs) {
                        parts.push(format!("{prop}: {vs};"));
                    }
                }
            }
        }
    }
    parts.join(" ")
}

/// Compile flat animation definitions (each a JSON object carrying `kit`, an optional `component`, and the
/// `KitAnimation` fields) into CSS — the Rust twin of `compileAnimationsCss`. Empty string when nothing is
/// renderable. Pure + guarded (skips any def failing the safety grammar).
pub fn compile_animations_css(defs: &[Value]) -> String {
    let mut blocks: Vec<String> = Vec::new();
    for d in defs {
        let kit = get_str(d, "kit").unwrap_or_default();
        let name = get_str(d, "name").unwrap_or_default();
        if !is_safe_ident(kit) || !is_safe_ident(name) {
            continue;
        }
        let component = get_str(d, "component").unwrap_or_default();
        let anim = keyframe_name(component, kit, name);
        let frames = keyframes_css(d, &anim);
        if frames.is_empty() {
            continue;
        }
        let dur = match get_str(d, "duration") {
            Some(s) if is_safe_value(s) => s,
            _ => DUR_DEFAULT,
        };
        let ease = match get_str(d, "easing") {
            Some(s) if is_safe_value(s) => s,
            _ => EASE_DEFAULT,
        };
        let delay = match get_str(d, "delay") {
            Some(s) if is_safe_value(s) => format!(" {s}"),
            _ => String::new(),
        };
        let cls = format!(".{}", class_name(component, kit, name));

        let selector = get_str(d, "selector").unwrap_or_default();
        let selector_ok = is_safe_selector(selector);
        let scoped = if selector_ok { format!("{cls} {}", selector.trim()) } else { cls };

        let trigger = get_str(d, "trigger").unwrap_or("mount");
        let rule = match trigger {
            "hover" => format!("{scoped}:hover"),
            "exit" => format!("{scoped}[data-bsc-exit]"),
            _ => scoped,
        };
        let iter = if trigger == "always" { "infinite" } else { "1" };

        let set = set_css(d);
        let prefix = if set.is_empty() { String::new() } else { format!("{set} ") };
        let body = format!("{prefix}animation: {anim} {dur} {ease}{delay} {iter} both;");

        // #3055 per-element stagger ramp: with a safe selector AND a safe stagger STEP, cascade the matched
        // elements by a bounded nth-child(2..STAGGER_MAX) animation-delay ramp after the base rule.
        let mut stagger_ramp = String::new();
        if selector_ok {
            let stagger = match get_str(d, "stagger") {
                Some(s) if is_safe_value(s) => Some(s),
                _ => None,
            };
            if let Some(step) = stagger {
                let base_term = match get_str(d, "delay") {
                    Some(s) if is_safe_value(s) => format!("{s} + "),
                    _ => String::new(),
                };
                let mut steps: Vec<String> = Vec::new();
                for k in 2..=STAGGER_MAX {
                    steps.push(format!(
                        "  {rule}:nth-child({k}) {{ animation-delay: calc({base_term}{} * {step}); }}",
                        k - 1
                    ));
                }
                stagger_ramp = format!("\n{}", steps.join("\n"));
            }
        }

        blocks.push(format!(
            "{frames}\n@media (prefers-reduced-motion: no-preference) {{\n  {rule} {{ {body} }}{stagger_ramp}\n}}"
        ));
    }
    blocks.join("\n\n")
}

/// Stamp `kit` (and optional owning `component`, #3163) onto an animation object, producing the flat
/// AnimationDef {@link compile_animations_css} consumes. A non-object anim yields `None` (skipped).
pub fn anim_def(anim: &Value, kit: &str, component: Option<&str>) -> Option<Value> {
    let obj = anim.as_object()?;
    let mut m: Map<String, Value> = obj.clone();
    m.insert("kit".to_string(), Value::String(kit.to_string()));
    if let Some(c) = component {
        m.insert("component".to_string(), Value::String(c.to_string()));
    }
    Some(Value::Object(m))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn compiles_a_basic_animation_like_the_ts_twin() {
        let defs = [json!({ "kit": "react-ui", "name": "fade-in",
            "keyframes": { "from": { "opacity": "0" }, "to": { "opacity": "1" } } })];
        let css = compile_animations_css(&defs);
        assert!(css.contains("@keyframes bsc-react-ui-fade-in {"));
        assert!(css.contains("@media (prefers-reduced-motion: no-preference) {"));
        assert!(css.contains(
            ".react-ui-anim-fade-in { animation: bsc-react-ui-fade-in var(--dur-base) var(--ease-standard) 1 both; }"
        ));
    }

    #[test]
    fn namespaces_by_component_so_two_components_dont_collide() {
        let defs = [
            json!({ "kit": "react-ui", "name": "draw-in", "component": "BarChart", "keyframes": { "from": { "opacity": "0" } } }),
            json!({ "kit": "react-ui", "name": "draw-in", "component": "Sparkline", "keyframes": { "from": { "opacity": "1" } } }),
        ];
        let css = compile_animations_css(&defs);
        assert!(css.contains("@keyframes bsc-react-ui-barchart-draw-in {"));
        assert!(css.contains("@keyframes bsc-react-ui-sparkline-draw-in {"));
        assert!(css.contains(".react-ui-barchart-anim-draw-in { animation: bsc-react-ui-barchart-draw-in"));
        assert!(!css.contains("@keyframes bsc-react-ui-draw-in {"), "never the colliding un-namespaced form");
    }

    #[test]
    fn ident_segment_mirrors_the_ts_sanitizer() {
        assert_eq!(ident_segment("Sparkline"), "sparkline");
        assert_eq!(ident_segment("Bar Chart"), "bar-chart");
        assert_eq!(ident_segment("BarChart"), "barchart");
        assert_eq!(ident_segment(""), "");
        assert_eq!(ident_segment("***"), "", "an all-unsafe name falls back to the un-namespaced form");
    }

    #[test]
    fn honors_trigger_selector_set_delay_and_stagger() {
        let hover = compile_animations_css(&[json!({ "kit": "react-ui", "name": "pulse", "trigger": "hover",
            "duration": "120ms", "easing": "var(--ease-emphasized)", "keyframes": { "from": { "opacity": "0" } } })]);
        assert!(hover.contains(".react-ui-anim-pulse:hover { animation: bsc-react-ui-pulse 120ms var(--ease-emphasized) 1 both; }"));

        let child = compile_animations_css(&[json!({ "kit": "react-ui", "name": "spin", "selector": ".icon",
            "set": { "transform-origin": "center" }, "keyframes": { "from": { "opacity": "0" } } })]);
        assert!(child.contains(".react-ui-anim-spin .icon { transform-origin: center; animation:"));

        let always = compile_animations_css(&[json!({ "kit": "react-ui", "name": "loop", "trigger": "always",
            "keyframes": { "from": { "opacity": "0" } } })]);
        assert!(always.contains("infinite both; }"));

        let wave = compile_animations_css(&[json!({ "kit": "react-ui", "name": "wave", "selector": ".cell",
            "stagger": "14ms", "keyframes": { "from": { "opacity": "0" } } })]);
        assert!(wave.contains(".react-ui-anim-wave .cell:nth-child(2) { animation-delay: calc(1 * 14ms); }"));
        assert!(wave.contains(".react-ui-anim-wave .cell:nth-child(32) { animation-delay: calc(31 * 14ms); }"));
        assert!(!wave.contains(":nth-child(33)"));
    }

    #[test]
    fn skips_unsafe_defs() {
        assert_eq!(
            compile_animations_css(&[json!({ "kit": "React-UI", "name": "x", "keyframes": { "from": { "opacity": "0" } } })]),
            ""
        );
        assert_eq!(
            compile_animations_css(&[json!({ "kit": "react-ui", "name": "x", "keyframes": { "from": { "opacity": "1; } a{" } } })]),
            ""
        );
        assert_eq!(compile_animations_css(&[]), "");
    }

    #[test]
    fn anim_def_stamps_kit_and_component() {
        let a = json!({ "name": "draw", "keyframes": { "from": { "opacity": "0" } } });
        let kit_def = anim_def(&a, "react-ui", None).unwrap();
        assert_eq!(kit_def.get("kit").and_then(Value::as_str), Some("react-ui"));
        assert!(kit_def.get("component").is_none());
        let comp_def = anim_def(&a, "react-ui", Some("BarChart")).unwrap();
        assert_eq!(comp_def.get("component").and_then(Value::as_str), Some("BarChart"));
        assert!(anim_def(&json!("a-name-ref"), "react-ui", None).is_none(), "a name-ref string yields no def");
    }
}
