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
  }
);
