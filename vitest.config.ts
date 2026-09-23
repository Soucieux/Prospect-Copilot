import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      // lcov also writes coverage/lcov-report/index.html, so one reporter
      // serves both a CI gate and a browsable per-line report.
      reporter: ["text-summary", "text", "lcov"],
      include: ["src/**/*.ts", "src/**/*.tsx"],
      // Excluded because they hold no branching logic to cover: type and
      // constant declarations, the root layout shell, and the React page,
      // whose behaviour is exercised end to end rather than by unit tests.
      exclude: [
        "src/**/*.test.ts",
        "src/lib/chat-types.ts",
        "src/lib/constants.ts",
        "src/lib/workflow/constants.ts",
        "src/lib/workflow/context.ts",
        "src/app/layout.tsx",
        "src/app/page.tsx",
      ],
      // A regression ratchet, not a quality target. No percentage decides
      // whether this project is tested: AGENTS.md asks for testable success
      // criteria per behaviour - invalid-input checks for validation, a
      // reproducing regression for a fix, preserved behaviour for a refactor.
      // These floors only stop coverage silently sliding below where it
      // already is, so an untested addition fails the run instead of landing
      // unnoticed. Raise them when the measured numbers rise; never treat
      // reaching one as evidence that a behaviour is covered.
      // Vitest 4 reads branches from the syntax tree, so every `??`, `&&`,
      // `?.`, implicit `else` and default value counts - including those in
      // functions no unit test runs, such as the workflow node bodies. The
      // floors were re-measured on that basis when Vitest 4 arrived.
      // Guards that `noUncheckedIndexedAccess` requires on index reads are
      // unreachable by construction - a loop condition or a length check has
      // already proven the element exists - yet still count toward the
      // denominator, so they cap the branch ratio.
      thresholds: {
        statements: 82,
        branches: 82,
        functions: 78,
        lines: 82,
        "src/lib/*.ts": {
          statements: 94,
          branches: 80,
          functions: 98,
          lines: 95,
        },
        "src/lib/extract/**": {
          statements: 90,
          branches: 85,
          functions: 95,
          lines: 90,
        },
        "src/lib/scoring/**": {
          statements: 95,
          branches: 95,
          functions: 95,
          lines: 95,
        },
        "src/lib/skills/**": {
          statements: 95,
          branches: 88,
          functions: 95,
          lines: 95,
        },
        // Statements stay unpinned here on purpose: the subgraph node bodies
        // are calls into the graph runtime and the model. Vitest 4 also counts
        // the branches inside those bodies, which is why this floor sits at 52;
        // every branch in code the unit tests run is taken, and that is what a
        // routing bug would break.
        "src/lib/workflow/**": {
          branches: 52,
        },
        "src/app/api/**": {
          statements: 95,
          branches: 85,
          functions: 100,
          lines: 95,
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
