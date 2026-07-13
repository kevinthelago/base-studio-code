// Data-defined KIT animations (#2942, epic #2865/#2553) — the RENDER path for motion an LLM authors
// as data on a KIT (`Kit.animations`), the motion sibling of themes. Each definition compiles to a
// `@keyframes bsc-<kit>-<name>` block + an applying rule on `.<kit>-anim-<name>`, injected into ONE
// managed `<style>`, so a kit's motion plays on any of its components with zero component changes.
// A component BINDS an animation by name (`ComponentRecord.animations: string[]`) — the renderer puts
// `.<kit>-anim-<name>` on the element; the kit owns the keyframes + timing + trigger.
//
// Motion is per-KIT, not global and not baked per-component: a kit is a structurally-distinct
// component set (its own DOM/CSS architecture), so a 3D / non-DOM kit carries a different motion
// representation, and two kits may reuse a name (`fade-in`) with different keyframes without colliding.
// Mirrors the variant render path (variants.ts): compiled on boot + re-applied on a `ui-touch` write.
// The applying rule is wrapped in `@media (prefers-reduced-motion: no-preference)`, so motion is
// suppressed for users who ask for less of it.
//
// DEFENSE IN DEPTH: like variants, this compiles LLM-authored data into live CSS, so a kit /
// animation name must be a safe CSS identifier, a keyframe stop must be `from`/`to`/`N%`, a property
// must be `[a-z-]+`, and no value may carry a declaration-ending / injection sequence. An optional
// child `selector` must pass `SAFE_SELECTOR` (only selector-safe characters — it cannot break out of
// the selector position). Anything failing is skipped, never emitted.

/** When an authored animation plays. */
export type AnimationTrigger = "mount" | "hover" | "always";

/** One authored animation in a kit's motion library (the shape carried on a `Kit`'s `animations`).
 *  A component references it by {@link name} to play it — the kit owns the keyframes/timing/trigger. */
export interface KitAnimation {
  /** Animation name — a safe CSS identifier → `.<kit>-anim-<name>` + `@keyframes bsc-<kit>-<name>`. */
  name: string;
  /** Keyframe stops: a selector (`from`/`to`/`N%`) → CSS declarations (property → value). */
  keyframes: Record<string, Record<string, string>>;
  /** Duration — a motion-token ref (`var(--dur-base)`) or a time (`220ms`). Default `var(--dur-base)`. */
  duration?: string;
  /** Easing — a motion-token ref (`var(--ease-standard)`) or a timing-function. Default `var(--ease-standard)`. */
  easing?: string;
  /** Animation-level delay (#3056) — a time (`120ms`), slotted after easing in the shorthand. Default none. */
  delay?: string;
  /** When it plays. Default `mount`. */
  trigger?: AnimationTrigger;
  /** Scope the applying rule to a CHILD element (#3054) — a descendant combinator
   *  (`.<kit>-anim-<name> <selector>`). Absent ⇒ the animation applies to the root class as before. */
  selector?: string;
  /** STATIC declarations set on the applying rule (#3054) — for `transform-origin` / `transform-box`
   *  etc. that can't live in keyframes. Each `property: value` is guarded like a keyframe declaration. */
  set?: Record<string, string>;
}

/** A kit animation + its owning kit's CSS class base (the flat shape the compiler takes). */
export interface AnimationDef extends KitAnimation {
  /** The kit's CSS class base (its id, e.g. `react-ui`). */
  kit: string;
}

const STYLE_ID = "bsc-ui-animations";
/** A safe CSS identifier for a class / keyframes-name segment (mirrors the CLI's sanitize_variant_name). */
const SAFE_IDENT = /^[a-z][a-z0-9-]*$/;
/** A keyframe stop selector — `from`, `to`, or a percentage (`0%`, `50%`, `100%`). */
const SAFE_STOP = /^(from|to|\d{1,3}%)$/;
/** A CSS property name — lowercase letters + hyphens (`opacity`, `transform`, `background-color`). */
const SAFE_PROP = /^[a-z-]+$/;
/** A child selector for the applying rule (#3054) — ONLY selector-safe characters, so it structurally
 *  cannot break out of the selector position into a declaration / new rule / comment (no `{ } ; < \ /`).
 *  Allows classes, tags, `#`ids, `>`/space/`+`/`~` combinators, `[attr="v"]`, `:nth-child(2n)`, `,` lists, `*`. */
const SAFE_SELECTOR = /^[a-zA-Z0-9 ._#>[\]="'\-:(),*+~]+$/;
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
  return stops.length ? `@keyframes bsc-${d.kit}-${d.name} {\n${stops.join("\n")}\n}` : "";
}

/**
 * Compile animation definitions into CSS: a `@keyframes bsc-<kit>-<name>` block + a
 * reduced-motion-guarded rule applying it on `.<kit>-anim-<name>` (`:hover` for a hover
 * trigger; `infinite` for `always`, else played once). A valid {@link KitAnimation.selector}
 * scopes the applying rule to a CHILD (`.<kit>-anim-<name> <selector>`, #3054); {@link KitAnimation.set}
 * adds static declarations to the rule body; {@link KitAnimation.delay} slots into the shorthand after
 * easing (#3056). Pure + guarded — skips any definition whose kit/name isn't a safe identifier, whose
 * duration/easing/delay looks like an injection, or with no valid keyframes; an unsafe selector falls
 * back to the root class and an unsafe `set` pair is dropped. Empty string when nothing is renderable.
 */
export function compileAnimationsCss(defs: AnimationDef[]): string {
  const blocks: string[] = [];
  for (const d of defs) {
    if (!d || !SAFE_IDENT.test(d.kit ?? "") || !SAFE_IDENT.test(d.name ?? "")) continue;
    const frames = keyframesCss(d);
    if (!frames) continue;
    const dur = safeValue(d.duration) ? d.duration! : DUR_DEFAULT;
    const ease = safeValue(d.easing) ? d.easing! : EASE_DEFAULT;
    const delay = safeValue(d.delay) ? ` ${d.delay}` : "";
    const anim = `bsc-${d.kit}-${d.name}`;
    const cls = `.${d.kit}-anim-${d.name}`;
    // #3054: scope to a child when a safe selector is given (descendant combinator); else the root class.
    const scoped = SAFE_SELECTOR.test(d.selector ?? "") ? `${cls} ${d.selector!.trim()}` : cls;
    const rule = d.trigger === "hover" ? `${scoped}:hover` : scoped;
    const iter = d.trigger === "always" ? "infinite" : "1";
    // #3054: static declarations on the applying rule, guarded exactly like a keyframe declaration.
    const setCss = Object.entries(d.set ?? {})
      .filter(([prop, value]) => SAFE_PROP.test(prop) && safeValue(value))
      .map(([prop, value]) => `${prop}: ${value};`)
      .join(" ");
    const body = `${setCss ? `${setCss} ` : ""}animation: ${anim} ${dur} ${ease}${delay} ${iter} both;`;
    blocks.push(
      `${frames}\n@media (prefers-reduced-motion: no-preference) {\n  ${rule} { ${body} }\n}`,
    );
  }
  return blocks.join("\n\n");
}

/** Flatten a kit list's authored `animations` into the flat `AnimationDef[]` the compiler takes,
 *  keying each by its kit's CSS class base (the kit id — the kit convention). */
export function kitAnimations(
  kits: { id: string; animations?: KitAnimation[] }[],
): AnimationDef[] {
  const out: AnimationDef[] = [];
  for (const k of kits) {
    const kit = k.id ?? "";
    for (const a of k.animations ?? []) out.push({ ...a, kit });
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
