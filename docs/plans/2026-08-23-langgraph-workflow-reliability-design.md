# Prospect Copilot LangGraph workflow and reliability design

**Status:** Implemented, including the recommended LangChain model layer

**Date:** 2026-08-23

**Scope:** Direct LangGraph.js orchestration, LangChain model components,
URL-fetch reliability, workflow state, bounded concurrency, localized progress,
and behavior-preserving migration

**Excluded from the implementation:** LangChain agents, RAG/vector
storage, server-side durable checkpoints, deployment, and Git integration

## 1. Executive summary

Prospect Copilot already behaves like a graph: it routes each message, runs one
of several workflows, fans work out across company pages or analysis agents,
merges partial results, and streams progress back to the browser. That graph is
currently expressed through a large API controller, long parameter lists,
`Promise.allSettled`, mutable progress callbacks, and broad error fallbacks.

This design converts that orchestration directly to LangGraph.js while
retaining all deterministic TypeScript business logic. LangGraph owns workflow
state, conditional routing, fan-out/fan-in, node lifecycle, and node-level
retry. LangChain's `ChatOpenAI` and structured-output runnables now provide the
model boundary inside those nodes. LangGraph is not asked to choose the
workflow autonomously, and no generic LangChain agent controls the process.

The migration has three implementation stages:

1. Harden URL fetching and error classification before graph conversion.
2. Move the existing behavior into a stateless, per-request LangGraph with
   unchanged SSE and report contracts.
3. Use graph-native dynamic workers, bounded concurrency, targeted retry, and
   standardized progress events.
4. Replace the hand-written model transport and JSON parsing with LangChain
   `ChatOpenAI` and Zod-validated structured output, with LangChain retries
   disabled so the established workflow retry owners remain authoritative.

Durable checkpoints, resume-after-refresh, background runs, and human approval
interrupts are intentionally separated behind a later product decision. They
would require server-side workflow persistence or another checkpoint owner,
which would change the current promise that conversations and reports remain
only in browser IndexedDB.

### 1.1 Implementation record

- The request API now delegates to a stateless top-level LangGraph and explicit
  prospect, match, standalone-skill, and plain-chat branches.
- Prospect discovery, analysis, deterministic scoring, synthesis, and report
  formatting now use separate subgraph nodes. Match clarification, candidate
  resolution, scoring, and report formatting are also separate nodes with
  bounded intermediate state.
- Prospect analysis, match-candidate resolution, and match-candidate scoring
  use reusable LangGraph `Send` worker pools. Candidate stages run with maximum
  concurrency four; the five fixed prospect analyses remain parallel.
- URL retry remains owned by the secure HTTP layer. Structured model retry is
  bounded at the operation/node boundary, so installing LangGraph did not add
  a second provider retry layer.
- Provider timeouts are classified separately from caller cancellation, and
  URL retry rotates across validated public DNS addresses instead of selecting
  only the first address on every attempt.
- `@langchain/langgraph`, `@langchain/core`, and `@langchain/openai` are
  installed. `ChatOpenAI` owns the provider adapter, streaming, and structured
  output parsing. Autonomous LangChain agents remain excluded.
- No checkpointer or server-side user-data store was added. The separately
  gated durable-run and interrupt phase remains unimplemented. Persistent
  timing/retry telemetry also remains deferred because the app has no approved
  server-side diagnostic store.

## 2. Why this change

### 2.1 Current strengths to preserve

The current application already provides:

- natural-language detection of buy and sell requests without a required
  prompt format;
- product recovery from prior conversation turns;
- explicit location support for either match direction;
- arbitrary-language responses, progress labels, reports, and company cards;
- one result structure for places to buy and companies to sell to;
- full company names, selectable card text, and clickable websites;
- browser IndexedDB persistence for messages and report cards;
- cancellation through `AbortSignal`;
- structured Markdown and dedicated match cards;
- SSRF defenses that validate and pin public IP addresses across redirects;
- deterministic scoring and graceful partial-analysis fallback.

These behaviors are compatibility requirements, not opportunities for redesign.

### 2.2 Problems identified in the architecture review

1. `src/app/api/chat/route.ts` owns transport, routing, orchestration, report
   construction, error mapping, and stream lifecycle.
2. `runProspectPipeline` and `runMatchSkill` receive long lists of shared
   parameters rather than reading a typed workflow state.
3. Fixed and dynamic parallel work is coordinated manually with
   `Promise.allSettled`.
4. Up to 12 match candidates can be fetched and scored at once without a
   workflow-level concurrency limit.
