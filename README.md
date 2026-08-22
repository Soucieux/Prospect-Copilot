# Prospect Copilot

A TypeScript rewrite of [`zubair-trabzada/ai-sales-team-claude`](https://github.com/zubair-trabzada/ai-sales-team-claude) as a standalone web app: a chat page where a prospect-analysis request automatically routes into a five-subagent sales pipeline.

Built with Next.js (App Router) + TypeScript, powered by any OpenAI-compatible LLM endpoint (default: DeepSeek at `https://api.deepseek.com`, model `deepseek-chat`).

## How it works

1. Type a message in the chat page. The intent router classifies it against six skills: **prospect** (full audit), **research**, **qualify**, **contacts**, **outreach**, **match** (rank candidate prospects for a product) - or plain chat.
2. **Prospect** runs the full pipeline: page discovery (homepage + up to 6 subpages) -> deterministic extraction (tech stack, contacts, funding/jobs signals) -> **5 parallel subagent analyses** -> deterministic BANT/MEDDIC scoring + weighted composite (0-100, grade A+ to D) -> LLM synthesis with an executive summary, action plan, and first-touch email.
3. Standalone skills (**research / qualify / contacts / outreach**) run light discovery when a URL is given, then stream their markdown deliverable.
4. **Match** runs the other direction: describe what you sell (with zero or several companies named, instead of one) and it finds/ranks candidates instead of auditing a single target - see "Finding prospects for a product" below.
5. Every report renders fully in-app (no file download); conversations persist in your browser's IndexedDB.

Bring your own key: the API key is stored in `localStorage` in *your* browser only and sent per-request as a header. It is never written to disk server-side and never logged.

### Finding prospects for a product

Describe what you sell instead of naming one company, and the assistant runs
the other direction: it finds and ranks candidate companies as prospects,
rather than auditing a single target. Which mode runs is decided purely by
how many companies you name - not by whether a product is mentioned:

| Companies you name | No product mentioned | Product mentioned |
| --- | --- | --- |
| **None** | Plain chat | The LLM suggests candidates, quick-scores each, returns the top 5 ranked by fit |
| **One** | Full audit (prospect/research/qualify/contacts/outreach, as usual) | Same full audit, now grounded in the product you described |
| **Two or more** | Each is quick-scored generically - useful for narrowing a shortlist before you've settled on a pitch | Each is quick-scored against the product, ranked, top 5 shown |

**You only have to mention your product once.** The router scans the whole
conversation, not just the latest message, so once you've said what you sell
it carries forward to every later request automatically - no setting to
configure, no repeating it. If no product has been mentioned yet, reports
carry a one-line prompt asking what you sell, so you know how to unlock the
sharper scoring next time.

The ranked list from `match` renders as clickable cards (company, score, and
a one-line reason) - a fast, single LLM call per candidate, not the full
five-subagent audit. Click any card to run the full audit on that company.
Discovery mode (naming no companies) asks the same LLM to suggest candidates
directly from its own knowledge - there is no separate search API. Every
suggested company still gets its homepage fetched and scored like any other
candidate, so a wrong or outdated guess just means that one gets skipped
rather than shown; naming a few candidates yourself avoids relying on the
model's guesses at all.

```
we sell payroll software for mid-market companies, who should we target?
we sell payroll software, analyze https://stripe.com as a prospect
we sell payroll software, rank Acme Corp, Globex, and Initech for fit
compare Acme Corp, Globex, and Initech
```

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
