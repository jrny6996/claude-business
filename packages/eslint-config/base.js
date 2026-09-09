import babelParser from "@babel/eslint-parser";
import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import turboPlugin from "eslint-plugin-turbo";
import onlyWarn from "eslint-plugin-only-warn";
import globals from "globals";

/**
 * A shared ESLint configuration for the repository.
 *
 * @type {import("eslint").Linter.Config[]}
 * */
export const config = [
  js.configs.recommended,
  eslintConfigPrettier,
  {
    // Flat config only matches `**/*.js` by default, which would leave every
    // TypeScript source in this repo unlinted.
    files: ["**/*.js", "**/*.mjs", "**/*.cjs", "**/*.ts", "**/*.tsx", "**/*.mts"],
    languageOptions: {
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: {
          presets: ["@babel/preset-typescript"],
        },
      },
    },
    plugins: {
      turbo: turboPlugin,
    },
    rules: {
      "turbo/no-undeclared-env-vars": "warn",
    },
  },
  {
    // Everything in this repo runs on Node (Electron main, build scripts,
    // Astro's build step), so Node globals are always in scope.
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    plugins: {
      onlyWarn,
    },
  },
  {
    // .tsx needs the JSX grammar on top of the TypeScript preset; Babel 8's
    // preset-typescript infers TS-vs-TSX from the extension but does not
    // enable JSX parsing on its own.
    files: ["**/*.tsx", "**/*.jsx"],
    languageOptions: {
      parserOptions: {
        babelOptions: {
          plugins: ["@babel/plugin-syntax-jsx"],
        },
      },
    },
  },
  {
    // TypeScript resolves identifiers itself, and does it correctly for types,
    // ambient declarations and JSX. Leaving `no-undef` on for .ts/.tsx only
    // produces false positives.
    files: ["**/*.ts", "**/*.tsx", "**/*.mts"],
    rules: {
      "no-undef": "off",
      // Both of these are unreliable here: the Babel parser strips type
      // annotations before ESLint sees them, so a type-only import reads as
      // unused. TypeScript checks the same things correctly via
      // `noUnusedLocals` / `noUnusedParameters` in the shared tsconfig.
      "no-unused-vars": "off",
    },
  },
  {
    ignores: ["dist/**", "dist-electron/**", ".astro/**"],
  },
];