5. Candidate and URL-resolution functions convert many failures to `null`, so
   the workflow cannot distinguish temporary failures from permanent failures.
6. The URL fetcher tries protocol/hostname variants but does not retry the same
   target after a transient transport or server failure.
7. The response-size limit is applied after buffering the complete response,
   so a very large response can consume memory before it is truncated.
8. Routing, product/context extraction, language detection, and runtime-label
   translation share one structured LLM response; a parse failure degrades the
   whole operation to plain chat.
9. Progress is manually emitted by every pipeline function instead of being
   derived from workflow execution.
10. Browser conversations persist, but in-progress server execution has no
    checkpoint or resume identity.

## 3. Goals

### 3.1 Initial implementation goals

- Express the existing workflows as explicit nodes, edges, and subgraphs.
- Keep deterministic sequencing under application control.
- Preserve the existing `ChatEvent` SSE wire contract and all UI behavior.
- Store common request context in typed graph state instead of long parameter
  lists.
- Retry only temporary URL and LLM failures with bounded backoff.
- Preserve partial success when one subpage, analysis, or candidate fails.
- Limit concurrent candidate workers without reducing the candidate pool.
- Stream localized progress consistently from graph execution.
- Use LangChain's OpenAI-compatible model adapter while preserving BYOK,
  approved custom endpoints, streaming, cancellation, and existing prompts.
- Keep API keys, abort signals, HTTP headers, and callbacks outside graph state.
- Preserve the current browser-only conversation and report persistence model.
- Make later checkpointing and human review possible without requiring either
  in the first migration.

### 3.2 Future goals enabled by the design

- Resume a stopped or disconnected workflow from its last checkpoint.
- Retry one failed company without repeating successful candidates.
- Pause after candidate discovery so the user can add, remove, or approve
  companies before paid scoring calls begin.
- Change a product or location and resume from the relevant match stage.
- Inspect node-level state history for troubleshooting.
- Allow a new skill to be added as a subgraph rather than another API branch.

## 4. Non-goals

- Do not introduce a LangChain `createAgent` loop.
- Do not allow an LLM to choose whether required scoring stages run.
- Do not add embeddings, a vector database, or RAG.
- Do not replace deterministic BANT/MEDDIC or candidate ranking with LLM
  judgment.
- Do not replace the secure HTTP/DNS implementation with an LLM tool or a
  generic document loader.
- Do not add a second search API or claim LangGraph improves URL knowledge.
- Do not increase the candidate cap solely because work is graph-managed.
- Do not store the user's API key in graph state, checkpoints, logs, or reports.
- Do not add server-side conversation storage during the initial migration.
- Do not change the report/card presentation or require a new prompt format.
- Do not convert unrelated frontend components or styling.

## 5. Alternatives considered

### 5.1 Keep the raw TypeScript workflow

**Advantages**

- Smallest dependency and migration surface.
- Existing behavior is already functional and covered by focused tests.
- Direct control over cancellation, HTTP, and SSE behavior.

**Disadvantages**

- State, routing, fan-out, retries, and progress remain manually coordinated.
- Resume and human interruption would require new infrastructure later.
- Adding workflows continues to enlarge the API controller and pipeline files.

**Decision:** Rejected for this scope because the requested outcome is a direct
LangGraph conversion and the app now has enough branching and parallel work to
benefit from explicit orchestration.

### 5.2 Add LangChain components without LangGraph

**Advantages**

- Standardized model and structured-output interfaces.
- Smaller change than graph migration.

**Disadvantages**

- Does not solve workflow state, fan-out, progress, checkpoint, or interruption
  concerns.
- Adds abstraction around an LLM client that is already small and provider
  compatible.

**Decision:** Selected after the graph migration. LangChain model and
structured-output components now reduce custom transport/parsing code inside
the nodes, while LangGraph continues to own topology and retry policy.

### 5.3 Use one LangChain agent for the complete product

**Advantages**

- Minimal top-level invocation code.
- Flexible tool selection for open-ended research.

**Disadvantages**

- The model could skip, repeat, or reorder required operations.
- Cost, latency, output structure, and progress become less predictable.
- A tool-calling model would sit in front of security-sensitive URL operations.

**Decision:** Rejected. Prospect Copilot promises controlled audits and ranked
results, not an open-ended autonomous research loop.

### 5.4 Direct standalone LangGraph migration

**Advantages**

- Explicit shared state and conditional edges.
- First-class fan-out/fan-in and reducers.
- Node-level retry and event streaming.
- A path to checkpoints and human review without surrendering control to an
  agent.
