// Root flat ESLint config (Phase 3): TypeScript recommended rules, React
// recommended + react-hooks, prettier interop last. Each package's `lint`
// script runs `eslint .` from its directory; prettier stays available as
// the separate `format` script.
import tsPlugin from "@typescript-eslint/eslint-plugin";
import reactPlugin from "eslint-plugin-react";
import hooksPlugin from "eslint-plugin-react-hooks";
import prettierOff from "eslint-config-prettier";

const hooksRecommended = hooksPlugin.configs.flat.recommended;

export default [
  {
    ignores: ["**/dist/**", "apps/api/.wrangler/**"],
  },
  ...tsPlugin.configs["flat/recommended"],
  reactPlugin.configs.flat.recommended,
  ...(Array.isArray(hooksRecommended) ? hooksRecommended : [hooksRecommended]),
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    settings: {
      // Pinned (not "detect"): version detection calls a context API
      // that no longer exists on ESLint 10 and crashes every file.
      react: { version: "19.3" },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      // Test doubles and provider adapters name unused params with a
      // leading underscore; that convention stays legal.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "react-hooks/exhaustive-deps": "error",
      // TypeScript covers prop types; the automatic JSX runtime needs no
      // React import in scope.
      "react/prop-types": "off",
      "react/react-in-jsx-scope": "off",
    },
  },
  prettierOff,
];
