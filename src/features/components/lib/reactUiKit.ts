// Generate the `react-ui` kit from the shared-UI manifest (#2305, slice 1). The app's OWN components
// are the first kit — derived from the authoritative introspection registry (`shared/ui/manifest.ts`,
// #2060, which `manifest.test.ts` keeps synced to the render-map) instead of a hand-listed seed. So the
// kit is COMPLETE (every registered primitive), NO-DRIFT (generated), and REAL (no fake demo rows).
//
// The manifest carries names + prop schemas + groups; the richer kit metadata it does NOT
// (variants/composes/wraps/whenUse/whenNot/srcText/version/role) is layered as a per-name GUIDANCE
// overlay. A primitive without an overlay entry gets sensible generated defaults + a stub source;
// authoring the rich guidance for the rest is #2305 slice 3.
import { UI_KIT, type PrimitiveSpec, type PropSpec as ManifestProp, type PrimitiveGroup } from "@/shared/ui/manifest";
import type { ComponentRecord, Kit, PropSpec, Role } from "./model";

export const REACT_UI_KIT_ID = "react-ui";

/** Default architectural role by manifest group (the overlay may override per component). */
const GROUP_ROLE: Record<PrimitiveGroup, Role> = {
  layout: "layout", typography: "primitive", controls: "primitive", data: "primitive", feedback: "primitive",
};

/** Kit metadata the manifest doesn't encode, keyed by component name. Ported from the #2269 seed for
 *  the components that had it; the rest fall back to generated defaults (rich guidance is slice 3). */
interface Guidance {
  role?: Role;
  version?: string;
  used?: number;
  tags?: string[];
  /** Overrides the manifest-derived variants entirely. */
  variants?: string[];
  composes?: string[];
  /** The raw intrinsic this component replaces — drives the derived lint rule (`deriveRules`). */
  wraps?: string;
  whenUse?: string[];
  whenNot?: string[];
  srcText?: string;
}

const GUIDANCE: Record<string, Guidance> = {
  Button: {
    version: "2.3.0", used: 214, tags: ["control", "form"], wraps: "button",
    variants: ["primary", "ghost", "danger", "sm"],
    whenUse: [
      "A single, discrete action the user can take.",
      'Form submit / primary CTA (use variant="primary", one per view).',
      'Inline row actions (use variant="ghost").',
    ],
    whenNot: ["Navigating between views — use a link.", "Toggling a persistent on/off state — use Toggle."],
    srcText: "export function Button({ variant, size, ...rest }: ButtonProps) {\n  return (\n    <button\n      className={cx(\"btn\", variant, size)}\n      {...rest}\n    />\n  );\n}",
  },
  Chip: {
    version: "1.4.1", used: 168, tags: ["badge", "status"], composes: ["StatusDot"],
    variants: ["neutral", "accent", "success", "info", "danger"],
    whenUse: ["A short, non-interactive status or category label.", "Dynamic colors (GitHub labels) via the color prop."],
    whenNot: ["A clickable filter — use SegmentedControl.", "Long text — chips are single-line."],
    srcText: "export function Chip({ tone = \"neutral\", color, dot, children }: ChipProps) {\n  if (color) return <span style={mix(color)}>{children}</span>;\n  return <span className={`chip tone-${tone}`}>{children}</span>;\n}",
  },
  TextField: {
    version: "1.2.0", used: 97, tags: ["form", "input"], wraps: "input",
    whenUse: ["Any single-line text input with a label.", "Controlled form fields (value + onChange)."],
    whenNot: ["Multi-line input — use a textarea.", "A boolean — use Toggle / Checkbox."],
    srcText: "export function TextField({ label, value, onChange, hint }: TextFieldProps) {\n  return (\n    <label className=\"field\">\n      <span>{label}</span>\n      <input className=\"input\" value={value}\n        onChange={(e) => onChange(e.target.value)} />\n    </label>\n  );\n}",
  },
  StatusDot: {
    version: "1.0.3", used: 142, tags: ["status"],
    whenUse: ["A tiny live activity indicator beside a label.", "Session / build state in a dense row."],
    whenNot: ["Conveying state by color alone — pair with text.", "A large status graphic — use a Banner."],
  },
  SegmentedControl: {
    role: "composite", version: "1.1.0", used: 63, tags: ["control"], composes: ["Button"],
    whenUse: ["2–4 mutually-exclusive options (mode / scope).", "A multi-toggle where each option holds its own state."],
    whenNot: ["Many options (>5) — use a select.", "A single on/off — use Toggle."],
  },
  Card: {
    role: "layout", version: "1.3.2", used: 121, tags: ["surface"],
    whenUse: ["Group related content in a framed surface.", "A selectable item in a list (interactive)."],
    whenNot: ["Full-bleed page sections — cards imply containment.", "A modal — use Dialog."],
  },
  EmptyState: {
    role: "composite", version: "1.0.5", used: 38, tags: ["feedback"], composes: ["Button", "Card"],
    whenUse: ["A list / view with nothing in it yet.", "An onboarding / connect prompt with a CTA."],
    whenNot: ["A transient loading state — use a skeleton.", "An error — use InlineError / Banner."],
  },
};