- Existing TypeScript functions can be reused inside nodes.

**Disadvantages**

- More files and concepts than the current direct workflow.
- A behavior-parity migration is required before adding new product features.
- Durable execution still requires an external checkpoint owner and compatible
  deployment runtime.

**Decision:** Recommended.

## 6. Architecture decision

Use `@langchain/langgraph` and `@langchain/core` directly. Do not add the
top-level `langchain` agent package during this migration. The existing
`chatCompletion` and `streamChatCompletion` functions remain the model
boundary used by graph nodes.

The API route becomes a transport adapter:

```text
Browser
  |
  | POST /api/chat + BYOK headers
  v
Validate request and create runtime context
  |
  v
Stream compiled Prospect Copilot graph
  |
  v
Map graph updates/messages/custom events to existing ChatEvent SSE frames
  |
  v
Browser updates messages, progress, reports, and IndexedDB
```

The graph becomes the application orchestrator:

```text
START
  |
  v
understand_request
  |
  +-- none ----------------------> plain_chat ----------> END
  |
  +-- prospect ------------------> prospect_subgraph ---> END
  |
  +-- match ---------------------> match_subgraph ------> END
  |
  +-- research/qualify/
      contacts/outreach ---------> standalone_subgraph -> END
```

## 7. State and runtime boundaries

### 7.1 Shared top-level graph state

The top-level state contains only serializable workflow data:

| Field | Purpose | Merge behavior |
| --- | --- | --- |
| `requestId` | Correlates events within one request | Replace |
| `message` | Latest user message | Immutable after entry |
| `history` | Bounded prior user/assistant text | Immutable after entry |
| `routing` | Validated skill, target, product, direction, and location | Replace |
| `language` | Language of the latest user message | Replace |
| `runtimeLabels` | Complete localized progress/report labels | Replace |
| `report` | Final structured report, when produced | Replace |
| `reply` | Plain/clarification streamed or completed text | Append/replace as appropriate |
| `failures` | Typed non-secret workflow failure summaries | Append reducer |
| `status` | Running, completed, cancelled, or failed | Replace |

The top-level graph passes a narrow input state into each subgraph and receives
only its final report/reply and failure summaries back. Prospect-only HTML,
briefings, analyses, and candidate worker state do not pollute every branch.

### 7.2 Runtime context outside state

The following values are supplied to nodes through non-persisted runtime
configuration:

- `LlmConfig`, including API key, base URL, and model;
- `AbortSignal`;
- graph/custom-event writer;
- request deadline and concurrency configuration;
- server-only diagnostic correlation data.

They must never be returned as a state update. Tests must explicitly assert
that serialized state contains no API key, authorization header, callback, or
abort object.

### 7.3 Subgraph state

#### Prospect audit state

| Field | Purpose |
| --- | --- |
| `target` | Validated target URL/entity |
| `sellingContext` | Product/ICP, when supplied |
| `briefing` | Bounded factual discovery result |
| `analysisResults` | Category-keyed successful subagent results |
| `analysisFailures` | Category-keyed exhausted failures |
| `composite` | Deterministic weighted score |
| `bant` | Deterministic BANT dimensions |
| `synthesis` | Validated narrative synthesis, when available |
| `report` | Final structured report |

`analysisResults` and `analysisFailures` use reducers so parallel workers can
merge without overwriting each other.

#### Match state

| Field | Purpose |
| --- | --- |
| `product` | Product/service being bought or sold |
| `direction` | `buy` or `sell` |
| `location` | Latest explicit city/region/country, if any |
| `candidateInputs` | User-named or LLM-suggested candidates |
| `resolvedCandidates` | Deduplicated validated company targets |
| `candidateResults` | Successful candidate scores, reducer-merged |
| `candidateFailures` | Per-candidate typed failures, reducer-merged |
| `rankedCandidates` | Deterministically sorted top results |
| `report` | Localized structured match report |

## 8. Node and subgraph design

### 8.1 Top-level nodes

| Node | Responsibility | Failure behavior |
| --- | --- | --- |
| `understand_request` | Invoke router, validate structured output, preserve latest-message language | Retry transient/invalid structured output once; then use safe fallback |
| `plain_chat` | Stream an ordinary localized reply | Retry only before tokens are emitted; never duplicate visible tokens |
| `clarify_match_input` | Ask for missing product/context in detected language | Deterministic from localized labels |
| `build_report_event` | Normalize subgraph output into existing `ReportState` | Treat schema mismatch as internal failure |

