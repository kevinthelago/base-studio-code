import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import jsxA11y from "eslint-plugin-jsx-a11y";

// #1545 feature-boundary: a feature is a black box behind its `index.ts` barrel. A feature (and the
// app shell) may import another feature's PUBLIC API (`@/features/<x>`) but NOT its internals
// (`@/features/<x>/<anything deeper>`: lib/*, components, subdirs). `import type` stays allowed (erased
// at build; a type-only coupling doesn't wire runtime). Own-feature modules DO use the
// `@/features/<self>/...` alias (the repo's alias-over-`../../` convention), so this is enforced
// PER-FEATURE: each feature forbids only the OTHER features' internals. Tests are exempt. `designs/**`
// and `glance/**` are exempt AS IMPORTERS while a parallel session restructures them
// (#2197/#2214/#2372) — remove them from EXEMPT_IMPORTERS to fold them in once that lands.
const FEATURES = ["algorithms", "security", "automations", "designs", "github", "glance", "mcp", "sounds", "teams", "personas", "planner", "settings", "skills", "studio", "studio-sessions", "tunnel"];
const EXEMPT_IMPORTERS = ["designs", "glance"];
const BOUNDARY_MSG =
  "Import another feature through its barrel (@/features/<x>), not its internals (#1545): a feature's " +
  "public API is its index.ts; deeper paths (lib/*, components, subdirs) are private. `import type` is allowed.";
const featureBoundaryRules = FEATURES
  .filter((f) => !EXEMPT_IMPORTERS.includes(f))
  .map((f) => ({
    files: [`src/features/${f}/**/*.{ts,tsx}`],
    ignores: [`src/features/${f}/**/*.test.{ts,tsx}`, `src/features/${f}/**/*.spec.{ts,tsx}`],
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", {
        patterns: [{
          group: FEATURES.filter((o) => o !== f).flatMap((o) => [`@/features/${o}/*`, `@/features/${o}/**`]),
          allowTypeImports: true,
          message: BOUNDARY_MSG,
        }],
      }],
    },
  }));
// The app shell has no own-feature — it may use any feature's barrel but never its internals.
const appBoundaryRule = {
  files: ["src/app/**/*.{ts,tsx}"],
  ignores: ["src/app/**/*.test.{ts,tsx}", "src/app/**/*.spec.{ts,tsx}"],
  rules: {
    "@typescript-eslint/no-restricted-imports": ["error", {
      patterns: [{ group: ["@/features/*/*", "@/features/*/**"], allowTypeImports: true, message: BOUNDARY_MSG }],
    }],
  },
};

