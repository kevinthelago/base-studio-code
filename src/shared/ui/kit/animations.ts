// Data-defined component ANIMATIONS (#2867, epic #2865) — the RENDER path for motion an LLM authors
// as data on a component record (`ComponentRecord.animations`). Each definition compiles to a
// `@keyframes bsc-<component>-<name>` block + an applying rule on `.<component>-anim-<name>`, injected
// into ONE managed `<style>`, so authored motion plays on the real component with zero component
// changes. Mirrors the variant render path (variants.ts): compiled on boot + re-applied on a
// `ui-touch` write. The applying rule is wrapped in `@media (prefers-reduced-motion: no-preference)`,
// so motion is suppressed for users who ask for less of it.
//
// DEFENSE IN DEPTH: like variants, this compiles LLM-authored data into live CSS, so a component /
// animation name must be a safe CSS identifier, a keyframe stop must be `from`/`to`/`N%`, a property
// must be `[a-z-]+`, and no value may carry a declaration-ending / injection sequence. Anything
// failing is skipped, never emitted.

/** When an authored animation plays. */
export type AnimationTrigger = "mount" | "hover" | "always";

/** One authored component animation (the shape carried on a `ComponentRecord`'s `animations`). */
export interface ComponentAnimation {
  /** Animation name — a safe CSS identifier → `.<component>-anim-<name>` + `@keyframes bsc-<component>-<name>`. */
  name: string;
  /** Keyframe stops: a selector (`from`/`to`/`N%`) → CSS declarations (property → value). */
  keyframes: Record<string, Record<string, string>>;
  /** Duration — a motion-token ref (`var(--dur-base)`) or a time (`220ms`). Default `var(--dur-base)`. */
  duration?: string;
  /** Easing — a motion-token ref (`var(--ease-standard)`) or a timing-function. Default `var(--ease-standard)`. */
  easing?: string;
  /** When it plays. Default `mount`. */
  trigger?: AnimationTrigger;
}

/** A component animation + its owning component's CSS class base (the flat shape the compiler takes). */
export interface AnimationDef extends ComponentAnimation {
  /** The component's CSS class base (e.g. `card`, `btn`). */
  component: string;
}

const STYLE_ID = "bsc-ui-animations";
/** A safe CSS identifier for a class / keyframes-name segment (mirrors the CLI's sanitize_variant_name). */
const SAFE_IDENT = /^[a-z][a-z0-9-]*$/;
/** A keyframe stop selector — `from`, `to`, or a percentage (`0%`, `50%`, `100%`). */
const SAFE_STOP = /^(from|to|\d{1,3}%)$/;
/** A CSS property name — lowercase letters + hyphens (`opacity`, `transform`, `background-color`). */
const SAFE_PROP = /^[a-z-]+$/;
/** A value that could END the declaration or INJECT CSS — refused even though the CLI already guards. */
const UNSAFE_VALUE = /[;{}<>\\]|url\(|expression\(|@import|\/\*/i;
const DUR_DEFAULT = "var(--dur-base)";
const EASE_DEFAULT = "var(--ease-standard)";

function safeValue(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && !UNSAFE_VALUE.test(v);
}

/** Compile one animation's `@keyframes` block, or "" when no stop/declaration passes the guards. */
function keyframesCss(d: AnimationDef): string {
  const stops: string[] = [];
  for (const [stop, decls] of Object.entries(d.keyframes ?? {})) {
    if (!SAFE_STOP.test(stop)) continue;
    const lines = Object.entries(decls ?? {})
      .filter(([prop, value]) => SAFE_PROP.test(prop) && safeValue(value))
      .map(([prop, value]) => `    ${prop}: ${value};`);
    if (lines.length) stops.push(`  ${stop} {\n${lines.join("\n")}\n  }`);
  }
  return stops.length ? `@keyframes bsc-${d.component}-${d.name} {\n${stops.join("\n")}\n}` : "";
}

/**
 * Compile animation definitions into CSS: a `@keyframes bsc-<component>-<name>` block + a
 * reduced-motion-guarded rule applying it on `.<component>-anim-<name>` (`:hover` for a hover
 * trigger; `infinite` for `always`, else played once). Pure + guarded — skips any definition whose
 * component/name isn't a safe identifier, whose duration/easing looks like an injection, or with no
 * valid keyframes. Empty string when nothing is renderable.
 */
export function compileAnimationsCss(defs: AnimationDef[]): string {
  const blocks: string[] = [];
  for (const d of defs) {
    if (!d || !SAFE_IDENT.test(d.component ?? "") || !SAFE_IDENT.test(d.name ?? "")) continue;
    const frames = keyframesCss(d);
    if (!frames) continue;
    const dur = safeValue(d.duration) ? d.duration! : DUR_DEFAULT;
    const ease = safeValue(d.easing) ? d.easing! : EASE_DEFAULT;
    const anim = `bsc-${d.component}-${d.name}`;
    const cls = `.${d.component}-anim-${d.name}`;
    const selector = d.trigger === "hover" ? `${cls}:hover` : cls;
    const iter = d.trigger === "always" ? "infinite" : "1";
    blocks.push(
      `${frames}\n@media (prefers-reduced-motion: no-preference) {\n  ${selector} { animation: ${anim} ${dur} ${ease} ${iter} both; }\n}`,
    );
  }
  return blocks.join("\n\n");
}

/** Flatten a component list's authored `animations` into the flat `AnimationDef[]` the compiler takes,
 *  keying each by the component's CSS class base — its lowercased name (the kit convention). */
export function componentAnimations(
  components: { name: string; animations?: ComponentAnimation[] }[],
): AnimationDef[] {
  const out: AnimationDef[] = [];
  for (const c of components) {
    const component = (c.name ?? "").toLowerCase();
    for (const a of c.animations ?? []) out.push({ ...a, component });
  }
  return out;
}

/**
 * Inject / update / clear the managed `<style id="bsc-ui-animations">` holding the compiled animation
 * CSS. Removing the last animation removes the element. `doc` is param'd for tests. Mirrors
 * {@link applyVariantsToRoot} — one global stylesheet the whole app follows.
 */
export function applyAnimationsToRoot(defs: AnimationDef[], doc: Document = document): void {
  const css = compileAnimationsCss(defs);
  let el = doc.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!css) {
    el?.remove();
    return;
  }
  if (!el) {
    el = doc.createElement("style");
    el.id = STYLE_ID;
    doc.head.appendChild(el);
  }
  el.textContent = css;
}