The router must stop resolving company URLs internally. URL resolution belongs
to the selected subgraph so routing failure, URL resolution failure, and page
fetch failure remain distinguishable.

### 8.2 Prospect audit subgraph

```text
discover_prospect
  |
  v
dispatch_analysis_workers
  |
  +--> analyze_company_fit --------+
  +--> analyze_contact_access -----+
  +--> analyze_opportunity --------+--> merge_analysis_results
  +--> analyze_competition --------+
  +--> analyze_outreach -----------+
                                           |
                                           v
                                  calculate_scores
                                           |
                                           v
                                  synthesize_report
                                           |
                                           v
                                    format_report
```

`discover_prospect` reuses the current secure fetch, extraction, subpage, and
contact helpers. It returns a bounded `DiscoveryBriefing`; raw HTTP objects and
unbounded response bodies never enter graph state.

The five analysis workers are required, fixed workers. A worker that exhausts
retries contributes a typed failure, after which deterministic scoring applies
the existing neutral/degraded behavior. `merge_analysis_results` waits for all
five terminal outcomes before scoring.

`synthesize_report` may fall back to the existing localized deterministic
report if synthesis fails after its retry policy. The successful analysis
results and deterministic score must never be discarded because synthesis
failed.

### 8.3 Match subgraph

```text
collect_candidate_identifiers
  |
  +-- none --> format_empty_match_report --> END
  |
  v
dispatch_resolution_workers
  |
  +--> resolve_candidate(A) --+
  +--> resolve_candidate(B) --+--> merge_and_dedupe_hosts
  +--> resolve_candidate(C) --+             |
                                             v
                                  dispatch_scoring_workers
                                             |
  +--> score_candidate(A) ------+
  +--> score_candidate(B) ------+--> merge_candidate_results
  +--> score_candidate(C) ------+             |
                                               v
                                         rank_candidates
                                               |
                                               v
                                         format_match_report
```

`collect_candidate_identifiers` either preserves the names/URLs explicitly
provided by the user or makes the single existing LLM suggestion call. Name to
URL resolution then runs as bounded workers. `merge_and_dedupe_hosts` validates
resolved URLs, removes duplicate hosts, and applies the 12-candidate cap before
any homepage or scoring request begins.

Each scoring worker:

```text
validate candidate
  -> fetch homepage with bounded HTTP retry
  -> deterministic extraction
  -> one structured LLM score
  -> return CandidateScore or typed terminal failure
```

Resolution and scoring workers are created dynamically. Both stages default to
concurrency four, the candidate pool remains capped at 12, and final display
remains capped at 8. This changes simultaneous load, not the number of
candidates considered.

Successful candidates remain available when other candidates fail. The final
report records how many candidates were considered, scored, omitted, and
failed without exposing internal exception text.

### 8.4 Standalone skill subgraph

```text
prepare_target
  |
  +-- URL/entity unavailable --> run_ungrounded_skill
  |
  v
discover_lightweight_company_context
  |
  v
stream_skill_output
  |
  v
build_standalone_report
```

Research, qualification, contacts, and outreach retain their current prompts,
grounding behavior, and streamed Markdown. They share one subgraph parameterized
by the validated skill enum; they do not become autonomous agents.

## 9. URL-fetch reliability prerequisite

The URL layer remains ordinary TypeScript and must be hardened before graph
nodes depend on retry classifications.

### 9.1 Response-size enforcement

- Track received bytes as each chunk arrives.
- Stop reading and destroy the request once the byte limit is exceeded.
- Do not buffer the entire body and truncate afterward.
- Accept only expected textual/HTML content types, with a documented fallback
  for sites that omit the header.
- Keep the existing redirect-hop validation and DNS/IP pinning on every attempt.

### 9.2 Selective retry

Use a maximum of three network attempts across all URL variants for one target.
Redirect hops do not reset the attempt budget.

Retry:

- temporary DNS failure such as `EAI_AGAIN`;
- connection reset or socket timeout;
- HTTP 408, 429, 500, 502, 503, and 504;
- another already-validated public IP returned for the same hostname when the
  first address cannot be reached.

Do not retry:

- invalid or unsupported URLs;
- SSRF/private-address rejection;
- permanent DNS failure;
- HTTP 400, 401, 403, or 404;
- certificate validation failure;
- excessive redirects;
- user cancellation.

Backoff starts near 300 ms, grows exponentially, includes jitter, and respects
`Retry-After` only up to a bounded delay. Waiting must be abortable. A candidate
worker has an overall deadline so URL variants and retries cannot multiply into
unbounded latency.

