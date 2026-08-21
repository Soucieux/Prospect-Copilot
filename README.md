# Prospect Copilot

A TypeScript rewrite of [`zubair-trabzada/ai-sales-team-claude`](https://github.com/zubair-trabzada/ai-sales-team-claude) as a standalone web app: a chat page where a prospect-analysis request automatically routes into a five-subagent sales pipeline.

Built with Next.js (App Router) + TypeScript, powered by any OpenAI-compatible LLM endpoint (default: DeepSeek at `https://api.deepseek.com`, model `deepseek-chat`).

## How it works

1. Type a message in the chat page. The intent router classifies it against five skills: **prospect** (full audit), **research**, **qualify**, **contacts**, **outreach** - or plain chat.
2. **Prospect** runs the full pipeline: page discovery (homepage + up to 6 subpages) -> deterministic extraction (tech stack, contacts, funding/jobs signals) -> **5 parallel subagent analyses** -> deterministic BANT/MEDDIC scoring + weighted composite (0-100, grade A+ to D) -> LLM synthesis with an executive summary, action plan, and first-touch email.
3. Standalone skills (**research / qualify / contacts / outreach**) run light discovery when a URL is given, then stream their markdown deliverable.
4. Every report is downloadable as `.md`; conversations persist in your browser's IndexedDB.

Bring your own key: the API key is stored in `localStorage` in *your* browser only and sent per-request as a header. It is never written to disk server-side and never logged.

### Optional: web search grounding

The backend accepts a Volcengine web-search key (联网搜索, `https://open.feedcoopapi.com/search_api/global_search`) via the `x-search-api-key` header on `/api/chat` and gains two behaviors when present:

- **Name to URL resolution** - "analyze Acme Analytics" (no URL) first searches for the official site, then runs the pipeline on it.
- **Third-party signals** - prospect audits and the research/qualify skills search the web for funding and news, and the findings cite independent sources alongside the company's own site.

This is no longer exposed in the Settings UI. Omit the header and everything works as before, grounded only on the prospect's own pages. Search failures never break a run - they degrade silently.

## Setup

```bash
npm install
npm run dev        # http://localhost:3000
```

Open the page, paste your DeepSeek API key into the settings bar (base URL and model are pre-filled), and try:

```
analyze https://stripe.com as a prospect
research https://www.acme.com
find decision makers at https://example.com
draft an outreach sequence for Acme Analytics
```

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Dev server |
| `npm run build` / `npm start` | Production build / serve |
| `npm test` | Vitest suite (scoring, extraction, contacts, URL safety) |
| `npm run typecheck` | `tsc --noEmit` |

## Safety rules ported from the original

- **Never fabricate.** Every finding carries evidence and a confidence tag (High/Medium/Low/Inferred). Missing data is labeled "Not publicly available" and lowers the score.
- **SSRF guard.** Prospect URLs are resolved before fetching; loopback/private/link-local addresses and blocked hostnames are refused.
- **Graceful degradation.** Subagent failures reduce the composite score's confidence instead of failing the run; partial data is always marked.

## Storage model

- Settings (base URL, model, API key): `localStorage` only.
- Conversations and reports: IndexedDB in the browser. No server-side database exists; the server is stateless.
