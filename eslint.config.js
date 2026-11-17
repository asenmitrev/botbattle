// Lint rules aimed at what silently breaks this codebase: non-determinism in the engine, the engine depending
// on the apps around it, and dead code left behind by edits.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/dist/**", "data/**", "data-backup-*/**", "replays/**", "botbattle/**", "sandbox/test/fixtures/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      eqeqeq: ["error", "always"],
      "prefer-const": "error",
    },
  },
  {
    // Type-aware rules need a tsconfig, which covers each package's src/ and scripts/.
    files: ["*/src/**/*.ts", "scripts/**/*.ts"],
    ignores: ["**/*.d.ts"],
    languageOptions: { parserOptions: { projectService: true } },
    rules: {
      // Adding a union member (an action, event or unit type) must fail where it isn't handled.
      "@typescript-eslint/switch-exhaustiveness-check": ["error", { considerDefaultExhaustiveForUnions: true }],
    },
  },
  {
    // Test files and declaration files may be looser.
    files: ["**/test/**/*.ts", "**/*.d.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  {
    // The engine is pure and deterministic: same seed + same actions = same match, byte for byte.
    files: ["engine/src/**/*.ts"],
    rules: {
      "no-restricted-globals": ["error", { name: "Date", message: "The engine must be deterministic: no clocks." }, "performance", "process", "setTimeout", "setInterval"],
      "no-restricted-properties": ["error", { object: "Math", property: "random", message: "Use the seeded Rng (engine/src/rng.ts)." }],
      "no-restricted-imports": [
        "error",
        { patterns: [{ group: ["node:*", "@arena/*", "../../*"], message: "The engine depends on nothing outside engine/src." }] },
      ],
    },
  },
);