### 9.3 Failure representation

Network code throws typed errors internally. User-facing progress receives a
localized category such as timeout, unavailable website, blocked automated
access, invalid domain, or temporary provider failure. Raw URLs may be shown;
raw exception messages, IP addresses, headers, and response bodies are not.

## 10. LLM retry and structured-output policy

### 10.1 Retryable LLM failures

- request timeout before user-visible tokens are emitted;
- rate limiting;
- HTTP 500, 502, 503, or 504;
- transient connection failure;
- invalid structured output, at most one repair/retry attempt.

### 10.2 Non-retryable LLM failures

- invalid API key or permission failure;
- unsupported model or endpoint configuration;
- user cancellation;
- a streamed response after visible tokens have already been emitted.

Retries must never duplicate streamed output. Structured calls can retry before
their result is committed to state. Streaming calls can retry only before the
first token is forwarded to the browser.

Node retry does not replace schema validation. All router, subagent, candidate,
and synthesis results continue to pass through their Zod schemas.

## 11. Progress, streaming, and localization

### 11.1 Wire compatibility

The initial migration keeps the existing SSE event union:

- `phase`;
- `agent`;
- `token`;
- `report`;
- `error`.

The browser does not need to understand LangGraph event types. A server adapter
maps graph updates, model messages, and custom events into `ChatEvent` frames.

### 11.2 Localized progress invariant

- `understand_request` establishes the latest-message language and complete
  runtime label set before downstream progress is emitted.
- Every node emits internal identifiers but resolves user-visible text through
  `runtimeLabels`.
- Product names, company names, URLs, enum values, and numbers are not
  translated.
- Scraped website language never overrides the latest user-message language.
- On a follow-up, the latest explicit location overrides earlier locations.
- If routing fails, the workflow retries once; after exhaustion it uses the
  most recent conversation language when available, otherwise the existing
  English recovery labels.

### 11.3 Progress lifecycle

Each node produces one start and one terminal state. Candidate and analysis
workers produce independent running/done/failed progress. Retried attempts
update a single progress item rather than adding misleading duplicate workers.

## 12. Cancellation, Stop, and later resume

### 12.1 Initial behavior

The existing Stop button continues to abort the browser request. The same
signal reaches the graph runtime and every active HTTP/LLM operation. Backoff
waits and pending workers also stop. Cancellation produces no generic failure
banner and the browser persists the visible partial exchange as it does today.

### 12.2 Required cancellation rules

- Nodes check cancellation before starting expensive work.
- HTTP and LLM adapters receive the caller signal.
- A reducer does not convert cancellation into a candidate failure.
- No new node begins after cancellation is observed.
- The SSE controller closes once and ignores late writes.

### 12.3 Durable resume decision gate

Resume after refresh is not part of the initial migration because the current
server is stateless and conversations are browser-only. Adding a LangGraph
checkpointer would persist product context, company findings, progress, and
reports outside IndexedDB.

Before durable mode is approved, decide:

1. whether the app is guaranteed local/self-hosted or can be remotely hosted;
2. whether server-side SQLite checkpoints are acceptable;
3. how a browser proves ownership of a checkpoint without user accounts;
4. checkpoint retention and deletion behavior;
5. whether raw discovery excerpts may be persisted;
6. how deployment runtime limits affect paused and resumed work.

If approved for a local-only deployment, the recommended option is a
LangGraph SQLite checkpointer keyed by a conversation/run UUID created before
the request. Deleting a browser conversation must call a matching server
deletion endpoint. API keys and raw request headers remain excluded. Remote
deployment requires authentication and a production durable store; a UUID by
itself is not authorization.

## 13. Human review extension

After durable checkpoint ownership is approved, add an interrupt between
candidate resolution and scoring:

```text
Resolve candidates
  -> save checkpoint
  -> interrupt with candidate names and URLs
  -> user adds/removes/selects candidates
  -> validate resumed input
  -> score selected candidates
```

This reduces wasted LLM calls and lets users reject incorrect guessed domains.
It is more valuable than allowing an agent to choose tools autonomously.

The interrupt payload contains display-safe candidate data only. Resume input
is untrusted and must be validated against a dedicated Zod schema before it
updates graph state.

## 14. Security and privacy

### 14.1 Required invariants

- Preserve protocol, hostname, DNS, redirect, and public-IP SSRF validation.
- Revalidate every retry and redirect; never reuse an unvalidated redirect
  target.
- Enforce response byte limits while streaming.
- Treat scraped text as untrusted data, never as model instructions.
- Add an explicit shared prompt rule that website text, metadata, JSON-LD, and
  candidate content cannot change system instructions or invoke tools.
