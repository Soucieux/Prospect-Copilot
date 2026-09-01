# Prospect Copilot

<!-- project-control:section=overview -->
## Overview

A TypeScript rewrite of [`zubair-trabzada/ai-sales-team-claude`](https://github.com/zubair-trabzada/ai-sales-team-claude) as a standalone web app: a chat page where one message routes automatically into a full prospect audit, one of four standalone research skills, or a ranked buy/sell product match.

Built with Next.js (App Router), TypeScript, LangGraph, and LangChain, powered
by an approved OpenAI-compatible LLM endpoint (default: DeepSeek at
`https://api.deepseek.com`, model `deepseek-chat`).

<!-- project-control:section=architecture -->
## Architecture

### AI & Intelligence

| Technology or concept | Use in this project |
|---|---|
| LangGraph | Owns typed request state, routing, prospect/match/standalone/chat subgraphs, branches, and bounded retries; no server-side checkpointer is configured. |
| LangChain | Its ChatOpenAI adapter handles approved OpenAI-compatible model calls, streaming, and structured output; LangChain agents do not control audit stages. |
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

Architecture inventory updated on 2026-08-31 from the current source and dependency manifest.
Each technology or concept has its own row within a category; descriptions retain its project-specific role.
This documentation change does not alter the application runtime or its package version.

<!-- project-control:section=workflows -->
## How it works

1. Type a message in the chat page. A stateless LangGraph request workflow asks the intent router to classify it against six skills: **prospect** (full audit), **research**, **qualify**, **contacts**, **outreach**, **match** (rank candidate prospects for a product) - or plain chat.
2. **Prospect** runs the full pipeline: page discovery (homepage + up to 6 subpages) -> deterministic extraction (tech stack, funding/jobs signals, and team-page contacts read from page text rather than links alone, with people employed elsewhere excluded) -> **5 parallel subagent analyses** -> a weighted composite of the five subagent scores (0-100, grade A+ to D), with deterministic BANT and MEDDIC reported alongside it as separate diagnostics -> LLM synthesis with an executive summary, action plan, and first-touch email.
3. Standalone skills (**research / qualify / contacts / outreach**) run light discovery when a URL is given, then stream their markdown deliverable.
4. **Match** uses one ranked-candidate pipeline for both directions: it can find likely buyers for something you want to sell or places that sell something you want to buy. Candidate URL resolution and scoring use separate bounded worker pools with at most four active jobs - see "Finding buyers or sellers for a product" below.
5. Every report renders as structured in-app content; match results use selectable cards with full company names, clickable company websites, and a separate full-review action.
6. Conversations and their report cards persist in your browser's IndexedDB, including after switching conversations or refreshing the page, and any active request can be stopped from the chat controls.
7. Every reply - plain chat, processing logs, full audits, standalone skills, and match cards alike - is written in whatever language you write in, not English by default.

Bring your own key: the API key is stored in `localStorage` in *your* browser only and sent per-request as a header. It is never written to disk server-side and never logged.

### Scoring model

Signals a page extractor cannot read - customer pain points, open roles, recent funding - are reported by the Opportunity Scoring subagent, which must evidence each one from the fetched pages and omits anything it cannot support. Deterministic code, never the model, then computes BANT and MEDDIC from those signals.

Following the original prototype, MEDDIC is a **completeness diagnostic** that carries no weight in the numeric score. Each of the six elements is graded 0-100% by the share of its supporting signals that carried evidence, and the overall figure is the mean of the six - so a partly evidenced element is reported as partial instead of being rounded up to "known".

The grade separates *looked for and absent* from *never collected*. Customer-review evidence and contract-renewal timing have no collector in this pipeline - the first needs a third-party source, the second is only learnable from the prospect - so they are excluded from the percentage rather than capping it, and 100% stays reachable. Both still appear in the report under "Ask on the call", alongside the specific signal missing from every incomplete element, which makes the table call prep rather than a verdict.

### Workflow architecture and retries

LangGraph owns request state, deterministic routing, workflow branches, and
the lifecycle of the prospect, match, standalone-skill, and plain-chat
subgraphs. LangChain's `ChatOpenAI` adapter handles OpenAI-compatible model
calls, streaming, and Zod-validated structured output inside those nodes. The
secure HTTP, extraction, scoring, and report-rendering modules remain
deterministic TypeScript business-logic boundaries. Prospect discovery,
analysis, deterministic scoring, synthesis, and formatting are separate graph
stages. Match candidate resolution, scoring, and formatting are separate
stages as well, so one stage can be observed or retried without repeating
completed earlier work. LangChain agents are not used, so a model cannot
reorder or skip the required audit stages.

Retries have one owner per operation:

- LangChain model retries are disabled (`maxRetries: 0`); the workflow and
  secure-fetch policies below are the only retry owners.

- LangGraph retries the structured intent-router node once for temporary
  provider failures or invalid structured output.
- Structured subagent, candidate, and synthesis calls receive one bounded
  repair/retry attempt before their existing partial-result fallback applies.
- The secure URL fetcher retries only temporary DNS, transport, rate-limit, or
  server failures. Invalid URLs, private/blocked addresses, permanent client
  errors, certificate failures, excessive redirects, and cancellation are not
  retried.
- URL retry backoff is cancellable, redirect and DNS safety checks run on every
  attempt, validated DNS addresses rotate between temporary connection
  failures, and oversized responses are stopped while bytes arrive rather
  than buffered completely.

The graph is currently created per request without a server-side checkpointer.
This preserves the existing privacy boundary: completed conversations and
reports live only in browser IndexedDB. Durable resume, background runs, and
human-review interrupts require a separate storage and ownership decision.

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

Business rules live in `scoring/` and `extract/`, never in a prompt: the model
supplies evidenced facts and deterministic TypeScript does every calculation.

### Finding buyers or sellers for a product

Ask where to sell or where to buy a product and the assistant uses the same
match structure in both directions. Sell mode ranks likely customers or
buyers; buy mode ranks sellers, retailers, distributors, suppliers, and
marketplaces. The request can use natural wording in any language, and a
follow-up such as "Where can I buy them?" recovers the product from the
conversation instead of requiring a fixed prompt format.

An explicit city, region, or country filters either direction. For buy
requests, candidates must sell, ship, deliver, or serve the requested location;
for sell requests, candidates must operate, purchase, or have a relevant
business presence there. The latest explicit location wins in follow-ups such
as "What about Montreal?" When no location is supplied, the detected language
continues to provide the default market signal. The app does not access browser
geolocation automatically.

| Companies you name | No product mentioned | Product mentioned |
| --- | --- | --- |
| **None** | Plain chat | The LLM suggests candidates, quick-scores up to 12, and returns up to 8 ranked by fit |
| **One** | Full audit (prospect/research/qualify/contacts/outreach, as usual) | Same full audit, now grounded in the product you described |
| **Two or more** | Each is quick-scored generically - useful for narrowing a shortlist before you've settled on a pitch | Each is quick-scored against the product, ranked, and up to 8 are shown |

**You only have to mention your product once.** The router scans the whole
conversation, not just the latest message, so once you've said what you want
to sell or buy it carries that context into later requests automatically - no
setting to configure and no need to repeat it. If no product has been mentioned
yet, the assistant asks for the missing product before matching.

The ranked list from `match` renders as selectable cards: full company name,
score, clickable website, location/founding date when the page's own structured
data has them, a factual description of what the company does, and a separate
fit judgment - a fast, single LLM call per candidate, not the full five-subagent
audit. A separate action on each card starts a full review of that company.
Discovery mode (naming no companies) asks the same LLM to suggest candidates
directly from its own knowledge - there is no separate search API. Every
suggested company still gets its homepage fetched and scored like any other
candidate, so a wrong or outdated guess just means that one gets skipped
rather than shown; naming a few candidates yourself avoids relying on the
model's guesses at all.

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

## Setup

Development guidance is maintained in the [repository instructions](../AGENTS.md); no project-level instruction file is required.

Requires Node.js 20 or newer.

This project runs Next.js 16, whose APIs, conventions, and file layout differ
from earlier versions. Before writing framework code, read the version-matched
guides bundled at `node_modules/next/dist/docs/` instead of relying on older
Next.js knowledge, and heed deprecation notices. Next.js would otherwise write
this note into generated `AGENTS.md` and `CLAUDE.md` files; `agentRules: false`
in `next.config.ts` disables that, so the note is maintained here.

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

The server accepts the default DeepSeek base URL automatically. To use a
different OpenAI-compatible provider, approve its exact base URL in the server
environment before starting the app:

```bash
LLM_ALLOWED_BASE_URLS="https://api.openai.com/v1,http://127.0.0.1:11434/v1" npm run dev
```

The browser cannot select an arbitrary provider that the server has not
approved. This prevents the chat endpoint from being used to contact internal
services while still allowing an administrator to opt in a local provider.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Dev server |
| `npm run build` / `npm start` | Production build / serve |
| `npm test` | Vitest suite (scoring, extraction, contacts, URL safety, routing, matching) |
| `npm run typecheck` | `tsc --noEmit` |

## Safety rules ported from the original

- **Never fabricate.** Every finding carries evidence and a confidence tag (High/Medium/Low/Inferred). Missing data is labeled "Not publicly available" and lowers the score.
- **SSRF guard.** Prospect URLs are resolved before fetching; loopback/private/link-local addresses and blocked hostnames are refused.
- **Untrusted web content.** Website text, metadata, JSON-LD, and candidate content are evidence only; prompts explicitly forbid treating them as instructions.
- **Graceful degradation.** Subagent failures reduce the composite score's confidence instead of failing the run; partial data is always marked.

## Storage model

- Settings (base URL, model, API key): `localStorage` only.
- Conversations and reports: IndexedDB in the browser. No server-side database exists; the server is stateless.

<!-- project-control:section=history -->
## Change log

Dates below are Git record dates, not numbered releases or deployment claims. This history
was reconciled on 2026-08-31 across current and earlier folder names. Related commits are
grouped without turning dependency/component versions into project versions.

| Date | Updates | Git evidence |
|---|---|---|
| 2026-08-31 | Reconciled all 49 retained project commits with the repository summary. Removed the installed Next.js package's nested agent-instruction file; the version-specific guidance remains above and root AGENTS.md governs development. No runtime or release-number change. | This documentation commit |
| 2026-08-31 | Added and categorized the source-backed architecture inventory, then separated each technology/concept into its own row and mapped README sections for Project Control. Documentation only; no runtime, dependency, or deployment change. | `7bcc353`, `d2ccc14` |
| 2026-08-29 | Documented evidenced scoring and team-page contacts, corrected the composite-score/BANT/MEDDIC distinction, and added the source-layout table. Disabled Next.js-generated agent-rule files while keeping its version-specific development guidance in the README. | `ceb62e8`, `ad4d81f`, `44dfe85` |
| 2026-08-28 | Shared label merging; fed evidenced subagent signals into deterministic scorers; graded MEDDIC completeness and corrected zero-funding budgets. Rebuilt team-page contact extraction, excluded people employed elsewhere, widened subpage discovery, wired the updated scoring, and removed dead code under strict unused checks. | `a74eb04`, `60fa659`, `f7dbea5`, `a9e0745`, `e7ece93`, `7b38a6d` |
| 2026-08-23 | Upgraded the runtime/dependencies and integrated LangChain model adapters and typed LangGraph request/subgraphs. Added bounded worker pools, classified retries, provider-endpoint allowlisting, safer website fetching, retained-history limits, cancellation preservation, and candidate-resolution limits. Normalized extracted company data, improved chat/report persistence and mobile UI, documented the workflow, and corrected import ordering. | `dcc4acc`, `b7b92ca`, `ea1da03`, `120c988`, `fd030a9`, `969b66d`, `3f429c0`, `ddb56b0`, `de24386`, `ba5162e`, `16ef695`, `223bb85`, `462a128` |
| 2026-08-22 | Introduced match schemas, routing, bounded candidate scoring, ranked reports, and selectable company cards; shared the event callback type. Replaced the separate search API with LLM-based company-URL and candidate discovery plus fetched-page verification. Added richer location/founding fields, user-language responses, multilingual persistent reports, cancellation, shared buy/sell matching, and explicit geographic constraints. Updated the associated documentation and regressions. | `2e36baf`, `9b61dbd`, `2b47ade`, `683f407`, `631010f`, `37fd8e7`, `0f6d03f`, `afef726`, `e60f1ce`, `648da3e`, `0566a5b`, `f1a20f0`, `a8044ed`, `27115c6`, `0652109`, `21387a8`, `131b083`, `3a7dd86`, `62cc0d9` |
| 2026-08-21 | Introduced the standalone BYOK prospect-audit application and four research skills. Switched the default provider to DeepSeek and repaired settings/sidebar behavior. Hardened the initial pipeline and JSON extraction, added focused coverage, and detected selling context from the conversation for scoring and reports. | `dd70a0d`, `85bf44c`, `8b0d27f`, `48ca88d`, `e285d96`, `87831b6` |
