# Prospect Copilot changelog

Every change to Prospect Copilot, newest first, in one shape: the summary from the history table, then what changed, what was checked and how it was delivered. The README's Change history table lists the newest 10 and links here.

<a id="history-strip"></a>

## History strip — 2026-10-06

- **Changelog:** The README's Change history opens with a history strip, `CHANGELOG.svg`, drawn from the changelog: the entries of every period as shaded cells, release months marked, and the span, total and version range beside them.

### Added

- **Strip:** a light card under the Change history heading shows how the entries spread over time.
  - One cell per period: the years before the last twelve months, then each month, shaded by how many entries it holds; an empty cell is a quiet month.
  - An orange pill under a month with releases carries how many it had, its latest version beneath, and a summary gives the span, the total and the version range.
- **Alternative text:** the image line states the span, the total, the busiest period, the longest quiet stretch and the version range, so the strip reads without the picture.

### Changed

- **Structure:** `CHANGELOG.svg` joins the structure table.
- **Scope:** Documentation only; the strip and its image line are generated, never edited by hand.

<a id="three-quick-links"></a>

## Three quick links — 2026-10-06

- **Layout:** The line of section links under the title now holds three quick links, Quick start, Architecture and Change history, in place of one for every section; the outline of the whole README is the one GitHub, Obsidian and Project Control provide.

### Changed

- **Why:** the line had grown to as many as fourteen links, drew the eye without saying where each led, and duplicated the outline every reader already has.
- **Line:** `Quick start · Architecture · Change history`, the same three in every project README: get going, see how it is built, see what changed.
- **Scope:** Documentation only.

<a id="readme-source-audit"></a>

## README checked against the source — 2026-10-06

- **Audit:** The test tooling gained a Build & Delivery table and its commands in Quick start, and the structure table lists `e2e/`, `docs/`, the contributor guide and the changelog.

### Changed

- **Why:** a check of the README against the source found Vitest, Playwright and the type check unmentioned, and four folder entries missing from the structure table.
- **Quick start:** `npm test`, `npm run test:coverage`, `npm run typecheck` and `npm run e2e` are described.
- **Architecture:** a Build & Delivery table for the Next.js build, Vitest, Playwright and the TypeScript compiler.
- **Structure:** `e2e/`, `docs/`, `CONTRIBUTING.md` and `CHANGELOG.md` join the table.
- **Scope:** Documentation only.

<a id="changelog"></a>

## Documentation — 2026-10-06

- **History:** The complete change history now lives in `CHANGELOG.md`, one entry per change with its summary, what changed, what was checked and how it was delivered; the README table keeps the newest ten rows and opens each entry from its Details cell.

### Changed

- **Why:** the README carried every record's details in one collapsed block, so a reader opened the table and then searched the block, and the details had no fixed shape.
- **Changelog:** `CHANGELOG.md` holds every record this project ever kept, newest first. An entry is its anchor, a dated heading, its summary bullets, then only the subsections it needs: Added, Changed, Fixed, Removed, Checked, Delivered.
- **Migration:** each earlier record's labelled bullets sit under Changed, its evidence under Checked and its status under Delivered; a record over the block limit became a lead with sub-points. Every statement was carried over; none was shortened.
- **README:** the Change history table keeps the newest ten rows, each Details cell opening its entry; the details block and the earlier-history list are gone, and every link into a record now reaches the changelog.
- **Scope:** Documentation only.

<a id="plan-documents-removed"></a>

## Plan documents removed — 2026-10-05

- **Cleanup:** Removed the three implemented plan documents under `docs/plans/`, which nothing linked to; the design document and the implementation plan stay.

### Changed

- **Why:** the three plans under `docs/plans/`, dated 21 to 23 August 2026, were implemented and nothing in the
  project linked to them any more.
- **Removed:** `2026-08-21-selling-context-auto-detect.md`, `2026-08-22-product-match-discovery.md` and
  `2026-08-23-langgraph-workflow-reliability-design.md`; Git history keeps them.
- **Kept:** `docs/ai-sales-team-claude-design.md` and `docs/implementation-plan.md`, which the README and the plan
  link to.
- **Scope:** Documentation only.

<a id="readme-alignment"></a>

## README aligned with the other projects — 2026-10-05

- **Alignment:** The badge row now opens with the platform and names the history mode; the four capability bullets left the Overview for a Capabilities section.

### Changed

- **Why:** every project README shares one structure; this one still lacked part of it.
- **Badges:** Platform, Next.js, History, React, Node and Models.
- **Capabilities:** the Prospects, Products, Results and Models bullets moved here from the Overview, which keeps the describing sentence and the origin.
- **Unchanged:** every sentence inside the sections that stayed; links to a moved part were updated.
- **Scope:** Documentation only.

