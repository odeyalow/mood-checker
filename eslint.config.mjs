import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    ".venv/**",
    ".venv-worker/**",
    // Stale nested copy of the whole project (own .git/.next). Not part of
    // the build — tsconfig excludes it too. Without this, eslint lints its
    // bundled vendor chunks: ~11.5k extra problems.
    "src/components/mood-checker/**",
  ]),
]);

export default eslintConfig;