- Continue Zod validation after every structured LLM response.
- Keep deterministic scores authoritative where the current product promises
  deterministic scoring.
- Never serialize API keys, authorization headers, abort signals, callbacks,
  pinned IP addresses, or raw provider errors into graph state.
- Keep server logs free of prompts, scraped bodies, API keys, and complete
  checkpoint state.
- Preserve bounded message history and prompt character budgets.

### 14.2 Checkpoint-safe state

Although initial execution has no durable checkpointer, graph state is designed
as if it could later be persisted. Store bounded extracted fields and evidence
excerpts rather than raw response objects. Any future checkpoint serializer
must pass an explicit secret-field and size audit.

## 15. Performance and cost controls

- Keep the maximum candidate pool at 12 and displayed result limit at 8.
- Default candidate-worker concurrency to four.
- Keep the five fixed prospect analyses parallel.
- Bound subpage discovery to the current six page categories.
- Preserve current homepage, page, and synthesis character budgets.
- Do not retry deterministic parsing, scoring, or formatting functions.
- Record retry count and stage timing without recording content.
- Do not add an orchestration LLM call; routing remains the only top-level
  semantic decision.
- Graph conversion must not increase successful-path LLM call count.

## 16. Proposed source structure

```text
src/lib/workflow/
├── constants.ts          # Node names, statuses, limits, and internal event IDs
├── state.ts              # Top-level and subgraph state schemas/reducers
├── context.ts            # Non-persisted runtime context types
├── errors.ts             # Typed retry/cancellation/failure classification
├── events.ts             # Graph update to ChatEvent mapping
├── graph.ts              # Compiled top-level graph
├── prospect.ts           # Prospect subgraph and nodes
├── match.ts              # Match subgraph and dynamic candidate workers
└── standalone.ts         # Plain chat and standalone skill subgraphs
```

Existing modules retain their current responsibilities:

```text
src/lib/llm.ts                     # Provider calls and streaming
src/lib/extract/fetch-page.ts      # Secure HTTP, redirects, retry, byte limits
src/lib/extract/*                  # Deterministic extraction
src/lib/scoring/*                  # Deterministic scoring
src/lib/skills/subagents.ts        # Analysis definitions and prompts
src/lib/skills/match.ts            # Match helpers and report rendering
src/lib/agent/schemas.ts           # LLM and SSE Zod contracts
src/lib/localization.ts            # Runtime labels and language invariants
```

During migration, orchestration code moves out of `agent/orchestrator.ts`,
`skills/match.ts`, and `api/chat/route.ts`; pure discovery, parsing, scoring,
and rendering helpers remain in their established modules. New methods and
functions follow the project's JSDoc, type-safety, and constants rules.

## 17. Dependency rules

```text
app/api/chat/route.ts
  -> workflow/graph.ts
  -> workflow subgraphs
  -> existing skills/extract/scoring/llm modules
```

- Workflow modules may depend on business helpers.
- Business helpers must not import the workflow graph.
- React/browser storage must not be imported by server workflow modules.
- LLM and fetch modules must not depend on LangGraph state types.
- Node-name and internal status strings belong in workflow constants.
- No circular dependency between schemas, localization, and workflow modules.

## 18. Implementation sequence

### Phase 1: reliability prerequisites

1. Add typed workflow/network error classifications without changing visible
   behavior.
2. Enforce the HTML byte limit during response streaming.
3. Add bounded selective URL retry across validated variants.
4. Add abortable backoff and cancellation tests.
5. Add explicit untrusted-web-content instructions to every prompt that
   receives scraped data.
6. Preserve existing return shapes for current callers.

**Exit condition:** URL fetching remains SSRF-safe, cancellations remain
immediate, temporary failures can be distinguished from permanent failures,
and oversized responses cannot be fully buffered.

### Phase 2: behavior-parity LangGraph migration

1. Add compatible `@langchain/langgraph` and `@langchain/core` dependencies
   and lock them in `package-lock.json`.
2. Define top-level state, runtime context, reducers, node constants, and graph
   event mapping.
3. Move router invocation into `understand_request` and move target resolution
   into the selected subgraph.
4. Wrap plain chat and standalone skills without changing prompts or output.
5. Build the prospect subgraph around existing discovery, analysis, scoring,
   synthesis, and rendering helpers.
6. Build the match subgraph around existing candidate resolution, scoring,
   ranking, and rendering helpers.
