# Prospect Copilot

<a id="repository-description-archive"></a>

<a id="repository-register-detail"></a>

<!-- project-control:section=overview -->
## Overview

Prospect Copilot is a multilingual chat app for sales research and product sourcing.

- **Prospects:** Research companies, qualify opportunities, find decision makers, and draft outreach.
- **Products:** Find and rank likely buyers or sellers.
- **Results:** Read evidence-backed reports and retained conversation cards; stop an active request when needed.
- **Models:** Use your key with an approved OpenAI-compatible endpoint. The default is DeepSeek at `https://api.deepseek.com`, model `deepseek-chat`.

- **Origin:** A standalone TypeScript rewrite of [`zubair-trabzada/ai-sales-team-claude`](https://github.com/zubair-trabzada/ai-sales-team-claude). [Architecture](#architecture) explains Next.js, LangGraph, and LangChain.

## Setup

Run these commands from `Prospect Copilot/`. Requires Node.js 20 or newer.

```bash
npm install
npm run dev        # http://localhost:3000
```

Open the page, paste your DeepSeek API key into the settings bar (base URL and model are pre-filled), and try:

```
analyze https://stripe.com as a prospect
we sell payroll software, analyze https://stripe.com as a prospect
research https://www.acme.com
find decision makers at https://example.com
draft an outreach sequence for Acme Analytics
we sell payroll software for mid-market companies, who should we target?
where can I buy wool blankets?
```

The server accepts the default DeepSeek base URL automatically. To use a different OpenAI-compatible provider, approve its exact base URL in the server environment before starting the app:

```bash
LLM_ALLOWED_BASE_URLS="https://api.openai.com/v1,http://127.0.0.1:11434/v1" npm run dev
```

- The browser cannot select an arbitrary provider that the server has not approved.
- This prevents the chat endpoint from being used to contact internal services while still allowing an administrator to opt in a local provider.

<a id="core-capabilities"></a>

<a id="prospect-copilot-2"></a>

<!-- project-control:section=workflows -->
## How it works

1. Type a message in the chat page. A stateless LangGraph request workflow asks the intent router to
   classify it against six skills: **prospect** (full audit), **research**, **qualify**,
   **contacts**, **outreach**, **match** (rank candidate prospects for a product) - or plain chat.
2. **Prospect** runs the full pipeline: page discovery (homepage + up to 6 subpages) -> deterministic extraction (tech stack, funding/jobs signals, and team-page contacts read from page text rather than links alone, with people employed elsewhere excluded) -> **5 parallel subagent analyses** -> a weighted composite of the five subagent scores (0-100, grade A+ to D), with deterministic BANT and MEDDIC reported alongside it as separate diagnostics -> LLM synthesis with an executive summary, action plan, and first-touch email.
3. Standalone skills (**research / qualify / contacts / outreach**) run light discovery when a URL
   is given, then stream their markdown deliverable.
4. **Match** uses one ranked-candidate pipeline for both directions: it can find likely buyers for
   something you want to sell or places that sell something you want to buy. Candidate URL
   resolution and scoring use separate bounded worker pools with at most four active jobs - see
   "Finding buyers or sellers for a product" below.
5. Every report renders as structured in-app content; match results use selectable cards with full
   company names, clickable company websites, and a separate full-review action.
6. Conversations and their report cards persist in your browser's IndexedDB, including after
   switching conversations or refreshing the page, and any active request can be stopped from the
   chat controls.
7. Every reply - plain chat, processing logs, full audits, standalone skills, and match cards alike -
   is written in whatever language you write in, not English by default.

Bring your own key: the API key is stored in `localStorage` in *your* browser only and sent per-request as a header. It is never written to disk server-side and never logged.

### Scoring model

- Signals a page extractor cannot read - customer pain points, open roles, recent funding - are reported by the Opportunity Scoring subagent, which must evidence each one from the fetched pages and omits anything it cannot support.
- Deterministic code, never the model, then computes BANT and MEDDIC from those signals.

- Following the original prototype, MEDDIC is a **completeness diagnostic** that carries no weight in the numeric score.
- Each of the six elements is graded 0-100% by the share of its supporting signals that carried evidence, and the overall figure is the mean of the six - so a partly evidenced element is reported as partial instead of being rounded up to "known".

- The grade separates *looked for and absent* from *never collected*.
- Customer-review evidence and contract-renewal timing have no collector in this pipeline - the first needs a third-party source, the second is only learnable from the prospect - so they are excluded from the percentage rather than capping it, and 100% stays reachable.

Both still appear in the report under "Ask on the call", alongside the specific signal missing from every incomplete element, which makes the table call prep rather than a verdict.

### Workflow architecture and retries

- LangGraph owns request state, deterministic routing, workflow branches, and the lifecycle of the prospect, match, standalone-skill, and plain-chat subgraphs.
- LangChain's `ChatOpenAI` adapter handles OpenAI-compatible model calls, streaming, and Zod-validated structured output inside those nodes.

- The secure HTTP, extraction, scoring, and report-rendering modules remain deterministic TypeScript business-logic boundaries.
- Prospect discovery, analysis, deterministic scoring, synthesis, and formatting are separate graph stages.

- Match candidate resolution, scoring, and formatting are separate stages as well, so one stage can be observed or retried without repeating completed earlier work.
- LangChain agents are not used, so a model cannot reorder or skip the required audit stages.

Retries have one owner per operation:

- LangChain model retries are disabled (`maxRetries: 0`); the workflow and secure-fetch policies
  below are the only retry owners.

- LangGraph retries the structured intent-router node once for temporary provider failures or
  invalid structured output.
- Structured subagent, candidate, and synthesis calls receive one bounded repair/retry attempt
  before their existing partial-result fallback applies.
- The secure URL fetcher retries only temporary DNS, transport, rate-limit, or server failures.
  Invalid URLs, private/blocked addresses, permanent client errors, certificate failures, excessive
  redirects, and cancellation are not retried.
- URL retry backoff is cancellable, redirect and DNS safety checks run on every attempt, validated
  DNS addresses rotate between temporary connection failures, and oversized responses are stopped
  while bytes arrive rather than buffered completely.

- The graph is currently created per request without a server-side checkpointer.
- This preserves the existing privacy boundary: completed conversations and reports live only in browser IndexedDB.
- Durable resume, background runs, and human-review interrupts require a separate storage and ownership decision.

### Project layout

| Path | Responsibility |
| --- | --- |
| `src/app/` | App Router page and the single `/api/chat` streaming endpoint. |
| `src/lib/workflow/` | LangGraph graph, shared state, and the prospect, match, standalone, and plain-chat subgraphs. |
| `src/lib/agent/` | Intent router, prospect orchestrator, and the Zod schemas every structured model call is validated against. |
| `src/lib/extract/` | Secure fetching (SSRF guard), homepage analysis, contact discovery, and HTML-to-text. |
| `src/lib/scoring/` | Deterministic BANT, MEDDIC, and composite scoring. No I/O and no model calls. |
| `src/lib/skills/` | The five subagent definitions, the four standalone skills, and the match pipeline. |
| `src/lib/storage/` | Browser IndexedDB persistence for conversations and reports. |

Business rules live in `scoring/` and `extract/`, never in a prompt: the model supplies evidenced facts and deterministic TypeScript does every calculation.

### Finding buyers or sellers for a product

Ask where to sell or where to buy a product and the assistant uses the same match structure in both directions. Sell mode ranks likely customers or buyers; buy mode ranks sellers, retailers, distributors, suppliers, and marketplaces.

- The request can use natural wording in any language, and a follow-up such as "Where can I buy them?" recovers the product from the conversation instead of requiring a fixed prompt format.

- An explicit city, region, or country filters either direction.
- For buy requests, candidates must sell, ship, deliver, or serve the requested location; for sell requests, candidates must operate, purchase, or have a relevant business presence there.

- The latest explicit location wins in follow-ups such as "What about Montreal?" When no location is supplied, the detected language continues to provide the default market signal.
- The app does not access browser geolocation automatically.

| Companies you name | No product mentioned | Product mentioned |
| --- | --- | --- |
| **None** | Plain chat | The LLM suggests candidates, quick-scores up to 12, and returns up to 8 ranked by fit. |
| **One** | Full audit (prospect/research/qualify/contacts/outreach, as usual) | Same full audit, now grounded in the product you described |
| **Two or more** | Each is quick-scored generically - useful for narrowing a shortlist before you've settled on a pitch. | Each is quick-scored against the product, ranked, and up to 8 are shown |

- **You only have to mention your product once.** The router scans the whole conversation, not just the latest message, so once you've said what you want to sell or buy it carries that context into later requests automatically - no setting to configure and no need to repeat it.
- If no product has been mentioned yet, the assistant asks for the missing product before matching.

- The ranked list from `match` renders as selectable cards: full company name, score, clickable website, location/founding date when the page's own structured data has them, a factual description of what the company does, and a separate fit judgment - a fast, single LLM call per candidate, not the full five-subagent audit.

- A separate action on each card starts a full review of that company.
- Discovery mode (naming no companies) asks the same LLM to suggest candidates directly from its own knowledge - there is no separate search API.

- Every suggested company still gets its homepage fetched and scored like any other candidate, so a wrong or outdated guess just means that one gets skipped rather than shown. Naming a few candidates yourself avoids relying on the model's guesses at all.

```
we sell payroll software for mid-market companies, who should we target?
where can I buy wool blankets?
where can I sell wool blankets?
where can I buy wool blankets in Toronto?
where can I sell payroll software in Québec?
we sell payroll software, analyze https://stripe.com as a prospect
we sell payroll software, rank Acme Corp, Globex, and Initech for fit
compare Acme Corp, Globex, and Initech
```

<!-- project-control:section=architecture -->
## Architecture

### AI & Intelligence

| Technology or concept | Use in this project |
|---|---|
| LangGraph | Owns typed request state, routing, prospect/match/standalone/chat subgraphs, branches, and bounded retries; no server-side checkpointer is configured. |
| LangChain | Its ChatOpenAI adapter handles approved OpenAI-compatible model calls, streaming, and structured output. LangChain agents do not control audit stages. |
| DeepSeek deepseek-chat | Default hosted language model. Users may configure an approved OpenAI-compatible endpoint; their key is supplied per request. |
| BANT | A deterministic sales-qualification diagnostic computed from evidenced facts, separate from the composite score. |
| MEDDIC | A deterministic evidence-completeness diagnostic; it does not change the composite prospect score. |

### Frontend & Presentation

| Technology or concept | Use in this project |
|---|---|
| React | Builds conversations, report cards, settings, and other interactive UI. |
| React DOM | Renders React components in the browser. |
| Next.js | App Router supplies page routing and the server /api/chat endpoint. |
| TypeScript | Adds types to frontend code, graph state, evidence processing, and deterministic scoring. |
| react-markdown | Renders Markdown answers and report content. |
| remark-gfm | Adds GitHub Flavored Markdown features, including tables, to rendered answers. |

### Backend & Application Logic

| Technology or concept | Use in this project |
|---|---|
| Node.js | Runs the Next.js server and local development/build commands. |
| Zod | Validates structured model outputs before business logic uses them. |
| Cheerio | Parses fetched company pages into evidence and contact signals. |
| Bounded concurrency | Limits candidate resolution and scoring workers; formatting is a separate graph stage. |
| Composite scoring | Combines five prospect analyses using deterministic calculations rather than asking a model to invent a score. |

### Data & Storage

| Technology or concept | Use in this project |
|---|---|
| IndexedDB | Stores conversations and generated reports in the browser; no server-side conversation database. |
| idb-keyval | Provides the key-value access layer for IndexedDB persistence. |
| localStorage | Retains the user's API settings/key in their browser; the server does not persist them. |

### Integrations & Security

| Technology or concept | Use in this project |
|---|---|
| Server-sent events (SSE) | Streams progress and results from /api/chat to the browser. |
| OpenAI-compatible API | The allowed interface for user-configured hosted model endpoints; does not imply use of an OpenAI model. |
| ipaddr.js | Classifies resolved IP addresses for outbound-request safety checks. |
| Server-side request forgery (SSRF) protection | Validates public destinations and redirects before fetching page evidence, with bounded worker pools. |

Answers use fetched page evidence; no local embedding model or vector database is maintained.

Each row covers one technology or concept within its category and describes that item's
project-specific role, read from the current source and dependency manifest.

<a id="storage-model"></a>
<a id="data-handling"></a>
<a id="safety-rules-ported-from-the-original"></a>

## Privacy and result quality

- Settings (base URL, model, API key): `localStorage` only.
- Conversations and reports: IndexedDB in the browser. No server-side database exists; the server is
  stateless.

- The LLM API key lives only in the browser's `localStorage` and is sent per request; the Next.js server is stateless and never persists it.
- Conversations and generated reports are stored client-side in IndexedDB — no server-side database exists.

- **Evidence:** Every finding carries evidence and a confidence tag
  (High/Medium/Low/Inferred). Missing data is labeled "Not publicly available" and lowers the score.
- **URL protection:** Prospect URLs are resolved before fetching; loopback/private/link-local addresses
  and blocked hostnames are refused.
- **Source handling:** Website text, metadata, JSON-LD, and candidate content are evidence
  only; prompts explicitly forbid treating them as instructions.
- **Partial results:** Subagent failures reduce the composite score's confidence instead of
  failing the run; partial data is always marked.

<a id="references"></a>

## Design reference

[Implementation plan](docs/implementation-plan.md) records scope decisions and design references.

<a id="project-guardrails"></a>
<a id="prospect-copilot-1"></a>
<a id="testing"></a>
<a id="what-the-coverage-floors-mean"></a>
<a id="scripts"></a>

<!-- project-control:section=ignore -->
## Contributing

For source changes, follow the [repository instructions](../AGENTS.md#prospect-copilot).

<a id="repository-history-records"></a>
<a id="change-log"></a>

<a id="history-index-1"></a>

<a id="history-index-5"></a>

<!-- project-control:section=history -->
## Change history

**Change-history numbering:** Dated history without project-level version or build numbers. Follow the repository [version and build-number policy](../AGENTS.md#version-and-build-number-policy).

One record per change; complete details and evidence are below. Older work dates and Git checkpoints remain labelled when they differ.

**Historical status:** Each record describes its own delivery checkpoint. Later records supersede older pending work or recovery locations; historical checks are not new validation.

| Record | Date | Highlights | Details |
|---|---|---|---|
| README organization | 2026-09-06 | <ul><li><strong>Structure:</strong> User guide first; one history table.</li><li><strong>Rules:</strong> Scoped contributor guidance under AGENTS.</li></ul> | [Full record](#readme-organization) |
| Dated change | 2026-09-06 | <ul><li><strong>Change:</strong> Reorganized long paragraphs and table cells without dropping details.</li></ul> | [Full record](#change-1) |
| Dated change | 2026-09-06 | <ul><li><strong>Change:</strong> Moved complete project descriptions, register details, and repository-origin history into this README.</li></ul> | [Full record](#change-2) |
| Dated change | 2026-09-05 | <ul><li><strong>Change:</strong> Completed a full-sweep exhaustive pass: all 103 project files read start to finish rather than by diff, which reached two defects no earlier pass had.</li></ul> | [Full record](#change-3) |
| Dated change | 2026-09-05 | <ul><li><strong>Change:</strong> Turned on strict index checking (noUncheckedIndexedAccess) and resolved the 103 errors it raised, which exposed two defects that reading alone had not.</li></ul> | [Full record](#change-4) |
| Dated change | 2026-09-04 | <ul><li><strong>Change:</strong> Made the end-to-end suite actually run and turned coverage from a number into a gate.</li></ul> | [Full record](#change-5) |
| Dated change | 2026-09-02 | <ul><li><strong>Change:</strong> Declared Prospect Copilot's dated-history mode and linked it to the centralized repository policy.</li></ul> | [Full record](#change-6) |
| Dated change | 2026-09-02 | <ul><li><strong>Change:</strong> Completed the project's first repository-wide exhaustive pass.</li></ul> | [Full record](#change-7) |
| Dated change | 2026-08-31 | <ul><li><strong>Change:</strong> Reconciled all 49 retained project commits with the repository summary.</li></ul> | [Full record](#change-8) |
| Dated change | 2026-08-31 | <ul><li><strong>Change:</strong> Added and categorized the source-backed architecture inventory.</li></ul> | [Full record](#change-9) |
| Dated change | 2026-08-29 | <ul><li><strong>Change:</strong> Documented evidenced scoring and team-page contacts, corrected the composite-score/BANT/MEDDIC distinction, and added the source-layout table.</li></ul> | [Full record](#change-10) |
| Shared label merging | 2026-08-28 | <ul><li><strong>Change:</strong> Shared label merging.</li></ul> | [Full record](#change-11) |
| Dated change | 2026-08-23 | <ul><li><strong>Change:</strong> Upgraded the runtime/dependencies and integrated LangChain model adapters and typed LangGraph request/subgraphs.</li></ul> | [Full record](#change-12) |
| Dated change | 2026-08-22 | <ul><li><strong>Change:</strong> Introduced match schemas, routing, bounded candidate scoring, ranked reports, and selectable company cards.</li></ul> | [Full record](#change-13) |
| Dated change | 2026-08-21 | <ul><li><strong>Change:</strong> Introduced the standalone BYOK prospect-audit application and four research skills.</li></ul> | [Full record](#change-14) |

<details>
<summary>Full records for this table</summary>

<a id="readme-organization"></a>

### README organization — 2026-09-06

- **Structure:** Put purpose, capabilities, setup, architecture, and workflows before history.
- **History:** Merge matching repository-origin records into the owning change; preserve unique detail, evidence, and older links.
- **Ownership:** Keep user documentation here; route scoped contributor rules through root AGENTS.
- **Status:** Documentation changes only; uncommitted. Existing application versions, artifacts, and deployment state are unchanged.

<a id="change-1"></a>
<a id="readability-maintenance"></a>

### Reorganized long paragraphs and table cells without dropping details

- **Recorded date:** 2026-09-06.

- Reorganized long paragraphs and table cells without dropping details; consolidated imported history tables into indexes linked to complete readable records.
- Preserved existing destinations and README section mappings.
- Documentation only; no application or release artifact changed.

**Evidence and delivery status**

Local documentation changes; initially delivered uncommitted and recorded in this documentation commit.

[Back to change history](#change-history)

<a id="change-2"></a>

### Moved complete project descriptions, register details, and repository-origin history into this README

- **Recorded date:** 2026-09-06.

- Moved complete project descriptions, register details, and repository-origin history into this README; retained existing content, dates, release/build identifiers, Git evidence, and app-content mappings.
- Project guardrails now load through the root instructions only for this project.
- This is documentation maintenance; no application code, build, release, or deployment changed.

**Evidence and delivery status**

Local documentation update; uncommitted

[Back to change history](#change-history)

<a id="change-3"></a>
<a id="readme-detail-1"></a>
<a id="readme-detail-5"></a>
<a id="repository-record-1"></a>

### Completed a full-sweep exhaustive pass: all 103 project files read start to finish rather than by diff, which reached two defects no earlier pass had

- **Recorded date:** 2026-09-05.

- Cross-page contact deduplication used a weaker key than the extractor that produces the contacts - `findContacts` collapses whitespace before comparing names, while the orchestrator compared `name.toLowerCase()` alone, so one person listed as "Jane  Doe" on the team page and "Jane Doe" on the about page reached the decision-maker table twice;

- both levels now share the one exported key.
- The 2026-09-05 row below also misstated every branch figure it quoted: re-measuring in throwaway worktrees at the pre-flag commit and at HEAD gave 931 of 1,020 rising to 934 of 1,028, not 929 of 1,017 to 933 of 1,027, and those numbers are corrected in place because a later pass would otherwise inherit them.

- Two duplications were removed - the end-to-end harness re-declared three localStorage keys `constants.ts` already exports, so a rename would have desynced the suite from the app silently, and the router tests carried a second `resolveCompanyUrl` block duplicating two cases a later block already covered, together with the stub helper that existed only to serve it.

- Three documentation blocks describing exported label constants had been stranded above interfaces introduced beside them, leaving each constant undocumented, and `normalizeName` documented only half of what its body does now that it is public.

- Three documents were corrected: the sole undated plan in `docs/` described a superseded stack with nothing marking it historical, a design document announced three implementation stages and then listed four, and one line carried trailing whitespace.

- Formatting returned to each file's own convention where it had drifted - a 114-line JSX subtree indented flat with its parent, the one unwrapped `emit` in a file where every sibling wraps, a condition split across three lines that fits in 53 characters, and two misindented argument blocks.

- Three tests closed the rate limiter's two unreached `x-real-ip` branches.
- Two findings were withdrawn as false positives with the line cited, both places where a long template literal follows the file's own convention rather than breaks it. 394 unit tests, 57 end-to-end runs, typecheck, and the production build pass.

- **Status:** Verified by 394 unit tests behind per-directory coverage floors and 19 end-to-end
  specs run across Chromium, Firefox, and WebKit against the production build; typecheck and build
  pass.

**Evidence and delivery status**

`cedd296`, `07ecbe8`, `33024c4`, `9c3dcc0`, `e71abb3`, `c06ca8c`, `cab8ae9`

[Back to change history](#change-history)

<a id="change-4"></a>
<a id="readme-detail-2"></a>
<a id="readme-detail-6"></a>
<a id="repository-record-2"></a>

### Turned on strict index checking (noUncheckedIndexedAccess) and resolved the 103 errors it raised, which exposed two defects that reading alone had not

- **Recorded date:** 2026-09-05.

- Turned on strict index checking (`noUncheckedIndexedAccess`) and resolved the 103 errors it raised, which exposed two defects that reading alone had not.
- The two report label sets were typed `Record<string, string>`, a type that guarantees no key exists, while the renderers read sixteen and sixty keys off them by name;

- an absent label would have reached the page as the text "undefined" or failed the report outright.
- Both are now declared interfaces, the prospect one generated from its own literal so no key could be mistyped, and the synthesis labels are completed where they are consumed rather than trusted from their producer - which immediately caught two tests passing incomplete label sets, one of them empty.

- The five subagents and their settled results were also walked by array index in three places, two of them in opposite directions, each trusting the other array's length with nothing enforcing it;

- a single pairing helper beside the subagent definitions replaced all three.
- Remaining index reads were corrected at their own level: regex capture groups now narrow before use, fragment stripping uses the URL API instead of splitting on a hash, and provably-safe reads name their value rather than asserting it.

- Removed two pieces of dead code: a phone-number extraction that ran a loose regex over every fetched page and was read by nothing, and an unreachable cancellation branch whose guard had already thrown.

- The branch coverage floor moved from 91 to 90 because the new guards are unreachable by construction and count toward the denominator - covered branches rose from 931 to 934 while the total rose from 1,020 to 1,028. 393 tests, 57 end-to-end runs, typecheck, and the production build pass.

**Evidence and delivery status**

`7782504`, `f443168`, `51d74ce`, `60b869b`, `6c25f0d`

[Back to change history](#change-history)

<a id="change-5"></a>
<a id="readme-detail-3"></a>
<a id="readme-detail-7"></a>
<a id="repository-record-3"></a>

### Made the end-to-end suite actually run and turned coverage from a number into a gate

- **Recorded date:** 2026-09-04.

- Made the end-to-end suite actually run and turned coverage from a number into a gate.
- The specs had been failing on a 403 for every script bundle, which an earlier note recorded as a sandbox limitation;

- it was not one.
- The dev server's cross-origin guard rejects any request carrying an `Origin` header for a host outside its allowlist, and `127.0.0.1` is not on it - `curl` passed only because it sends no such header.

Pointing the suite at `localhost` fixed it, and the suite now builds and serves the production app instead of the dev server, so no dev-only guard is in play at all.

- Running the specs then exposed a real defect: settings were persisted from an effect that ran on mount before the stored values had loaded, so every page load wrote the empty defaults over the saved record and React's development double-invoke made the loss permanent - a stored API key was erased on reload.

- Settings are now written where the user actually edits them, and nothing is written before an edit.
- Grew the suite to 19 specs across Chromium, Firefox, and WebKit (57 runs) covering the settings dialog and key isolation, conversation history through real IndexedDB, candidate cards and the follow-up audit they trigger, the stop control, and a phone viewport;

- Firefox caught a backdrop the other two engines clicked through.
- Added 40 transport-boundary tests for the page fetcher's DNS resolution, address pinning, error classification, and Retry-After parsing, taking it from 54% to 87% of statements and 67% to 100% of functions - the SSRF enforcement around the port guard had been untested.

- Coverage now fails the run below per-directory floors rather than only reporting, and the README records which modules those floors cover and why the orchestration layers are verified end to end instead.

- Added a scoped GitHub Actions workflow running typecheck, the coverage gate, the production build, and the three-browser suite. 297 unit tests, 57 end-to-end runs, typecheck, and the production build pass.

- Then closed the three coverage exemptions that did not hold up: the chat endpoint's streaming body, the graph's routing decisions, and the match subgraph's stage selection had been grouped with genuine orchestration, but each still contained untested decisions.

A README claim that the endpoint was covered end to end was also wrong - every end-to-end spec stubs `/api/chat` in the browser, so no test reached the handler at all.

- Added 43 tests covering SSE framing, abort handling before and during a stream, provider-error mapping including the router's chosen language, request-limit and schema rejection, every workflow-selection branch, invalid-router-output recovery and its rethrow, and each match stage decision.

The endpoint went from 36% to 97% of statements and 29% to 88% of branches, the graph from 45% to 96% of branches, and the workflow directory from 87% to 98%.

- Coverage floors were raised to hold the result and now pin branches, not just statements, since a routing bug breaks a decision rather than a line count. 340 unit tests, 57 end-to-end runs, typecheck, and the production build pass;

- overall statement coverage is 82%.
- Closed the last untested decisions, in the standalone skill's discovery briefing: every fallback for a field the site does not publish was unexercised, so nothing checked the promise the skill's own prompt makes - that unverifiable data is marked rather than guessed.

- Three tests now drive a page that publishes nothing and a contact carrying a LinkedIn but no job title, asserting the briefing reads "Not publicly available", "none found", and "title unknown" instead of leaking undefined, and that the report title falls back to the page URL when the company is never named.

- That file reached 100% of statements, branches, and functions.
- The coverage floors were also re-grounded: they had been justified against an external 80% target that this repository does not adopt, and now state plainly that they are a regression ratchet, with AGENTS.md's per-behaviour success criteria as the actual standard. 343 unit tests, 57 end-to-end runs, typecheck, and the production build pass;

- branch coverage is 90%.
- A final sweep closed the untested decisions in the six files where branch coverage still lagged, after an earlier claim that every decision was exercised proved wrong: 104 branches were unreached.

- The SSE reader now handles a keep-alive comment, a malformed frame, an event split across two network chunks, a token carrying no text, an unrecognized agent status, and an unknown event type - it went from 74% to 97% of branches.

- The router's company-URL filter, quoting, "unknown" answer and provider-failure path, the report renderers' location and truncation variants, the prospect report's missing-company, no-contacts, failed-subagent and untranslatable-category fallbacks, the retry helper's no-signal paths, and the provider error classifier's status, cancellation and structured-output branches are all now covered.

- Two dead defensive branches were identified rather than tested around: the SSE reader's frame-buffer fallback cannot be reached because a split always yields an element, and the delay helper's already-aborted check cannot be reached because its guard throws first - and that guard throws synchronously from a function typed as returning a promise, which the tests now record.

Branch coverage rose from 90% to 91% overall with every targeted file above 87%, on 393 unit tests.

Made the end-to-end suite actually run and turned coverage from a number into a gate. The specs had been failing on a 403 for every script bundle, recorded earlier as a sandbox limitation;

- The suite now targets `localhost` and builds and serves the production app rather than the dev server.
- Running it exposed a real defect: settings were persisted from an effect that ran on mount before the stored values had loaded, so each page load wrote empty defaults over the saved record and React's development double-invoke made the loss permanent, erasing a stored API key on reload;

- settings are now written where the user edits them and nothing is written before an edit.
- Grew the suite to 19 specs across Chromium, Firefox, and WebKit (57 runs) covering settings and key isolation, conversation history through real IndexedDB, candidate cards and the follow-up audit they trigger, the stop control, and a phone viewport.

Coverage now fails the run below per-directory floors, and the project README records which modules those floors cover and why the orchestration layers are verified end to end instead.

**Evidence and delivery status**

`e59ab9c`, `c5fc241`, `a144a6d`, `fdecb4a`

[Back to change history](#change-history)

<a id="change-6"></a>

### Declared Prospect Copilot's dated-history mode and linked it to the centralized repository policy

- **Recorded date:** 2026-09-02.

Declared Prospect Copilot's dated-history mode and linked it to the centralized repository policy. Runtime behavior, dependencies, deployment status, and project numbering remain unchanged.

**Evidence and delivery status**

This documentation commit

[Back to change history](#change-history)

<a id="change-7"></a>
<a id="readme-detail-4"></a>
<a id="readme-detail-8"></a>
<a id="repository-record-4"></a>

### Completed the project's first repository-wide exhaustive pass

- **Recorded date:** 2026-09-02.

- Completed the project's first repository-wide exhaustive pass; the earlier pass had covered 8 of 52 source files.
- Restricted the page fetcher to ports 80 and 443 on the initial URL and every redirect hop, closing an arbitrary-port probe against public hosts.

- Made the report schema the single definition of its shape and validated the report event at the wire boundary instead of casting it.
- Replaced every unchecked type assertion on nullable or external data: graph-stage reads now fail loudly and name the broken ordering, the agent status and skill name narrow instead of asserting, and settings restored from browser storage are validated field by field before the API key they carry is sent as a request header.

Corrected MEDDIC so a distant contract renewal reads as looked-for-and-absent rather than as evidence. Bounded extracted emails and the briefing sent to the five parallel workers.

- Removed superseded code: the pre-workflow routing and match entry points, two unreachable helpers, and a dead parameter, redirecting their tests onto the live paths.
- Gave prospect signals, report construction, the retryable-status set, markdown rendering, and the SSE reader single owners, which also took the orchestrator from 977 to 613 lines and the match skill from 891 to 665.

- Corrected a protocol-relative LinkedIn href that rendered as a malformed four-slash URL in the decision-maker table, matching the handling the homepage extractor already had.
- Completed 36 missing JSDoc blocks, named the three buying-role patterns alongside the file's other patterns, removed an unreachable fallback, replaced duplicated literals with named constants, removed an unused catch binding, corrected a stale comment, and aligned the root layout with project style.

- A second pass under the revised audit skill added request rate limiting to the chat endpoint, moved the stored API key into its own browser record so nothing that reads or exports the settings can carry the credential with it, migrated any key already saved in the previous combined record, moved settings persistence out of the page into a testable module, made nine internal symbols private, named the remaining scoring thresholds, and added unit tests for eleven previously untested logic modules.

- A third pass ran the four simplification angles across every file after the review agents failed repeatedly: shared the absolute-URL rule, the JSON-LD node scan, routed-target resolution, and the per-worker progress emitter that had each been written twice;

- centralized the remaining SSE phase names and scoring thresholds; and collected page anchors once instead of three times per analysis.
- Added coverage measurement and an end-to-end suite: installed a version-matched coverage provider, scoped it to code that holds logic, and closed the one real gap it exposed by testing the standalone skill runner, which had no coverage at all.

- Added Playwright with six specs covering the empty state, the missing-key guard, token streaming, report rendering, server-error recovery, and proof that the stored settings record never contains the API key. 257 tests, typecheck, and the production build pass; measured coverage is 75% of statements overall and 93% across the logic-bearing library modules.

**Evidence and delivery status**

`9ad57e8`, `cd27350`, `c0935eb`, `a656890`, `2f2ae50`, `d0e89ba`, `c1fa247`

[Back to change history](#change-history)

<a id="change-8"></a>
<a id="repository-record-5"></a>

### Reconciled all 49 retained project commits with the repository summary

- **Recorded date:** 2026-08-31.

- Reconciled all 49 retained project commits with the repository summary.
- Removed the installed Next.js package's nested agent-instruction file; the version-specific guidance remains above and root AGENTS.md governs development.
- No runtime or release-number change.

- Backfilled dated history across all 49 project commits, without inventing release/build numbering.
- Preserved Next.js guidance in the project README while removing its installed special-name instruction copy.
- No runtime change.

**Evidence and delivery status**

This documentation commit

`0bc66bf`

[Back to change history](#change-history)

<a id="change-9"></a>
<a id="repository-record-6"></a>
<a id="repository-record-7"></a>
<a id="repository-record-8"></a>

### Added and categorized the source-backed architecture inventory

- **Recorded date:** 2026-08-31.

- Added and categorized the source-backed architecture inventory, then separated each technology/concept into its own row and mapped README sections for Project Control.
- Documentation only; no runtime, dependency, or deployment change.

One-item-per-row technology inventory and stable README mapping; runtime/dependencies unchanged.

Grouped architecture into AI, frontend, backend logic, storage, and integration tables without runtime or dependency changes.

- Added an architecture table covering LangGraph, LangChain, hosted model calls, evidence acquisition, scoring, matching, browser storage, and the retrieval boundary.
- No runtime or dependency changes.

**Evidence and delivery status**

`7bcc353`, `d2ccc14`

Historical work record

[Back to change history](#change-history)

<a id="change-10"></a>
<a id="readme-detail-9"></a>
<a id="repository-record-9"></a>

### Documented evidenced scoring and team-page contacts, corrected the composite-score/BANT/MEDDIC distinction, and added the source-layout table

- **Recorded date:** 2026-08-29.

- Documented evidenced scoring and team-page contacts, corrected the composite-score/BANT/MEDDIC distinction, and added the source-layout table.
- Disabled Next.js-generated agent-rule files while keeping its version-specific development guidance in the README.

- Corrected both READMEs' scoring description: the weighted 0-100 composite is blended from the five
  subagent category scores alone, while BANT and MEDDIC are reported beside it as separate
  diagnostics that carry no weight in it.

- Documented the MEDDIC grading rule, the evidenced-signal boundary between model and deterministic
  code, and the current contact-extraction behaviour.

- Added a project layout table naming each source directory's responsibility, and moved the scoring
  rationale out of the numbered pipeline list into its own section.

**Evidence and delivery status**

`ceb62e8`, `ad4d81f`, `44dfe85`

[Back to change history](#change-history)

<a id="change-11"></a>
<a id="readme-detail-10"></a>
<a id="repository-record-10"></a>

### Shared label merging

- **Recorded date:** 2026-08-28.

- Rebuilt team-page contact extraction to read names and titles from page text instead of LinkedIn
  anchors alone, so pages that list people without profile links no longer return zero contacts.

- Stopped adjacent elements being merged into one string, kept each person's full title rather than
  the matched keyword, and recognized CPO, CISO, and CHRO when classifying seniority and buying
  role.

- Excluded people whose title names a different employer, keeping investors, advisors, and board
  members out of a prospect's contact list.

- Disabled Next.js 16 agent-rule generation through <code>agentRules: false</code> so <code>next
  dev</code> no longer writes AGENTS.md and CLAUDE.md into the project, and moved that framework
  note into the project README.

Git reconciliation: Shared label merging; fed evidenced subagent signals into deterministic
  scorers; graded MEDDIC completeness and corrected zero-funding budgets. Rebuilt team-page contact
  extraction, excluded people employed elsewhere, widened subpage discovery, wired the updated
  scoring, and removed dead code under strict unused checks.

**Evidence and delivery status**

`a74eb04`, `60fa659`, `f7dbea5`, `a9e0745`, `e7ece93`, `7b38a6d`

[Back to change history](#change-history)

<a id="change-12"></a>
<a id="readme-detail-11"></a>
<a id="repository-record-11"></a>

### Upgraded the runtime/dependencies and integrated LangChain model adapters and typed LangGraph request/subgraphs

- **Recorded date:** 2026-08-23.

- Upgraded the runtime/dependencies and integrated LangChain model adapters and typed LangGraph request/subgraphs.
- Added bounded worker pools, classified retries, provider-endpoint allowlisting, safer website fetching, retained-history limits, cancellation preservation, and candidate-resolution limits.
- Normalized extracted company data, improved chat/report persistence and mobile UI, documented the workflow, and corrected import ordering.

- Migrated prospect analysis and product matching to explicit LangGraph workflows with typed shared
  state, bounded parallel workers, cancellation, and retry policies tailored to each operation.

- Integrated LangChain model adapters and structured output inside workflow nodes while keeping
  orchestration, retries, and business rules under application control.

- Hardened configurable LLM endpoints with an explicit allowlist and strengthened outbound page
  fetching with public-IP validation, DNS cancellation, and classified retry behavior.

- Bounded retained chat history, improved multilingual company naming and result rendering, added
  mobile navigation, and expanded automated coverage across workflows, persistence, routing,
  endpoints, retries, and page extraction.

- Preserved caller abort errors through routing, bounded explicit candidate resolution to 12
  identifiers before worker execution, and added regression coverage for both limits.

- Normalized employee ranges conservatively, normalized scheme-relative social links, and reused one
  pricing-link scan across each prospect analysis.

**Evidence and delivery status**

`dcc4acc`, `b7b92ca`, `ea1da03`, `120c988`, `fd030a9`, `969b66d`, `3f429c0`, `ddb56b0`, `de24386`, `ba5162e`, `16ef695`, `223bb85`, `462a128`

[Back to change history](#change-history)

<a id="change-13"></a>
<a id="readme-detail-12"></a>
<a id="repository-record-12"></a>

### Introduced match schemas, routing, bounded candidate scoring, ranked reports, and selectable company cards

- **Recorded date:** 2026-08-22.

- Introduced match schemas, routing, bounded candidate scoring, ranked reports, and selectable company cards; shared the event callback type.
- Replaced the separate search API with LLM-based company-URL and candidate discovery plus fetched-page verification.
- Added richer location/founding fields, user-language responses, multilingual persistent reports, cancellation, shared buy/sell matching, and explicit geographic constraints.
- Updated the associated documentation and regressions.

- Expanded the match skill into one shared buy/sell pipeline: natural-language requests can rank
  likely buyers or places to buy, recover referenced products from conversation history, quick-score
  up to 12 verified candidates, and return up to 8 results.

- Added explicit location-aware matching for cities, regions, and countries: buy candidates must
  sell or serve the requested market, sell candidates must have relevant operations or purchasing
  presence there, and location-only follow-ups retain the prior product and direction.

- Replaced plain Markdown output with structured in-app reports and persistent, selectable match
  cards containing full company names, clickable websites, factual descriptions, fit judgments, and
  available location/founding data.

- Made responses, cards, progress logs, and processing messages follow the latest user message's
  language and infer corresponding markets dynamically rather than relying on a fixed language list.

- Added end-to-end cancellation and restored complete report/card state after switching
  conversations or refreshing the page.

- Removed the separate web-search API: name-to-URL resolution and match discovery use the configured
  LLM, while every suggested website is still fetched and verified before scoring.

**Evidence and delivery status**

- `2e36baf`, `9b61dbd`, `2b47ade`, `683f407`, `631010f`, `37fd8e7`, `0f6d03f`, `afef726`, `e60f1ce`, `648da3e`, `0566a5b`, `f1a20f0`, `a8044ed`, `27115c6`, `0652109`, `21387a8`, `131b083`, `3a7dd86`, `62cc0d9`

[Back to change history](#change-history)

<a id="change-14"></a>
<a id="readme-detail-13"></a>
<a id="repository-record-13"></a>

### Introduced the standalone BYOK prospect-audit application and four research skills

- **Recorded date:** 2026-08-21.

- Added the project: a BYOK chat-based sales-intelligence tool with a five-subagent
  prospect-analysis pipeline, deterministic BANT/MEDDIC scoring, and
  research/qualify/contacts/outreach skills.

- Fixed a redirect-based SSRF bypass and a DNS-rebinding race in the page-fetch guard by pinning
  validated IPs per request and per redirect hop.

- Added a deterministic fallback for synthesis failures so a completed pipeline run is no longer
  discarded on one bad LLM reply.

- Switched the default LLM backend to DeepSeek, dropped the web-search settings field, blocked
  copying the API key out of Settings, and fixed conversations not saving to the sidebar when a
  reply failed before any text streamed in.

- Consolidated duplicated JSON-extraction logic and other exhaustive-pass audit findings into shared
  helpers, named constants, and a shared prop-type interface. Git reconciliation: Introduced the
  standalone BYOK prospect-audit application and four research skills. Switched the default provider
  to DeepSeek and repaired settings/sidebar behavior. Hardened the initial pipeline and JSON
  extraction, added focused coverage, and detected selling context from the conversation for scoring
  and reports.

**Evidence and delivery status**

`dd70a0d`, `85bf44c`, `8b0d27f`, `48ca88d`, `e285d96`, `87831b6`

[Back to change history](#change-history)

</details>
