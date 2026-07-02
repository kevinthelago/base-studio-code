import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

export default tseslint.config(
  { ignores: ["dist", "target", "design", "node_modules", "relay"] },
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
  }
);