7. Replace the API route's skill `if/else` orchestration with graph streaming.
8. Preserve the current SSE and `ReportState` contracts.
9. Remove only orchestration code made unreachable by the graph migration.

**Exit condition:** every existing request type produces the same user-visible
behavior, report shape, localization, partial-failure semantics, and stop
behavior through the graph.

### Phase 3: graph-native reliability

1. Replace candidate-resolution and candidate-scoring `Promise` fan-out with
   separate dynamic graph workers and reducer-based collection.
2. Bound both candidate resolution and candidate scoring concurrency at four.
3. Apply retry policies to structured LLM nodes.
4. Preserve completed workers when another worker exhausts retries.
5. Stream node lifecycle and retry status through the existing localized
   progress UI.
6. Add per-stage timing and retry-count diagnostics without content logging.

**Exit condition:** one temporary candidate or analysis failure can be retried
without repeating unrelated successful work within the same run.

### Phase 4: documentation and local delivery

1. Update `Prospect Copilot/README.md` with the graph architecture, retry
   behavior, and unchanged privacy/storage boundary.
2. Update the top-level `README.md` if the implementation is later committed,
   as required by repository policy.
3. Perform focused type-check, unit-test, build, cancellation, streaming, and
   browser smoke checks during the authorized testing phase.

### Separately approved future phase: durable runs and interrupts

1. Approve checkpoint ownership, authentication, retention, and deletion.
2. Add a supported durable checkpointer.
3. Create and send conversation/run IDs before execution.
4. Add resume/discard APIs and UI.
5. Add candidate-review interruption.
6. Test replay and idempotency so completed LLM calls are not repeated.

## 19. Test design for the later testing phase

No tests are run while producing this design. Implementation approval includes
the normal focused testing and local build continuation.

### 19.1 Unit tests

- State reducers merge parallel analysis and candidate results without loss.
- Routing conditions select every supported subgraph.
- Missing product routes to localized clarification.
- URL retry includes only approved transient errors and respects the attempt
  budget.
- Backoff stops immediately on cancellation.
- Response-size enforcement aborts before unbounded buffering.
- LLM retry does not retry authentication, configuration, or cancellation
  failures.
- Structured-output retry is bounded.
- Secret fields cannot be serialized into graph state.
- Scraped-content prompts contain the untrusted-data boundary.

### 19.2 Subgraph tests

- Prospect fan-out always reaches five terminal worker outcomes.
- One failed analysis produces a degraded score and useful report.
- Synthesis failure retains successful analysis findings.
- Match fan-out respects the candidate pool and result limits.
- Candidate workers merge in deterministic final rank order regardless of
  completion order.
- One failed candidate does not remove successful candidates.
- Buy and sell paths use the same report/card structure with direction-specific
  semantics.

### 19.3 API and streaming tests

- Existing SSE events remain schema-valid.
- Plain chat tokens stream incrementally.
- Graph phase and worker events map to localized progress.
- Stop aborts routing, backoff, fetches, workers, and LLM calls.
- Cancellation emits no misleading request-failed message.
- Report events remain compatible with stored conversations.

### 19.4 Regression scenarios

- Chinese natural-language sell request without a fixed format.
- French buy request with a referenced product from conversation history.
- Arabic request with an explicit region.
- English location-only follow-up that replaces the prior location.
- Named candidate list containing one invalid and several valid websites.
- Website that returns a temporary 503 and then succeeds.
- Website that returns a permanent 403 and is not retried.
- Full prospect audit with one failed subagent.
- Conversation switch and refresh after a completed report.
- Selectable/copyable card content and clickable company URL.

## 20. Acceptance criteria

### Functional compatibility

- Every existing skill remains reachable from the same natural-language forms.
- Users never need to use a required prompt template for buy or sell matching.
- The latest user-message language controls all user-visible output.
- Explicit location works for both buy and sell directions.
- Company names and URLs are preserved rather than translated.
- Match cards retain full company names, clickable URLs, selectable content,
  scores, descriptions, fit reasons, location, and founding date when known.
- Completed cards and reports still survive conversation switches and refresh.
- Stop still cancels active work immediately.
- Markdown reports retain structured rendering.

### Reliability

- Temporary URL and provider failures receive bounded retries.
- Permanent, blocked, invalid, and cancelled requests are not retried.
- Candidate concurrency is bounded without reducing candidate coverage.
- Partial candidate and analysis success remains visible.
- Oversized HTTP responses cannot be buffered without limit.
- Graph conversion does not increase successful-path LLM calls.

### Security and privacy

