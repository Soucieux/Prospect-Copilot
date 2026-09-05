# Product → Candidate Matching (`match` skill)

## Design summary

The app currently only works one direction: name a company, get an assessment of
its fit for what you sell. This feature adds the mirror direction: describe what
you sell, get a ranked list of candidate companies that fit it.

Routing is decided purely by how many companies are named in the message,
independent of whether a product is described:

| Companies named | No product | Product given |
|---|---|---|
| 0 | Plain chat (unchanged) | **New:** `match`, discovery mode — web search for candidates, quick-score, rank top 5 |
| 1 | Existing single-company skills (unchanged) | Existing `prospect` pipeline, already grounds scoring in the product (unchanged) |
| 2+ | **New:** `match` on the named list — neutral/generic fit fallback per candidate (same fallback pattern the single-company skills already use without `sellingContext`) | **New:** `match` on the named list, scored against the product |

The 1-company row is not a new rule — it's the router's existing intent-based
classification (`analyze`, `audit`, `find contacts at`, etc.), untouched. Only
the 0-or-2+ path is new.

`match` deliberately does **not** run the existing 5-subagent + BANT + contacts
+ outreach pipeline per candidate — that was explicitly ruled out (too slow/
costly across multiple candidates). It runs one lightweight LLM scoring call
per candidate instead. Asking about any one *named* result afterward routes
through the existing `prospect` pipeline unchanged, for a full deep-dive.

## Tasks

Each task: write test (RED) → implement (GREEN) → commit. TDD mandatory.

### Task 1 — Schema additions
- `schemas.ts`: add `"match"` to `ROUTER_RESULT_SCHEMA.skill` enum; add
  `candidates: z.array(z.string()).nullable()`. Add `"match"` to
  `CHAT_EVENT_SCHEMA`'s `report.kind` enum.
- Test: schema parses a valid match routing payload (`skill: "match"`,
  `candidates: ["Acme", "https://foo.com"]`); schema parses a report event with
  `kind: "match"`.

### Task 2 — Router: classify `match` by company count
- `router.ts`: extend `ROUTER_SYSTEM_PROMPT` with the `match` skill description
  and the count-based disambiguation rule (0 or 2+ companies named → match;
  exactly 1 → existing skills, unchanged). Extract named companies into
  `candidates` (names or URLs, verbatim) when 2+; leave `candidates: null` for
  the 0-company case.
- Export `resolveEntityUrl` (rename to `resolveCompanyUrl` for clarity since
  it's now used outside single-entity resolution) and the company-domain
  filter predicate (extract into `isLikelyCompanyUrl`) for reuse in Task 4.
- Tests (extend `router.test.ts`): product + no company → `skill: "match"`,
  `candidates: null`; product + 2 named companies → `skill: "match"`,
  `candidates` populated; one company + audit intent → still routes to
  `prospect` (regression guard against the new rule swallowing the 1-company
  case); no product + 2+ companies asking to compare → `skill: "match"`,
  `sellingContext: null`.

### Task 3 — Pure helpers in `match.ts`
- New file `src/lib/skills/match.ts`. Pure, network-free functions first:
  - `buildDiscoveryQuery(sellingContext: string): string`
  - `rankCandidates(scored: CandidateScore[], limit: number): CandidateScore[]`
    — sort desc by score, slice to `limit`.
  - `renderMatchReport(sellingContext: string | null, ranked: CandidateScore[], totalConsidered: number): { markdown: string; title: string }`
    — ranked list with name/URL/score/one-line reason, a closing hint to ask
    about one by name for a full audit, and an explicit note when candidates
    were dropped/truncated (no silent caps).
- Tests: each function in isolation with fixed inputs — query text shape,
  ranking order/truncation, markdown structure (including the truncation note
  and the empty-results case).

### Task 4 — Candidate resolution + quick scoring
- In `match.ts`: `resolveCandidates(searchConfig, candidates, sellingContext)`
  — for supplied candidates, resolve names to URLs via `resolveCompanyUrl`
  (URLs used as-is); for discovery mode, one `searchWeb` call via
  `buildDiscoveryQuery`, filtered with `isLikelyCompanyUrl`, deduped by host.
  Cap the resulting pool at `MAX_CANDIDATES_TO_SCORE` (8).
- `quickScoreCandidate(config, sellingContext, url)` — fetch homepage
  (`fetchWithVariants`), `analyzeProspect`, one `chatCompletion` call reusing
  `SUBAGENT_RESULT_SCHEMA`'s contract (export `OUTPUT_CONTRACT` and
  `NEVER_FABRICATE_RULES` from `subagents.ts` for reuse) with a neutral-fit
  prompt when `sellingContext` is null. Returns `null` on any failure (fetch,
  parse) rather than throwing, consistent with `Promise.allSettled` usage
  elsewhere in the codebase.
- Tests (stubbed `fetch`, mirroring `router.test.ts`'s pattern): supplied URL
  candidates score directly; supplied names resolve via search first; one
  failing candidate doesn't drop the others; discovery mode builds candidates
  from search results and filters out non-company domains.

### Task 5 — `runMatchSkill` orchestration
- `match.ts`: `runMatchSkill(config, sellingContext, candidates, emit, searchConfig)`
  — resolve candidates (Task 4), run `quickScoreCandidate` over the pool in
  parallel, rank (Task 3), render (Task 3), emit `phase`/`agent`-style progress
  events matching the existing wire vocabulary. Throws a plain `Error` only
  for genuinely unexpected failures (matches existing `route.ts` catch-all);
  the "no usable candidates found" case is a rendered report, not a thrown
  error.
- Test: end-to-end with stubbed `fetch` covering the full supplied-list path
  and the full discovery path, asserting the final markdown and event stream
  shape.

### Task 6 — Wire into `route.ts`
- Add a `match` branch:
  - `sellingContext` missing **and** `candidates` empty/null → emit a single
    `token` nudge asking what they sell (no pipeline run) — same pattern as
    the existing sellingContext-missing nudges, not an `error` event.
  - `candidates` empty **and** no `searchConfig` → emit a `token` message
    pointing at Settings for a search API key (no pipeline run).
  - Otherwise → call `runMatchSkill`, stream its events, emit the final
    `report` event with `kind: "match"`.
- No frontend changes needed: `page.tsx`'s `Scorecard`/`ReportActions`
  already render generically off `kind`/`companyName`/`markdown` when
  `score`/`categories` are null (verified against the current file).

### Task 7 — Documentation
- Update `Prospect Copilot/README.md`: add a "Finding prospects for a product"
  usage section (how to trigger discovery mode vs. supplying your own
  candidate list, what the output looks like, that a search API key is needed
  for discovery), including a version of the routing table above adapted for
  end users (not the internal skill names).
- Add a changelog bullet to the top-level `README.md`'s Prospect Copilot row
  once the feature lands (per the standing README-on-push rule).

### Task 8 — Full verification
- `tsc --noEmit`, `vitest run` (all tests), `next build`, then a browser smoke
  test: a discovery-mode message and a supplied-list message, confirming the
  UI renders a `match` report without crashing (score/categories absent,
  falls back to the generic "match report" label as designed).

## Execution mode

Two options once this plan is saved:
- **Subagent-driven**: dispatch an implementer subagent per task, with a
  spec-reviewer and code-quality reviewer pass after each.
- **Direct execution**: I implement task-by-task in this session, same TDD
  discipline, no subagent dispatch overhead.