<a id="readme-skeleton"></a>

## README sections in the shared order — 2026-10-05

- **Structure:** Sections follow the order and names every project README now shares, under a contents line; sections were renamed and moved, and no wording was removed.

### Changed

- **Why:** project READMEs named and ordered the same kinds of section differently, so setup, workflow and
  architecture sat in a different place in each.
- **Order:** the sections now run Overview, Quick start, Workflow, Architecture, Project structure, Limits, References, Contributing, Change history.
- **Renamed:** Setup is now Quick start, and How it works is Workflow.
- **Moved:**
  - Project layout left Workflow to become Project structure, after Architecture.
  - Privacy and result quality now sits under Limits, and Design reference under References.
- **Opening:** a contents line under the title links every section.
- **Unchanged:** every sentence, table, diagram and Project Control marker inside the sections; whole sections
  moved, and links to a renamed section were updated.
- **Scope:** Documentation only.

<a id="readme-structure"></a>

## README laid out as short points — 2026-10-05

- **Readability:** Long paragraphs, bullets and table cells are now short leads with sub-points, one fact each; no detail was removed.

### Changed

- **Why:** many records and some guidance ran as bullets or paragraphs of 50 to 100 words, which hid
  the separate facts inside them.
- **Layout:** every paragraph, bullet and table cell over 50 words is now a short lead with
  sub-points, one fact each. The wording was moved, not rewritten.
- **Unchanged:** every section, heading, link, anchor, table row, diagram, number and identifier.
- **Scope:** Documentation only; no source or dependency changed.

### Checked

- **Evidence:** compared with the previous version, no word is removed, and the headings, anchors,
  links, code spans, numbers and fenced samples are identical. The README layout, link and history
  checks pass.

<a id="next-og-advisory-cleared"></a>

## Next.js image-generation advisory cleared — 2026-09-30

- **Security:** Cleared a critical Next.js advisory published on 2026-09-30: image generation through `next/og` could run attacker-supplied code.
- **Version:** Next.js 16.3.6; no other package moves.
- **Exposure:** None found: the app does not use `next/og`.
- **Tests:** 448 unit tests, the coverage gate, the type check, the production build, and 57 end-to-end runs pass.

### Changed

- **What was reported:** `npm audit` found one critical advisory against Next.js 16.3.3 on the
  day it was published. The Node.js `ImageResponse` from `next/og` could run attacker-supplied
  code when untrusted values reach the SVG it renders (GHSA-vcvr-r3jv-pc5j); it affects 16.2.0
  through 16.3.5.
- **Exposure:** none found. The project never imports `next/og` or `ImageResponse`, and its
  browser icon is the static `src/app/icon.png`, not a generated image route.
- **Fix:**
  - `next` moves to 16.3.6, its first patched release, with `@next/env` and the platform compiler
    packages at the same version.
  - The manifest's caret range now starts at 16.3.6 and the lockfile pins it; nothing else moves.
  - The lockfile was updated with npm 11, and `npm ci` with npm 10 installs it.
- **Unchanged:** `agentRules: false`, application behavior, model requests, browser storage, and
  external access.

### Checked

- **Evidence:** `npm audit` reports no vulnerabilities. The type check, the 448 unit tests, the
  coverage gate, the production build, and the 57 end-to-end runs across Chromium, Firefox, and
  WebKit pass.

### Delivered

- **Status:** delivered uncommitted with local checks, then committed as `e75781a`. Not deployed.

<a id="undici-advisory-cleared"></a>

## undici advisory cleared — 2026-09-30

- **Security:** Cleared the medium advisory GitHub reported against undici, the HTTP client cheerio depends on: a hostile WebSocket server could crash the Node.js process.
- **Version:** undici 7.29.1, within the range cheerio declares; no other package moves.
- **Exposure:** None found: the app hands cheerio HTML it fetched itself and never opens a WebSocket.
- **Tests:** 448 unit tests, the coverage gate, the type check, the production build, and 57 end-to-end runs pass.

### Changed

- **What was reported:** one medium advisory against the lockfile. undici 7.29.0 let a WebSocket
  server crash the whole Node.js process with a compressed message that passes the decompression
  size limit and then carries a malformed block (GHSA-3wwx-pv8p-q78v, CVE-2026-85024).
- **Where it comes from:**
  - `cheerio` 1.2.0 is the only package that depends on undici, through the range `^7.19.0`.
  - Cheerio uses undici's HTTP client only in `fromURL`, which this project never calls: the
    project's own fetcher downloads every page and hands the HTML to `cheerio.load`.
  - Nothing in the project opens a WebSocket, so the crash was not reachable here.
- **Fix:** the lockfile pins undici 7.29.1, the first patched 7.x release and within cheerio's
  range. The manifest is unchanged and no other package moves.
