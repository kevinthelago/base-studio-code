// The classification's DERIVED PREDICATES, captured from the live TypeScript so Rust can match them.
//
// ## Why these move and the vocabulary did not
//
// `crates/plandb` STORES a classification (`classify_set`/`classify_get`) and VALIDATES it
// (`validate_classify_config`). It never asks anything OF it. Every question about what a
// classification MEANS is answered in the renderer — and those answers drive real behaviour: which
// stages a project needs, whether the designer is wired in, whether the host must isolate before it
// renders, what the director is told. A worker or director asking the same question today cannot:
// `bsc plan classify get` returns the blob, but its meaning is not reachable, so a session must
// re-derive the rules from prose.
//
//     UPDATE_FIXTURES=1 npx vitest run src/features/planner/lib/classifyPredicates.fixtures.gen.test.ts
//
// ## The defaulting is the subtle part, so it is the part the corpus is built around
//
// Every accessor takes `ClassifyConfig | undefined | null` and returns a DEFAULT, so "absent" and
// "explicitly set to the default" are indistinguishable downstream. That is a decision, it is written
// down nowhere in Rust, and a port returning an Option instead would change behaviour at every call
// site. Each accessor therefore gets all three input states: a config that sets the field, a config
// that omits it, and no config at all — with `null` and `undefined` both present, because they are
// two ways of saying nothing and must stay indistinguishable.
//
// `usesGithub` is the deliberate EXCEPTION and is pinned as one: it has no accessor and no default,
// because unset means UNDECIDED and defaulting it to `false` would look settled. `bsc publish`
// refuses only on an explicit `false`. A port that gave it a default would silently decide something
// nobody answered.
//
// ## Why every token, not a sample
//
// `appTypeHasUi` branches on a private `UI_BEARING` subset (application · desktop · mobile · static)
// and `classifySignals` emits one boolean PER token across four axes. A sampled corpus would leave
// most of both unexercised, so the generator walks the full taxonomy — which is safe to do now that
// `classifyTaxonomy.fixtures.json` proves the two copies of that taxonomy agree.
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  APP_TYPES, LIFECYCLES, SYSTEM_SOURCES,
  appTypeOf, lifecycleOf, uiSystemOf, algorithmSystemOf,
  rendersFromStudio, computesFromStudio, hostRunsProjectArtifacts, appTypeHasUi, classifySignals,
  type ClassifyConfig,
} from "@/features/planner/lib/classifyConfig";

const FIXTURE = join(process.cwd(), "src/features/planner/lib/classifyPredicates.fixtures.json");

/** How the input is carried, so `null` and `undefined` stay distinguishable in JSON. */
type Input = { kind: "null" } | { kind: "undefined" } | { kind: "config"; value: ClassifyConfig };

const CASES: { name: string; input: Input }[] = [
  // ── nothing at all: the two ways of saying it must agree ────────────────────────────────────
  { name: "no config — null", input: { kind: "null" } },
  { name: "no config — undefined", input: { kind: "undefined" } },
  { name: "an EMPTY config is not the same input as no config, but must read the same", input: { kind: "config", value: {} } },

  // ── every appType, because appTypeHasUi branches on a subset of them ────────────────────────
  ...APP_TYPES.map((t) => ({ name: `appType=${t}`, input: { kind: "config", value: { appType: t } } as Input })),

  // ── every lifecycle, because classifySignals emits one boolean per token ────────────────────
  ...LIFECYCLES.map((l) => ({ name: `lifecycle=${l}`, input: { kind: "config", value: { lifecycle: l } } as Input })),

  // ── the FOUR system combinations. hostRunsProjectArtifacts is an OR, and own/own is the only
  //    input that makes it false — a port reading only uiSystem answers it wrongly for studio
  //    algorithms under an own UI, which is the more dangerous half since it RUNS code.
  ...SYSTEM_SOURCES.flatMap((ui) =>
    SYSTEM_SOURCES.map((algo) => ({
      name: `uiSystem=${ui} algorithmSystem=${algo}`,
      input: { kind: "config", value: { uiSystem: ui, algorithmSystem: algo } } as Input,
    })),
  ),

  // ── a fully-populated config, and one where every needs* flag is set, so the signal bag is
  //    exercised with real neighbours rather than in isolation.
  {
    name: "a fully classified project",
    input: {
      kind: "config",
      value: {
        uiMode: "custom", appType: "mobile", lifecycle: "harden",
        uiSystem: "own", algorithmSystem: "studio", usesGithub: true,
        needsMarket: true, needsSource: false, needsMcp: true, needsSkills: false, needsAutomations: true,
      },
    },
  },
  {
    name: "usesGithub explicitly FALSE — the one axis with no default",
    input: { kind: "config", value: { usesGithub: false } },
  },
  {
    name: "usesGithub UNSET — undecided, and must not read as false anywhere",
    input: { kind: "config", value: { appType: "api" } },
  },
];

