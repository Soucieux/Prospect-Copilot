# Selling-context auto-detect — implementation plan

**Design (approved):** Replace the Settings-field approach to "what do you sell"
with automatic detection. The router already makes one LLM call per message to
classify intent; extend it to also scan the full conversation (current message
+ history) for a stated product/ICP. If found, use it silently. If never
mentioned, don't block the pipeline - run the analysis as today (neutral
Competitive Position) and have the assistant append one short, friendly
question asking what the user sells, so the next message in the same
conversation can pick it up via history. No Settings field, no new SSE
protocol, no blocking.

## Task 1 - Extend the router to extract sellingContext

- Add `sellingContext: z.string().nullable()` to `ROUTER_RESULT_SCHEMA` in
  `src/lib/agent/schemas.ts`.
- Update `ROUTER_SYSTEM_PROMPT` in `src/lib/agent/router.ts` to also extract
  a stated product/ICP from anywhere in the conversation, defaulting to null.
- Change `routeMessage(config, message, searchConfig)` to
  `routeMessage(config, message, history, searchConfig)`, passing `history`
  into the LLM call before the final user message (same pattern already used
  by `streamPlainChat` in `route.ts`).
- **Test first:** add `src/lib/agent/router.test.ts` stubbing `global.fetch`
  (same pattern as `volc-search.test.ts`) covering: (a) sellingContext
  extracted from the current message, (b) sellingContext extracted from an
  earlier history turn, (c) sellingContext null when never mentioned, (d)
  existing skill/url/entity extraction still works unchanged.
- Write the test, watch it fail (function doesn't accept `history` yet /
  schema doesn't have the field yet), implement, watch it pass, commit.

## Task 2 - Wire the router's output through route.ts

- Update the `routeMessage` call site in `src/app/api/chat/route.ts` to pass
  `history`.
- Replace the header-based `readSellingContext`/`SELLING_CONTEXT_HEADER`
  path: pass `routing.sellingContext` to `runProspectPipeline` and
  `runStandaloneSkill` instead.
- Remove `readSellingContext` and the `SELLING_CONTEXT_HEADER` import from
  `route.ts`.
- Verify: `npx tsc --noEmit`, existing tests still pass.

## Task 3 - Remove the Settings field and header

- `src/lib/constants.ts`: remove `SELLING_CONTEXT_HEADER` and
  `MAX_SELLING_CONTEXT_LENGTH`.
- `src/app/page.tsx`: remove `sellingContext` from the `Settings` interface
  and `DEFAULT_SETTINGS`, remove the header-send block in `send()`, remove
  the "What do you sell?" modal field.
- Verify: `npx tsc --noEmit`, production build.

## Task 4 - Add the friendly nudge when selling context is unknown

- `src/lib/agent/orchestrator.ts` (`runSynthesis`): when `sellingContext` is
  null, instruct the synthesis system prompt to append one short closing
  question asking what the user sells (already receives `sellingContext`
  from earlier work - just add the nudge instruction).
- `src/lib/skills/standalone.ts`: same nudge instruction added to the
  `research`/`qualify` system prompts for when `sellingContext` is null.
- No new tests needed here (prompt text only, not independently testable
  logic) - covered by Task 5's manual verification.

## Task 5 - Full verification

- `npx tsc --noEmit`, `npx vitest run` (all files including the new
  `router.test.ts`), `npx next build`.
- Manual smoke test in the browser: confirm the Settings modal no longer
  shows the field, confirm a chat message still routes correctly.
- Commit.