- **Unchanged:** `agentRules: false`, application behavior, model requests, browser storage, and
  external access.

### Checked

- **Evidence:** `npm ci` installs the new version against its published checksum and `npm ls`
  shows undici 7.29.1 under cheerio. The type check, the 448 unit tests, the coverage gate, the
  production build, and the 57 end-to-end runs across Chromium, Firefox, and WebKit pass.

### Delivered

- **Status:** delivered uncommitted with local checks, then committed as `7e5e7fc`. Not deployed.

<a id="shared-page-parse-and-error-pages"></a>

## Shared page parsing and error-page handling — 2026-09-26

- **Reliability:** An error page (404, 500, and the like) is no longer read as company evidence; a page that fails is left out of the briefing.
- **Scoring:** Competitive Position stays at the neutral 50 until you say what you sell, decided in code rather than left to the model, and the synthesis reads the same scores the report table shows.
- **Structure:** Each fetched page is parsed once and shared by every extractor; one definition names the progress phases, worker states and skill names; scoring is keyed by category so translations cannot drift; the match stages share one request object; the retry helpers no longer depend on the model adapter.
- **Social links:** A LinkedIn or social link written with a capitalised scheme is no longer mangled in the report.
- **Tests:** 448 unit tests, the coverage gate, the type check, the production build, and 57 end-to-end runs pass.

### Changed

- **Error pages:**
  - the secure fetcher now treats any status of 400 or above as a failure.
  - Before, the text of a 404 or 500 page could reach the analysis workers as company evidence; now
    a failed homepage stops the audit through the existing error path, and a failed subpage is
    simply absent from the briefing.
  - Temporary statuses (408, 429 and the 5xx family) are still retried, honouring `Retry-After`.
- **Neutral Competitive Position:** when no product has been mentioned, the composite scorer sets
  Competitive Position to the neutral 50 itself instead of relying on the worker to do so, and the
  synthesis writer is given the same effective scores the breakdown table shows.
- **One parse per page:**
  - the homepage and each subpage are parsed once and handed to the extractor, the contact finder,
    and the text converter in that order, instead of being parsed three times.
  - The pricing-page detector and subpage discovery share one word list, so the "has pricing page"
    flag and the fetched pricing page can no longer disagree.
- **Consistent labels:** scores are keyed by category and their display names come from the same
  translation table the progress log uses; the match cards' English fallbacks and the audit request
  a card sends come from that table too, and a company URL containing `$&` is no longer mangled in
  that request.
- **Shared definitions:**
  - the progress phases, worker states, skill names, and chat-history turn shape each have one
    definition in the schemas, and the worker-progress templates are keyed by that status list;
    - the product-context prompt markers and the shared evidence rules live in the constants module;
    - the match stages consume one request object instead of nine positional arguments;
    - the company-URL rules have their own module;
    - the retry helpers no longer import the model adapter, which owns its own retry policy;
    - the router node's retry budget and failure classification are read from that one policy;
    - and the adapter no longer carries a second request timeout beside the app's own deadline.
- **Social links:** a LinkedIn or social href written with a capitalised scheme (`HTTPS://…`) was
  turned into `https://HTTPS://…` in the report; the scheme is now recognised in any case.