- Existing SSRF tests and redirect/DNS protections continue to pass.
- Scraped content is explicitly treated as untrusted prompt data.
- API keys and authorization headers never appear in state, events, reports,
  checkpoints, or logs.
- Initial implementation adds no server-side persistent user-data store.
- Browser IndexedDB remains the sole conversation/report store.

### Maintainability

- The API route no longer contains skill-specific workflow orchestration.
- Each workflow is represented by one top-level subgraph.
- Graph state and runtime-only context have separate types.
- Parallel merge behavior is explicit through reducers.
- New workflow files follow project JSDoc, string-constant, and strict typing
  rules with no `any`.

## 21. Rollout and rollback

### Rollout

1. Land reliability prerequisites independently of graph behavior.
2. Introduce the graph behind one internal server entry point; do not expose a
   second user-facing mode.
3. Establish parity before deleting old orchestration paths.
4. Enable dynamic workers and node retries only after parity checks pass.
5. Keep durable persistence disabled until separately approved.

### Rollback

- Reliability changes remain independently usable if graph migration is
  reverted.
- During parity development, keep existing pure helpers unchanged so the API
  route can temporarily return to direct orchestration.
- Do not maintain two long-term production orchestrators; remove the old path
  after the graph path completes approved testing.
- Browser conversation data requires no migration because wire/report types
  remain unchanged.

## 22. Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Graph adds abstraction without user benefit | Maintenance cost | Require retry, concurrency, and event improvements in addition to topology conversion |
| Retry duplicates streamed output | Confusing responses | Retry streaming calls only before the first emitted token |
| Checkpoint captures secrets | Credential exposure | Keep secrets in runtime context and test serialized state |
| Parallel updates overwrite each other | Missing results | Use keyed reducers and deterministic merges |
| Candidate fan-out hits provider limits | Partial reports | Default concurrency four plus bounded retry |
| Graph state becomes too large | Memory/checkpoint cost | Persist bounded briefing fields, not raw response objects |
| Website prompt injection influences analysis | Incorrect or unsafe output | Treat all scraped content as untrusted data in system prompts |
| LangGraph is assumed to bypass serverless limits | Incomplete runs | Keep request deadlines; require a compatible durable runtime for future background work |
| Behavior changes during migration | Regression | Preserve SSE/report contracts and establish parity before graph-native enhancements |

## 23. Decision gates

The initial implementation can proceed after approval of this design. It does
not require a persistence decision.

The following features require a second explicit design decision:

- resume after refresh or server restart;
- switching away while a run continues in the background;
- candidate-review interrupts;
- checkpoint history/time travel;
- server-side run deletion and retention.

That decision must specify deployment model, authentication, checkpoint store,
privacy wording, retention, and deletion semantics.

## 24. Requirements traceability

| Requirement | Design location |
| --- | --- |
| Natural buy/sell language without fixed format | Sections 2, 11, 20 |
| Arbitrary-language responses, cards, and logs | Sections 3, 11, 20 |
| Explicit location in both directions | Sections 2, 7, 20 |
| More reliable URL processing | Sections 9, 10, 18 |
| Full company name and clickable/copyable card content | Sections 2, 20 |
| Stop processing at any time | Section 12 |
| Structured readable reports | Sections 2, 11, 20 |
| Cards survive refresh and conversation switching | Sections 2, 20 |
| Retry temporary URL failures | Sections 9, 18, 20 |
| Graph review advantages | Sections 5, 6, 8, 13 |
| Partial failure and bounded concurrency | Sections 8, 10, 15 |
| Privacy-preserving initial migration | Sections 7, 12, 14, 20 |
| Future resume and human review | Sections 12, 13, 23 |

## 25. Reference documentation

- [LangGraph.js overview](https://docs.langchain.com/oss/javascript/langgraph/overview)
- [Graph API](https://docs.langchain.com/oss/javascript/langgraph/graph-api)
- [Workflows and dynamic workers](https://docs.langchain.com/oss/javascript/langgraph/workflows-agents)
- [Streaming](https://docs.langchain.com/oss/javascript/langgraph/streaming)
- [Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts)
- [Checkpointers](https://docs.langchain.com/oss/javascript/langgraph/checkpointers)
- [Thinking in LangGraph](https://docs.langchain.com/oss/javascript/langgraph/thinking-in-langgraph)

## 26. Design approval

Approval authorizes implementation of Phases 1 through 4, followed by the
normal focused tests, production build, and local browser checks. It does not
authorize durable server persistence, background processing, LangChain agents,
Git commits, pushes, deployment, or the separately gated future phase.