/** A manifest prop's type rendered as a short human/TS-ish string for the props table. */
function mapType(p: ManifestProp): string {
  if (p.type === "enum" && p.values) return p.values.map((v) => `"${v}"`).join(" | ");
  switch (p.type) {
    case "node": return "ReactNode";
    case "function": return "(…) => void";
    case "space": return "Space";
    case "fontSize": return "FontSize";
    case "tracks": return "Tracks";
    case "color": return "Color";
    case "style": return "CSSProperties";
    case "array": return "T[]";
    default: return p.type; // string | number | boolean
  }
}

const mapProps = (specs: readonly ManifestProp[]): PropSpec[] =>
  specs.map((p) => ({ name: p.name, type: mapType(p), req: !!p.required, desc: p.description }));

/** Variants: the overlay's set, else the `variant` enum's values (else "default"), plus "loading"
 *  when the component registers a `loading` prop (#2302). */
function deriveVariants(spec: PrimitiveSpec, g: Guidance): string[] {
  let base = g.variants;
  if (!base) {
    const variantProp = spec.props.find((p) => p.name === "variant" && p.type === "enum" && p.values);
    base = variantProp?.values ? [...variantProp.values] : ["default"];
  }
  const hasLoading = spec.props.some((p) => p.name === "loading");
  return hasLoading && !base.includes("loading") ? [...base, "loading"] : base;
}

/** A minimal, generated usage snippet for a component without an authored `srcText`. */
function stubSrc(spec: PrimitiveSpec): string {
  const req = spec.props.filter((p) => p.required && p.name !== "children");
  const attrs = req.map((p) => ` ${p.name}={…}`).join("");
  const hasChildren = spec.props.some((p) => p.name === "children");
  const body = hasChildren ? `<${spec.name}${attrs}>…</${spec.name}>` : `<${spec.name}${attrs} />`;
  return `import { ${spec.name} } from "${spec.importPath}";\n\n${body}`;
}

function toRecord(spec: PrimitiveSpec): ComponentRecord {
  const g = GUIDANCE[spec.name] ?? {};
  return {
    id: spec.name.toLowerCase(),
    name: spec.name,
    kitId: REACT_UI_KIT_ID,
    role: g.role ?? GROUP_ROLE[spec.group],
    version: g.version ?? "1.0.0",
    used: g.used ?? 0,
    tags: g.tags ?? [spec.group],
    variants: deriveVariants(spec, g),
    composes: g.composes ?? [],
    props: mapProps(spec.props),
    whenUse: g.whenUse ?? [],
    whenNot: g.whenNot ?? [],
    src: `${spec.importPath.replace(/^@\//, "")}.tsx`,
    srcText: g.srcText ?? stubSrc(spec),
    builtin: true,
    ...(g.wraps ? { wraps: g.wraps } : {}),
  };
}

/** The `react-ui` kit — the app's own shared-UI primitives. */
export const REACT_UI_KIT: Kit = {
  id: REACT_UI_KIT_ID, name: "react-ui", stack: "React · TypeScript", dot: "var(--info)", builtin: true,
};

/** Every registered primitive as a component record — generated from the manifest, so this is exactly
 *  `UI_KIT` (guarded by `reactUiKit.test.ts`), never a drifting hand-list. */
export const REACT_UI_COMPONENTS: ComponentRecord[] = UI_KIT.map(toRecord);
