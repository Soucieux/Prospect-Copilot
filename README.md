# Prospect Copilot

A TypeScript rewrite of [`zubair-trabzada/ai-sales-team-claude`](https://github.com/zubair-trabzada/ai-sales-team-claude) as a standalone web app: a chat page where a prospect-analysis request automatically routes into a five-subagent sales pipeline.

Built with Next.js (App Router), TypeScript, LangGraph, and LangChain, powered
by an approved OpenAI-compatible LLM endpoint (default: DeepSeek at
`https://api.deepseek.com`, model `deepseek-chat`).

## How it works

1. Type a message in the chat page. A stateless LangGraph request workflow asks the intent router to classify it against six skills: **prospect** (full audit), **research**, **qualify**, **contacts**, **outreach**, **match** (rank candidate prospects for a product) - or plain chat.
2. **Prospect** runs the full pipeline: page discovery (homepage + up to 6 subpages) -> deterministic extraction (tech stack, contacts, funding/jobs signals) -> **5 parallel subagent analyses** -> deterministic BANT/MEDDIC scoring + weighted composite (0-100, grade A+ to D) -> LLM synthesis with an executive summary, action plan, and first-touch email.
3. Standalone skills (**research / qualify / contacts / outreach**) run light discovery when a URL is given, then stream their markdown deliverable.
4. **Match** uses one ranked-candidate pipeline for both directions: it can find likely buyers for something you want to sell or places that sell something you want to buy. Candidate URL resolution and scoring use separate bounded worker pools with at most four active jobs - see "Finding buyers or sellers for a product" below.
5. Every report renders as structured in-app content; match results use selectable cards with full company names, clickable company websites, and a separate full-review action.
6. Conversations and their report cards persist in your browser's IndexedDB, including after switching conversations or refreshing the page, and any active request can be stopped from the chat controls.
7. Every reply - plain chat, processing logs, full audits, standalone skills, and match cards alike - is written in whatever language you write in, not English by default.

Bring your own key: the API key is stored in `localStorage` in *your* browser only and sent per-request as a header. It is never written to disk server-side and never logged.

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

Requires Node.js 20 or newer.

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
