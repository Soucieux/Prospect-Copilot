# Prospect Copilot

A TypeScript rewrite of [`zubair-trabzada/ai-sales-team-claude`](https://github.com/zubair-trabzada/ai-sales-team-claude) as a standalone web app: a chat page where a prospect-analysis request automatically routes into a five-subagent sales pipeline.

Built with Next.js (App Router) + TypeScript, powered by any OpenAI-compatible LLM endpoint (default: DeepSeek at `https://api.deepseek.com`, model `deepseek-chat`).

## How it works

1. Type a message in the chat page. The intent router classifies it against six skills: **prospect** (full audit), **research**, **qualify**, **contacts**, **outreach**, **match** (rank candidate prospects for a product) - or plain chat.
2. **Prospect** runs the full pipeline: page discovery (homepage + up to 6 subpages) -> deterministic extraction (tech stack, contacts, funding/jobs signals) -> **5 parallel subagent analyses** -> deterministic BANT/MEDDIC scoring + weighted composite (0-100, grade A+ to D) -> LLM synthesis with an executive summary, action plan, and first-touch email.
3. Standalone skills (**research / qualify / contacts / outreach**) run light discovery when a URL is given, then stream their markdown deliverable.
4. **Match** runs the other direction: describe what you sell (with zero or several companies named, instead of one) and it finds/ranks candidates instead of auditing a single target - see "Finding prospects for a product" below.
5. Every report is downloadable as `.md`; conversations persist in your browser's IndexedDB.

Bring your own key: the API key is stored in `localStorage` in *your* browser only and sent per-request as a header. It is never written to disk server-side and never logged.

### Finding prospects for a product

Describe what you sell instead of naming one company, and the assistant runs
the other direction: it finds and ranks candidate companies as prospects,
rather than auditing a single target. Which mode runs is decided purely by
how many companies you name - not by whether a product is mentioned:

| Companies you name | No product mentioned | Product mentioned |
| --- | --- | --- |
| **None** | Plain chat | Web search finds candidates, quick-scores each, returns the top 5 ranked by fit |
| **One** | Full audit (prospect/research/qualify/contacts/outreach, as usual) | Same full audit, now grounded in the product you described |
| **Two or more** | Each is quick-scored generically - useful for narrowing a shortlist before you've settled on a pitch | Each is quick-scored against the product, ranked, top 5 shown |

**You only have to mention your product once.** The router scans the whole
conversation, not just the latest message, so once you've said what you sell
it carries forward to every later request automatically - no setting to
configure, no repeating it. If no product has been mentioned yet, reports
carry a one-line prompt asking what you sell, so you know how to unlock the
sharper scoring next time.

The ranked list from `match` is a fast, single LLM call per candidate - not
the full five-subagent audit. Ask about any one of the results by name
afterward to run the full audit on it. Discovery mode (naming no companies)
needs a Volcengine web-search key configured (see below); without one, it
replies asking you to name a few candidates directly instead of erroring out.

```
we sell payroll software for mid-market companies, who should we target?
we sell payroll software, analyze https://stripe.com as a prospect
we sell payroll software, rank Acme Corp, Globex, and Initech for fit
compare Acme Corp, Globex, and Initech
```

### Optional: web search grounding

The backend accepts a Volcengine web-search key (联网搜索, `https://open.feedcoopapi.com/search_api/global_search`) via the `x-search-api-key` header on `/api/chat` and gains three behaviors when present:

- **Name to URL resolution** - "analyze Acme Analytics" (no URL) first searches for the official site, then runs the pipeline on it.
- **Third-party signals** - prospect audits and the research/qualify skills search the web for funding and news, and the findings cite independent sources alongside the company's own site.
- **Candidate discovery** - the match skill's discovery mode (no companies named) searches the web for candidates to rank; without a key, name a few candidates directly instead.

This is no longer exposed in the Settings UI. Omit the header and everything works as before, grounded only on the prospect's own pages. Search failures never break a run - they degrade silently.

## Setup

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
```

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
- **Graceful degradation.** Subagent failures reduce the composite score's confidence instead of failing the run; partial data is always marked.

## Storage model

- Settings (base URL, model, API key): `localStorage` only.
- Conversations and reports: IndexedDB in the browser. No server-side database exists; the server is stateless.