- **Removed:** the unused workflow statuses, the per-worker weight copies (the prompts now quote
  the scorer's weights), the separate score-label module, and JSON-mode plumbing no call used.
- **Coverage floors:** raised to what the suite now measures, as the ratchet rule requires: 85%
  of statements and 84% of branches overall, 95% of statements in `src/lib`, 92% in `extract`,
  100% in `scoring`, 97% in `skills` and the chat endpoint, and 66% of branches in `workflow`.

### Checked

- **Tests:**
  - new tests cover the backoff and abort helpers, the shared-document contract between the
    extractors, the company-URL rules, error-status handling, the neutral Competitive Position rule,
    the match request object, and capitalised social-link schemes.
  - 448 unit tests, the coverage gate, the type check, the production build, and the 57 end-to-end
    runs pass.

### Delivered

- **Status:** delivered uncommitted with local checks, then committed as `4510c63`. Not deployed.

<a id="aligned-project-icon"></a>

## Aligned project icon — 2026-09-26

- **Icon:** Redrew the project icon in the macOS icon shape at the standard size; the icon Next.js serves and the project folder's icon come from the same master.

### Changed

- **Icon:** `Resources/ProspectCopilotIcon.png` keeps the same artwork, made full-bleed and clipped
  to the rounded square macOS draws for app icons, 824 of 1024 pixels, so it has the standard macOS
  outline and size.
- **Web icon:** `src/app/icon.png`, the 256-pixel icon Next.js serves, was regenerated from the new
  master, and the project folder's Finder icon was set from the same master.
- **Behavior:** unchanged.

### Checked

- **Checks:** both files were compared with the new master at their own sizes. The production build
  and test suites were not rerun, because no code or configuration changed.

<a id="failed-worker-scoring-tests"></a>

## Failed-worker scoring tests — 2026-09-23

- **Tests:** Prospect scoring is now tested when analysis workers fail: any one of them, the one that reports hiring and pain signals, or all five.
- **Behavior:** Unchanged; the tests pin what a failed worker already did.

### Changed

- **Gap:** no unit test covered what prospect scoring does when an analysis worker fails, although
  a provider error or a rejected response can leave any of the five without a result.
- **Behavior:** unchanged. The tests pin what a failed worker already did, and each fails when a
  failed worker is instead scored as 0.

### Checked

- **Tests:**
  - three cases in `src/lib/agent/orchestrator.test.ts`.
  - One failed worker scores its category at the neutral 50, marks it degraded, keeps the other
    four, and lowers confidence from High to Medium.
  - A failed Opportunity Scoring worker leaves Need and Timeline to page evidence and lowers MEDDIC
    completeness, since its hiring and pain signals never arrive.
  - With all five failed, the composite is a neutral 50, grade C, at Very Low confidence, while
    Budget still comes from the pricing page.
- **Evidence:** 397 unit tests and the coverage gate pass; the type check is clean.

<a id="dependency-advisories-cleared"></a>

## Dependency advisories cleared — 2026-09-23

- **Security:** Cleared the five dependency advisories GitHub reported — two critical in Next.js, one high in sharp, and two medium in Vitest.
- **Versions:** Next.js 16.3.3, sharp 0.35.4, and Vitest with its coverage provider 4.1.11.
- **Coverage:** Vitest 4 counts branches differently, so three coverage floors were re-measured; all 394 unit tests and 57 end-to-end runs pass.

### Changed

- **What was reported:**
  - five open advisories against the lockfile.
  - Next.js 16.3.2 carried two critical ones: unauthenticated remote code execution through the
    image optimization API when AVIF files are used (GHSA-2xp9-vwfh-vxw4), and remote code execution
    on Windows-hosted servers (GHSA-p293-qw3h-jr36). sharp 0.35.3 carried a high one in its bundled
    libheif (GHSA-rgj7-g3m4-5g8c).
  - Vitest and `@vitest/mocker` 3.2.7 carried a medium path traversal through a redirect mock
    (GHSA-82fw-gwwq-j7x9).
- **Fix:**
  - each moves to its first patched release: `next` 16.3.3; `sharp` 0.35.4 with libvips 1.3.3,
    within the range Next.js already declares; and `vitest` with `@vitest/coverage-v8` 4.1.11.
  - The manifest keeps its caret ranges, and the lockfile pins those versions.
  - No Vitest 3 release carries the fix, so this is a major upgrade: Vite moves from 7 to 8
    underneath it, and 113 packages only Vitest 3 used leave the lockfile, including the deprecated
    `glob` 10.
- **Coverage floors:**
  - Vitest 4 reads branches from the syntax tree, so every `??`, `?.`, implicit `else`, and default
    value now counts, including those in functions no unit test runs.
  - The same tests therefore measure lower: overall branches 82% instead of 91%, and the workflow
    scope 52% instead of 98%, where every missed branch sits in a node body that calls the graph
    runtime and the model.
  - The failing floors were set to the new measurements — overall branches 82 and functions 78,
    `src/lib/*.ts` statements 94 and branches 80, workflow branches 52 — and the others are
    unchanged.
  - The finer count also shows one untested path: the orchestrator's handling of an analysis worker
    that failed.
- **Installing:** `npm ci` works with npm 10 and 11. Changing dependencies with npm 10.9.8 fails
  while it resolves Vitest 4's optional peers ("Cannot read properties of null"), so this lockfile
  was updated with npm 11.
- **Unchanged:** `agentRules: false`, application behavior, model requests, browser storage, and
  external access.

### Checked

- **Evidence:** `npm audit` reports no vulnerabilities. Typecheck, the 394 unit tests, the coverage
  gate, the production build, and the 57 end-to-end runs across Chromium, Firefox, and WebKit pass.

### Delivered

- **Status:** delivered uncommitted with local checks, then committed as `7380191`. Not deployed.

<a id="prospect-copilot-project-icon"></a>

## Project identity icon — 2026-09-22 to 2026-09-23

- **Identity:** Added the selected evidence-dossier icon with one consistent rounded-square silhouette; its full-size master lives in `Resources/`.
- **Browser:** Next.js serves a 256-pixel copy through its App Router icon convention.
- **Finder:** The project folder mirrors the full-size master without changing workflows or data handling.

### Changed

- Added the selected 1,024-pixel evidence-dossier artwork at `Resources/ProspectCopilotIcon.png`.
  The dossier, magnifying lens, evidence signals, and qualification gauge represent the project's
  research-first sales workflow. A transparent rounded-square mask gives every use the same outer
  silhouette without redrawing the approved artwork.
- A 256-pixel copy at `src/app/icon.png` is the browser icon, which Next.js exposes through its App
  Router icon convention. The master stays outside `src/app/` because every `icon` file there
  becomes a served icon. The Finder folder uses the master's pixels through ignored macOS
  custom-icon metadata.
- This presentation change does not alter model requests, scoring, browser storage, external access,
  or deployment status.

<a id="soucieux-proprietary-license"></a>

## Proprietary license notice — 2026-09-13

- **License:** Added the approved Soucieux proprietary-software notice.

### Changed

- Added the approved Soucieux proprietary-software notice, reserving rights in original project
  materials while retaining third-party license terms.
- Documentation only; application behavior, dependencies, builds, deployment, and publication
  status are unchanged.

<a id="standalone-contributor-guide"></a>

## Standalone contributor guide — 2026-09-11

- **Contributing:** Added a standalone project guide for the canonical workspace and public subtree.
- **Links:** Removed README dependencies on parent-only repository files.
- **Repository:** Added a feature-first public GitHub description.

### Changed

- Added `CONTRIBUTING.md` with Prospect Copilot's public framework, privacy, security, evidence,
  testing, and dated-history boundaries.
- Changed the README's contributor and history-policy links to paths inside this project, so the
  canonical subtree and standalone public repository can keep identical files without broken
  parent links.
- Kept the canonical workspace's root instructions and scoped internal procedure authoritative for
  its workflow; no parent-repository instruction file is copied into the standalone subtree.
- Set the public GitHub repository description to a feature-first summary of the multilingual BYOK
  sales research, qualification, contact discovery, outreach, and buyer/seller matching workflow.

### Delivered

- **Status:** Documentation only. Application behavior, dependencies, builds, deployment, and
  publication evidence are unchanged by these source files.

<a id="readme-organization"></a>

## README organization — 2026-09-06

- **Structure:** User guide first; one history table.
- **Rules:** Scoped contributor guidance under AGENTS.

### Changed

- **Structure:** Put purpose, capabilities, setup, architecture, and workflows before history.
- **History:** Merge matching repository-origin records into the owning change; preserve unique detail, evidence, and older links.
- **Ownership:** Keep user documentation here; route scoped contributor rules through root AGENTS.

### Delivered

- **Status:** Documentation changes only; initially delivered uncommitted and recorded in `3a5bd2c`. Existing application versions, artifacts, and deployment state are unchanged.

<a id="readability-maintenance"></a>

## Reorganized long paragraphs and table cells without dropping details — 2026-09-06

- **Change:** Reorganized long paragraphs and table cells without dropping details.

### Changed

- Reorganized long paragraphs and table cells without dropping details; consolidated imported history tables into indexes linked to complete readable records.
- Preserved existing destinations and README section mappings.
- Documentation only; no application or release artifact changed.

### Delivered

Local documentation changes; initially delivered uncommitted and recorded in this documentation commit.

<a id="readme-consolidation"></a>

## Moved complete project descriptions, register details, and repository-origin history into this README — 2026-09-06

- **Change:** Moved complete project descriptions, register details, and repository-origin history into this README.

### Changed

- Moved complete project descriptions, register details, and repository-origin history into this README; retained existing content, dates, release/build identifiers, Git evidence, and app-content mappings.
- Project guardrails now load through the root instructions only for this project.
- This is documentation maintenance; no application code, build, release, or deployment changed.

### Delivered

Local documentation update; initially delivered uncommitted and recorded in `3a5bd2c`

<a id="contact-deduplication-key"></a>

## Contact deduplication key and documentation corrections — 2026-09-05

- **Change:** Corrected the cross-page contact deduplication key, removed two duplicated test helpers, completed stranded documentation blocks, corrected three documents, and restored per-file formatting conventions.

### Changed

- Cross-page contact deduplication used a weaker key than the extractor that produces the contacts - `findContacts` collapses whitespace before comparing names, while the orchestrator compared `name.toLowerCase()` alone, so one person listed as "Jane  Doe" on the team page and "Jane Doe" on the about page reached the decision-maker table twice;
- both levels now share the one exported key.
- The strict-index-checking record below had misstated every branch figure it quoted:
  - re-measured at the commit before the flag and at the commit that added it, covered branches rose from 931 of 1,020 to 934 of 1,028, not from 929 of 1,017 to 933 of 1,027,
  - and those numbers are corrected in place.
- Two duplications were removed -
  - the end-to-end harness re-declared three localStorage keys `constants.ts` already exports, so a rename would have desynced the suite from the app silently,
  - and the router tests carried a second `resolveCompanyUrl` block duplicating two cases a later block already covered, together with the stub helper that existed only to serve it.
- Three documentation blocks describing exported label constants had been stranded above interfaces introduced beside them, leaving each constant undocumented, and `normalizeName` documented only half of what its body does now that it is public.
- Three documents were corrected: the sole undated plan in `docs/` described a superseded stack with nothing marking it historical, a design document announced three implementation stages and then listed four, and one line carried trailing whitespace.
- Formatting returned to each file's own convention where it had drifted - a 114-line JSX subtree indented flat with its parent, the one unwrapped `emit` in a file where every sibling wraps, a condition split across three lines that fits in 53 characters, and two misindented argument blocks.
- Three tests closed the rate limiter's two unreached `x-real-ip` branches. 394 unit tests, 57 end-to-end runs, typecheck, and the production build pass.

### Delivered

- **Status:** Verified by 394 unit tests behind per-directory coverage floors and 19 end-to-end
  specs run across Chromium, Firefox, and WebKit against the production build; typecheck and build
  pass.

`d223981`, `0582311`, `0babff6`, `ddd4314`, `073819c`, `552c25e`, `f8966bb`

<a id="strict-index-checking"></a>

## Turned on strict index checking (noUncheckedIndexedAccess) and resolved the 103 errors it raised, which exposed two defects that reading alone had not — 2026-09-05

- **Change:** Turned on strict index checking (noUncheckedIndexedAccess) and resolved the 103 errors it raised, which exposed two defects that reading alone had not.

### Changed

- Turned on strict index checking (`noUncheckedIndexedAccess`) and resolved the 103 errors it raised, which exposed two defects that reading alone had not.
- The two report label sets were typed `Record<string, string>`, a type that guarantees no key exists, while the renderers read sixteen and sixty keys off them by name;
- an absent label would have reached the page as the text "undefined" or failed the report outright.
- Both are now declared interfaces, the prospect one generated from its own literal so no key could be mistyped, and the synthesis labels are completed where they are consumed rather than trusted from their producer - which immediately caught two tests passing incomplete label sets, one of them empty.
- The five subagents and their settled results were also walked by array index in three places, two of them in opposite directions, each trusting the other array's length with nothing enforcing it;
- a single pairing helper beside the subagent definitions replaced all three.
- Remaining index reads were corrected at their own level: regex capture groups now narrow before use, fragment stripping uses the URL API instead of splitting on a hash, and provably-safe reads name their value rather than asserting it.
- Removed two pieces of dead code: a phone-number extraction that ran a loose regex over every fetched page and was read by nothing, and an unreachable cancellation branch whose guard had already thrown.
- The branch coverage floor moved from 91 to 90 because the new guards are unreachable by construction and count toward the denominator - covered branches rose from 931 to 934 while the total rose from 1,020 to 1,028. 393 tests, 57 end-to-end runs, typecheck, and the production build pass.

### Delivered

`65fe5b8`, `813c100`, `b558f39`, `23fb64b`, `7ca21e5`

<a id="end-to-end-suite-and-coverage-gate"></a>

## Made the end-to-end suite actually run and turned coverage from a number into a gate — 2026-09-04

- **Change:** Made the end-to-end suite actually run and turned coverage from a number into a gate.

### Changed

- Made the end-to-end suite actually run and turned coverage from a number into a gate.
- The specs had been failing on a 403 for every script bundle, which an earlier note recorded as a sandbox limitation;
- it was not one.
- The dev server's cross-origin guard rejects any request carrying an `Origin` header for a host outside its allowlist, and `127.0.0.1` is not on it - `curl` passed only because it sends no such header.

Pointing the suite at `localhost` fixed it, and the suite now builds and serves the production app instead of the dev server, so no dev-only guard is in play at all.

- Running the specs then exposed a real defect:
  - settings were persisted from an effect that ran on mount before the stored values had loaded,
  - so every page load wrote the empty defaults over the saved record and React's development double-invoke made the loss permanent -
  - a stored API key was erased on reload.
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
- Three tests now drive a page that publishes nothing and a contact carrying a LinkedIn but no job title,
  - asserting the briefing reads "Not publicly available", "none found", and "title unknown" instead of leaking undefined,
  - and that the report title falls back to the page URL when the company is never named.
- That file reached 100% of statements, branches, and functions.
- The coverage floors were also re-grounded: they had been justified against an external 80% target that this repository does not adopt, and now state plainly that they are a regression ratchet, with AGENTS.md's per-behaviour success criteria as the actual standard.
  - 343 unit tests, 57 end-to-end runs, typecheck, and the production build pass;
- branch coverage is 90%.
- A final sweep closed the untested decisions in the six files where branch coverage still lagged, after an earlier claim that every decision was exercised proved wrong: 104 branches were unreached.
- The SSE reader now handles a keep-alive comment, a malformed frame, an event split across two network chunks, a token carrying no text, an unrecognized agent status, and an unknown event type - it went from 74% to 97% of branches.
- The router's company-URL filter, quoting, "unknown" answer and provider-failure path, the report renderers' location and truncation variants, the prospect report's missing-company, no-contacts, failed-subagent and untranslatable-category fallbacks, the retry helper's no-signal paths, and the provider error classifier's status, cancellation and structured-output branches are all now covered.
- Two dead defensive branches were identified rather than tested around:
  - the SSE reader's frame-buffer fallback cannot be reached because a split always yields an element,
  - and the delay helper's already-aborted check cannot be reached because its guard throws first -
  - and that guard throws synchronously from a function typed as returning a promise, which the tests now record.

Branch coverage rose from 90% to 91% overall with every targeted file above 87%, on 393 unit tests.

### Delivered

`3be35ff`, `6b1b599`, `8e6c6bb`, `e9333c2`

<a id="dated-history-declaration"></a>

## Declared Prospect Copilot's dated-history mode and linked it to the centralized repository policy — 2026-09-02

- **Change:** Declared Prospect Copilot's dated-history mode and linked it to the centralized repository policy.

### Changed

Declared Prospect Copilot's dated-history mode and linked it to the centralized repository policy. Runtime behavior, dependencies, deployment status, and project numbering remain unchanged.

### Delivered

This documentation commit

<a id="port-restriction-and-shared-helpers"></a>

## Port restriction, wire validation, and shared helpers — 2026-09-02

- **Change:** Restricted page fetching to web ports, validated the report at the wire boundary, replaced unchecked type assertions, corrected MEDDIC renewal timing, added request rate limiting and a separate API-key record, shared duplicated helpers, and added coverage measurement with an end-to-end suite.

### Changed

- Restricted the page fetcher to ports 80 and 443 on the initial URL and every redirect hop, closing an arbitrary-port probe against public hosts.
- Made the report schema the single definition of its shape and validated the report event at the wire boundary instead of casting it.
- Replaced every unchecked type assertion on nullable or external data:
  - graph-stage reads now fail loudly and name the broken ordering,
  - the agent status and skill name narrow instead of asserting,
  - and settings restored from browser storage are validated field by field before the API key they carry is sent as a request header.

Corrected MEDDIC so a distant contract renewal reads as looked-for-and-absent rather than as evidence. Bounded extracted emails and the briefing sent to the five parallel workers.

- Removed superseded code: the pre-workflow routing and match entry points, two unreachable helpers, and a dead parameter, redirecting their tests onto the live paths.
- Gave prospect signals, report construction, the retryable-status set, markdown rendering, and the SSE reader single owners, which also took the orchestrator from 977 to 613 lines and the match skill from 891 to 665.
- Corrected a protocol-relative LinkedIn href that rendered as a malformed four-slash URL in the decision-maker table, matching the handling the homepage extractor already had.
- Completed 36 missing JSDoc blocks, named the three buying-role patterns alongside the file's other patterns, removed an unreachable fallback, replaced duplicated literals with named constants, removed an unused catch binding, corrected a stale comment, and aligned the root layout with project style.
- Added request rate limiting to the chat endpoint,
  - moved the stored API key into its own browser record so nothing that reads or exports the settings can carry the credential with it,
  - migrated any key already saved in the previous combined record,
  - moved settings persistence out of the page into a testable module,
  - made nine internal symbols private,
  - named the remaining scoring thresholds,
  - and added unit tests for eleven previously untested logic modules.
- Shared the absolute-URL rule, the JSON-LD node scan, routed-target resolution, and the per-worker progress emitter that had each been written twice;
- centralized the remaining SSE phase names and scoring thresholds; and collected page anchors once instead of three times per analysis.
- Added coverage measurement and an end-to-end suite: installed a version-matched coverage provider, scoped it to code that holds logic, and closed the one real gap it exposed by testing the standalone skill runner, which had no coverage at all.
- Added Playwright with six specs covering the empty state, the missing-key guard, token streaming, report rendering, server-error recovery, and proof that the stored settings record never contains the API key.
  - 257 tests, typecheck, and the production build pass; measured coverage is 75% of statements overall and 93% across the logic-bearing library modules.

### Delivered

`57c0d28`, `6943732`, `13648bf`, `6ee368e`, `c441b44`, `0e3905e`, `da8c374`

<a id="commit-history-reconciliation"></a>

## Reconciled all 49 retained project commits with the repository summary — 2026-08-31

- **Change:** Reconciled all 49 retained project commits with the repository summary.

### Changed

- Reconciled all 49 retained project commits with the repository summary.
- Removed the installed Next.js package's nested agent-instruction file; the version-specific guidance remains above and root AGENTS.md governs development.
- No runtime or release-number change.
- Backfilled dated history across all 49 project commits, without inventing release/build numbering.
- Preserved Next.js guidance in the project README while removing its installed special-name instruction copy.
- No runtime change.

### Delivered

This documentation commit

`9db9f38`

<a id="architecture-inventory"></a>

## Added and categorized the source-backed architecture inventory — 2026-08-31

- **Change:** Added and categorized the source-backed architecture inventory.

### Changed

- Added and categorized the source-backed architecture inventory, then separated each technology/concept into its own row and mapped README sections for Project Control.
- Documentation only; no runtime, dependency, or deployment change.

Grouped architecture into AI, frontend, backend logic, storage, and integration tables without runtime or dependency changes.

- Added an architecture table covering LangGraph, LangChain, hosted model calls, evidence acquisition, scoring, matching, browser storage, and the retrieval boundary.
- No runtime or dependency changes.

### Delivered

`a575bee`, `b42d8c3`

<a id="scoring-documentation-and-layout-table"></a>

## Documented evidenced scoring and team-page contacts, corrected the composite-score/BANT/MEDDIC distinction, and added the source-layout table — 2026-08-29

- **Change:** Documented evidenced scoring and team-page contacts, corrected the composite-score/BANT/MEDDIC distinction, and added the source-layout table.

### Changed

- Documented evidenced scoring and team-page contacts, corrected the composite-score/BANT/MEDDIC distinction, and added the source-layout table.
- Disabled Next.js-generated agent-rule files while keeping its version-specific development guidance in the README.
- Corrected both READMEs' scoring description: the weighted 0-100 composite is blended from the five
  subagent category scores alone, while BANT and MEDDIC are reported beside it as separate
  diagnostics that carry no weight in it.
- Documented the MEDDIC grading rule, the evidenced-signal boundary between model and deterministic
  code, and the current contact-extraction behaviour.
- Added a project layout table naming each source directory's responsibility, and moved the scoring
  rationale out of the numbered pipeline list into its own section.

### Delivered

`24e473c`, `937bac2`, `a94d299`

<a id="team-page-contact-extraction"></a>

## Shared label merging — 2026-08-28

- **Change:** Shared label merging.

### Changed

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

### Delivered

`1596467`, `cb836eb`, `5f82270`, `ccd528a`, `0c11419`, `177d443`

<a id="langgraph-workflow-migration"></a>

## Upgraded the runtime/dependencies and integrated LangChain model adapters and typed LangGraph request/subgraphs — 2026-08-23

- **Change:** Upgraded the runtime/dependencies and integrated LangChain model adapters and typed LangGraph request/subgraphs.

### Changed

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

### Delivered

`9697622`, `8e7419a`, `1d9a2ab`, `027ffac`, `dd4c729`, `4cb8b07`, `d6fa476`, `11f8d83`, `9ec9bb1`, `e94a38e`, `e617cff`, `67602a7`, `a4e739d`

<a id="product-match-skill"></a>

## Introduced match schemas, routing, bounded candidate scoring, ranked reports, and selectable company cards — 2026-08-22

- **Change:** Introduced match schemas, routing, bounded candidate scoring, ranked reports, and selectable company cards.

### Changed

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

### Delivered

- `b8805a0`, `6b7d0f5`, `e1d780a`, `7640876`, `da888a2`, `a47bc6b`, `14851d6`, `2adfd92`, `ffc5c33`, `8cb3db9`, `8638c1d`, `888354a`, `10a7eca`, `b576772`, `af85fce`, `1cc1823`, `f272cb2`, `4efd866`, `d2384f9`

<a id="initial-application"></a>

## Introduced the standalone BYOK prospect-audit application and four research skills — 2026-08-21

- **Change:** Introduced the standalone BYOK prospect-audit application and four research skills.

### Changed

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
- Consolidated duplicated JSON-extraction logic into shared helpers, named constants, and a shared
  prop-type interface.
  - Git reconciliation: Introduced the standalone BYOK prospect-audit application and four research
    skills.
  - Switched the default provider to DeepSeek and repaired settings/sidebar behavior.
  - Hardened the initial pipeline and JSON extraction, added focused coverage, and detected selling
    context from the conversation for scoring and reports.

### Delivered

`b1a79ca`, `03e0265`, `37ec568`, `8ca9e2f`, `796ed07`, `da28979`