export default tseslint.config(
  {
    // #3392: coverage is DECLARATIVE — the CLI arg is `.` (see package.json `lint`), so what is and
    // isn't linted lives here, not in an argument that silently under-covers a new top-level dir.
    // That makes these ignores load-bearing:
    //   - `**/wt*/**` + `**/.claude/worktrees/**` — nested git worktrees (the #3379 leak). Lint used
    //     to avoid them only because the CLI arg was `src`; with `.` they MUST be ignored here or
    //     every sibling worktree gets walked (8 on a typical dev box) and the run explodes.
    //   - `crates/**/tests/fixtures/**` — Rust-owned test DATA, not app code. Its shape (e.g. the
    //     deliberately-unreferenced fns in bsc-graph's sample.ts) is the fixture's whole point.
    ignores: [
      "dist",
      "target",
      "design",
      "node_modules",
      "relay",
      "**/wt*/**",
      "**/.claude/worktrees/**",
      "crates/**/tests/fixtures/**",
    ],
  },
  {
    // Plain JS/ESM — the build + release tooling under `scripts/` (#3392). These ran completely
    // unlinted before: the CLI arg was `src`, and even once walked they matched no config block
    // (which is `**/*.{ts,tsx}`), so they were checked with ZERO rules — a vacuous pass. They are
    // Node scripts, so declare the Node globals they use; `globals` isn't a dependency of this repo,
    // so the handful in play are listed explicitly rather than pulling in a package for it.
    extends: [js.configs.recommended],
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      // setLoading(true) before async calls is intentional — downgrade to warn
      "react-hooks/set-state-in-effect": "warn",
      // Date.now() / new Date() in render is acceptable for snapshot comparisons
      "react-hooks/purity": "warn",
      // ref.current reads in render back "ever-shown"/latest-value flags (intentional)
      "react-hooks/refs": "warn",
      // Components with the intentional ref-in-render pattern above can't be compiled,
      // so the compiler can't "preserve" their manual useMemo — but those memos are
      // correct + doing real work (the compiler isn't enabled at build). Warn, not error.
      "react-hooks/preserve-manual-memoization": "warn",
    },
  },
  {
    // Accessibility guardrail (#3773) — jsx-a11y on JSX. Because the no-raw-<div>/<button>/<input>
    // discipline routes interactive elements through UI-kit primitives (custom components jsx-a11y can't
    // inspect), the real coverage is the shared/ui primitives that render DOM elements — exactly where the
    // accessible name/role/keyboard contract belongs. Tests are exempt.
    files: ["src/**/*.tsx"],
    ignores: ["src/**/*.test.tsx", "src/**/*.spec.tsx"],
    plugins: { "jsx-a11y": jsxA11y },
    rules: {
      ...jsxA11y.flatConfigs.recommended.rules,
      // Ratchet (#3773/#3775): the backlog is being cleared rule-by-rule. Re-erroring first the two
      // MECHANICAL rules — `no-autofocus` (10 sites: dialog/inline-edit focus-on-open, the WAI-ARIA
      // dialog pattern, each carrying an inline `-- intentional` disable) and `label-has-associated-control`
      // (6 sites: 5 are `<label>` wrapping a custom `Checkbox`/`Toggle`, recognized via `controlComponents`;
      // the 6th was a group caption, fixed). The remaining THREE stay `warn` (#3775 follow-up) because
      // clearing them is a per-site role + keyboard-handler + runtime-focus sweep, not a mechanical pass —
      // every OTHER jsx-a11y rule stays at its recommended `error`, so a NEW a11y mistake fails the gate.
      "jsx-a11y/click-events-have-key-events": "warn",
      "jsx-a11y/no-static-element-interactions": "warn",
      "jsx-a11y/interactive-supports-focus": "warn",
      "jsx-a11y/no-autofocus": "error",
      "jsx-a11y/label-has-associated-control": ["error", { controlComponents: ["Checkbox", "Toggle"] }],
    },
  },
  {
    // No-raw-div discipline (#2079): the UI kit owns every element. In features + the app shell,
    // reach for a primitive — `Box` (generic container, `@/shared/ui/layout/Box`), `Text`
    // (`@/shared/ui/typography/Text`), or the layout primitives `Stack`/`Row`/`Spacer`/`Grid` —
    // never a raw `<div>`/`<span>`. The primitives themselves (`src/shared/ui/**`) render the real
    // elements and are outside this scope. Genuinely-unavoidable raw elements (a DOM `ref` — the
    // primitives aren't forwardRef; a portal/measured mount; the crash ErrorBoundary; an isolated
    // preview surface) carry an inline `// eslint-disable-next-line no-restricted-syntax -- <reason>`.
    files: ["src/features/**/*.tsx", "src/app/**/*.tsx"],
    ignores: ["src/features/**/*.test.tsx", "src/app/**/*.test.tsx"],
    rules: {
      "no-restricted-syntax": ["error",
        {
          selector: "JSXOpeningElement[name.name='div']",
          message: "Use a UI-kit primitive instead of a raw <div> — <Box> (generic container), or <Stack>/<Row>/<Grid> for layout. See src/shared/ui. If truly required (DOM ref, portal/measured mount, crash boundary, isolated preview), add `// eslint-disable-next-line no-restricted-syntax -- <reason>`.",
        },
        {
          selector: "JSXOpeningElement[name.name='span']",
          message: "Use a UI-kit primitive instead of a raw <span> — <Text> for text, or <Box as=\"span\"> for an inline container. See src/shared/ui. If truly required, add `// eslint-disable-next-line no-restricted-syntax -- <reason>`.",
        },
        {
          selector: "JSXOpeningElement[name.name='button']",
          message: "Use a UI-kit primitive instead of a raw <button> — <Button> (variant/size/danger), <IconButton> for icon-glyph actions, or <SegmentedControl> for a toggle group. See src/shared/ui/controls. If truly required, add `// eslint-disable-next-line no-restricted-syntax -- <reason>`.",
        },
        {
          selector: "JSXOpeningElement[name.name='input']",
          message: "Use a UI-kit primitive instead of a raw <input> — <TextField> (labelled) or wrap the control with <Field>; <Checkbox>/<Toggle> for booleans. See src/shared/ui/controls. If truly required, add `// eslint-disable-next-line no-restricted-syntax -- <reason>`.",
        },
        {
          selector: "JSXOpeningElement[name.name='select']",
          message: "Use a UI-kit primitive instead of a raw <select> — <SelectField>. See src/shared/ui/controls. If truly required, add `// eslint-disable-next-line no-restricted-syntax -- <reason>`.",
        },
        {
          selector: "JSXOpeningElement[name.name='textarea']",
          message: "Use a UI-kit primitive instead of a raw <textarea>. See src/shared/ui/controls. If truly required, add `// eslint-disable-next-line no-restricted-syntax -- <reason>`.",
        },
      ],
    },
  },
  {
    // Architecture boundary (#1626 / #1703): `shared/` is feature- AND app-agnostic — features and
    // the app shell import from shared, never the reverse. Forbid VALUE imports from `@/features/*`
    // and `@/app/*` (and their relative `**/features/*` / `**/app/*` forms) in shared runtime
    // modules. `import type` stays allowed (a type dependency is erased at build and doesn't couple
    // shared to feature/app runtime). Test files are exempt — they legitimately render/exercise
    // feature/app code. The single deliberate exception (conformance.ts) carries an inline
    // eslint-disable with its rationale.
    files: ["src/shared/**/*.{ts,tsx}"],
    ignores: ["src/shared/**/*.test.{ts,tsx}", "src/shared/**/*.spec.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", {
        patterns: [{
          group: [
            "@/features/*", "@/features/**", "**/features/*", "**/features/**",
            "@/app/*", "@/app/**", "**/app/*", "**/app/**",
          ],
          allowTypeImports: true,
          message:
            "shared/ must stay feature- and app-agnostic (#1626/#1703): do not import VALUE symbols " +
            "from features or app/. `import type` is allowed; otherwise move the module into its " +
            "owning feature or app/, or invert the dependency (pass it in as a parameter).",
        }],
      }],
    },
  },
  // #1545 feature-boundary enforcement — per-feature (own internals allowed, others' forbidden) + the app shell.
  ...featureBoundaryRules,
  appBoundaryRule,
);