const resolve = (i: Input): ClassifyConfig | null | undefined =>
  i.kind === "null" ? null : i.kind === "undefined" ? undefined : i.value;

function build() {
  return {
    note: "GENERATED from the live TypeScript — see classifyPredicates.fixtures.gen.test.ts",
    uiBearing: APP_TYPES.filter((t) => appTypeHasUi({ appType: t })),
    cases: CASES.map(({ name, input }) => {
      const cfg = resolve(input);
      return {
        name,
        input,
        appType: appTypeOf(cfg),
        lifecycle: lifecycleOf(cfg),
        uiSystem: uiSystemOf(cfg),
        algorithmSystem: algorithmSystemOf(cfg),
        rendersFromStudio: rendersFromStudio(cfg),
        computesFromStudio: computesFromStudio(cfg),
        hostRunsProjectArtifacts: hostRunsProjectArtifacts(cfg),
        appTypeHasUi: appTypeHasUi(cfg),
        signals: classifySignals(cfg),
        // Carried so the port cannot quietly invent a default for the one axis that has none.
        usesGithub: cfg?.usesGithub ?? null,
      };
    }),
  };
}

describe("the classification's derived predicates are captured for Rust to match", () => {
  it("matches the committed fixture (UPDATE_FIXTURES=1 to regenerate)", () => {
    const built = build();
    const text = JSON.stringify(built, null, 2) + "\n";
    if (process.env.UPDATE_FIXTURES === "1") writeFileSync(FIXTURE, text);
    expect(existsSync(FIXTURE), `${FIXTURE} is missing — run with UPDATE_FIXTURES=1`).toBe(true);
    expect(readFileSync(FIXTURE, "utf8")).toBe(text);
  });

  it("walks the WHOLE taxonomy, not a sample", () => {
    const built = build();
    const seen = new Set(built.cases.map((c) => c.appType));
    expect(seen.size, "every appType must appear").toBe(APP_TYPES.length);
    const lifes = new Set(built.cases.map((c) => c.lifecycle));
    expect(lifes.size, "every lifecycle must appear").toBe(LIFECYCLES.length);
  });

  /** null and undefined are two ways of saying nothing and must be indistinguishable. */
  it("reads null, undefined and an empty config identically", () => {
    const built = build();
    const [a, b, c] = built.cases;
    const strip = (x: (typeof built.cases)[number]) => ({ ...x, name: "", input: null });
    expect(strip(b)).toEqual(strip(a));
    expect(strip(c)).toEqual(strip(a));
  });

  /** The OR must be reachable in every combination, or a port reading one axis passes. */
  it("exercises all four system combinations, including the only false one", () => {
    const built = build();
    const combos = built.cases.filter((c) => c.name.startsWith("uiSystem="));
    expect(combos).toHaveLength(4);
    expect(combos.filter((c) => !c.hostRunsProjectArtifacts).map((c) => c.name)).toEqual([
      "uiSystem=own algorithmSystem=own",
    ]);
  });

  /** usesGithub has no default anywhere — absent must stay absent. */
  it("never defaults usesGithub", () => {
    const built = build();
    const unset = built.cases.find((c) => c.name.startsWith("usesGithub UNSET"))!;
    expect(unset.usesGithub).toBeNull();
    const no = built.cases.find((c) => c.name.startsWith("usesGithub explicitly FALSE"))!;
    expect(no.usesGithub).toBe(false);
    for (const c of built.cases) expect(c.signals).not.toHaveProperty("usesGithub");
  });
});
