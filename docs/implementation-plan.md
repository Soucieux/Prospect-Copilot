# Prospect Copilot - TypeScript Chat App: Implementation Plan

**Status:** Historical. This is the original v1 plan, kept as a record of the
decisions the rewrite started from. Several of them were later replaced - the
provider is DeepSeek rather than GLM, model calls go through LangChain's
`ChatOpenAI` rather than the `ai` SDK, orchestration moved into LangGraph
subgraphs, page fetching lives in `src/lib/extract/` rather than an
`/api/fetch-url` route, and a `match` skill was added. The current
architecture is described in [`../README.md`](../README.md); read that, not
this file, for how the app works today.

Rewrite of `zubair-trabzada/ai-sales-team-claude` as a standalone web app: a public chat
page where a user (bringing their own GLM API key) asks questions and the app auto-invokes
the sales skills. Source design reference: `docs/ai-sales-team-claude-design.md`.

## Decisions (confirmed)

- **Scope v1:** Core 5 skills - prospect (flagship), research, qualify, contacts, outreach
- **Agent design:** Faithful port - sequential discovery -> 5 parallel subagent LLM calls -> deterministic synthesis
- **Storage:** Client-side only (localStorage/IndexedDB). No database, no accounts.
- **BYOK:** User supplies GLM API base URL + model + key in a Settings modal. Key is stored
  in localStorage, sent per-request to our API route, used in-memory only, never logged.
- **Stack:** Next.js (App Router) + TypeScript, AI SDK with OpenAI-compatible provider
  pointed at the GLM endpoint. Vitest for unit tests.

## Architecture

```
Browser (public URL)
┌─────────────────────────────────────────────────────┐
│ Chat UI (streaming, markdown, score cards)          │
│ Settings modal (GLM base URL / model / key)         │
│ Sidebar: conversations + Reports list (IndexedDB)   │
└───────────────┬─────────────────────────────────────┘
                │ POST /api/chat (SSE) - key in request header
┌───────────────▼─────────────────────────────────────┐
│ Next.js API routes                                  │
│  /api/chat      intent router + skill orchestration │
│  /api/fetch-url server-side page fetch (SSRF-guarded)│
│                                                     │
│ lib/agent/   orchestrator: discovery -> parallel ->   │
│              synthesis, streams progress events     │
│ lib/skills/  5 skill prompts + 5 subagent prompts   │
│              (TS ports of SKILL.md / agents/*.md)   │
│ lib/extract/ analyze-prospect.ts, contact-finder.ts │
│              (TS ports of the Python scrapers)      │
│ lib/scoring/ lead-scorer.ts - deterministic BANT +  │
│              MEDDIC + weighted composite (pure fns) │
└───────────────┬─────────────────────────────────────┘
                │ OpenAI-compatible calls
┌───────────────▼─────────────────────────────────────┐
│ GLM API (user's key) - chat + tool calling;         │
│ web search used where the endpoint supports it      │
└─────────────────────────────────────────────────────┘
```

## Prospect pipeline (the flagship flow)

1. **Route:** cheap LLM call classifies the message against a skill directory
   (name + trigger description). No match -> plain chat with the same model.
2. **Phase 1 - Discovery (sequential, server-side):**
   fetch homepage (retry www/http variants) + up to 6 subpages (about/team/pricing/
   blog/careers/contact); run `analyze-prospect.ts` (tech-stack signatures, JSON-LD,
   socials, pricing, contact patterns) and `contact-finder.ts` (people extraction with
   seniority/buying-role tagging). Compile a Discovery Briefing JSON. Unreachable URL ->
   explicit error, never a fabricated report.
3. **Phase 2 - 5 parallel GLM calls**, each = subagent prompt + briefing, each returning
   a forced JSON schema: dimension scores + evidence-backed findings (company 25%,
   contacts 20%, opportunity 20%, competitive 15%, strategy 20%). Never-fabricate and
   cite-source rules ported verbatim into every subagent prompt.
4. **Phase 3 - Synthesis:** `lead-scorer.ts` computes the weighted composite, grade,
   and confidence deterministically in code (failed subagent -> neutral 50 + confidence
   drop). One final LLM call writes exec summary, 3-tier action plan, ready-to-send
   first email. UI renders score bars + full markdown report; saved to IndexedDB,
   exportable as `.md`.

Standalone skills (research/qualify/contacts/outreach) reuse the same pattern minus
parallelism: discovery -> single subagent call -> deterministic scoring where applicable.

## File layout (new project at repo root)

```
demo/
├── docs/                        (existing, untouched)
├── src/app/page.tsx             chat page
├── src/app/api/chat/route.ts    agent endpoint (SSE)
├── src/app/api/fetch-url/route.ts
├── src/lib/agent/{router,orchestrator,stream-events}.ts
├── src/lib/skills/{prospect,research,qualify,contacts,outreach}.ts
├── src/lib/skills/subagents/{company,contacts,opportunity,competitive,strategy}.ts
├── src/lib/extract/{analyze-prospect,contact-finder,html-to-text}.ts
├── src/lib/scoring/lead-scorer.ts
├── src/lib/storage/{conversations,reports}.ts   (IndexedDB via idb-keyval)
├── src/components/{chat,message,scorecard,report-view,settings,sidebar}.tsx
└── src/lib/{schemas,constants}.ts
```

Dependencies kept minimal: `ai` + `@ai-sdk/openai-compatible`, `cheerio` (HTML parsing),
`react-markdown`, `idb-keyval`, `zod`. PDF export deferred - v1 ships `.md` download +
browser print stylesheet.

## Build phases

1. **Scaffold + connectivity spike** - Next.js + TS + Settings modal (BYOK) + basic
   streaming chat working against the GLM endpoint. *Verifies tool calling works before
   building on it - if the endpoint lacks function calling, fall back to JSON-mode
   prompting (contingency decided here).*
2. **Port the deterministic core** - `lead-scorer.ts`, `analyze-prospect.ts`,
   `contact-finder.ts` with Vitest unit tests (target 80%+ on these modules).
3. **Prospect pipeline** - router + 5 subagent prompt ports + orchestrator with
   streaming progress events + scorecard/report rendering + IndexedDB persistence.
4. **Remaining 4 skills** - research, qualify, contacts, outreach as standalone flows
   reading prior client-side reports when present (read-before-research rule).
5. **Polish** - report export, conversation sidebar, error/degraded-data states,
   SSRF guard on fetch (block private IP ranges), README.

## Key risks / mitigations

- **GLM function-calling behavior unknown** -> phase-1 spike decides tool-calling vs
  JSON-mode prompting before any orchestration is built.
- **Contact data will often be sparse** (LinkedIn auth-walled) -> never-fabricate rule +
  confidence scoring ported from the design doc; UI shows "Not publicly available"
  honestly.
- **5 parallel calls = cost/latency** -> progress events stream per-agent completion so
  the user sees movement; weights and sub-dimensions match the design doc exactly.

## Out of scope for v1

The other 9 commands, server-side persistence, user accounts, email sending,
PDF generation, CRM integration.
