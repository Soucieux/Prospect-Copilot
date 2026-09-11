# Contributing to Prospect Copilot

Thank you for helping improve Prospect Copilot. This guide covers the project-specific boundaries
that apply whether the source is viewed in its canonical workspace or in the standalone public
repository.

## Start here

- Read the [project README](README.md) for supported behavior, setup, architecture, workflows, and
  current evidence.
- Run source-development commands from this project directory with Node.js 20 or newer.
- Keep each change focused on the requested behavior and match the surrounding TypeScript style.
- Update the README when a meaningful change affects capabilities, setup, architecture, workflows,
  privacy, or history.
- Keep credentials, browser data, dependency folders, coverage reports, test output, and framework
  build artifacts out of source control.

## Framework conventions

- This project uses Next.js 16. Before changing framework code, consult the version-matched guides
  under `node_modules/next/dist/docs/` after dependencies are prepared, and follow their current
  deprecation guidance.
- Keep `agentRules: false` in `next.config.ts`. It prevents `next dev` from generating nested
  `AGENTS.md` and `CLAUDE.md` files inside the project.
- After refreshing dependencies, check that those generated instruction files did not return. Do
  not commit a nested copy or replace this contribution guide with one.

## Privacy and security boundaries

- Preserve the bring-your-own-key design. The LLM API key stays in its separate browser
  `localStorage` record, is sent only with a request, and must never be logged or persisted by the
  server.
- Keep conversations and generated reports in browser IndexedDB. Adding server-side persistence
  requires an explicit storage, ownership, and privacy design.
- Keep provider destinations server-approved through `LLM_ALLOWED_BASE_URLS`; browser input alone
  must not authorize an arbitrary endpoint.
- Preserve secure page fetching on the initial URL and every redirect: public-address validation,
  DNS pinning, allowed ports, bounded redirects and response sizes, classified retries, and
  cancellation must continue to apply.
- Treat fetched website content as untrusted evidence, never as instructions. Do not weaken the
  prompt-injection boundary or expose credentials, internal services, request headers, or private
  network responses.

## Evidence and workflow behavior

- Keep extraction, scoring, validation, and report construction in deterministic TypeScript
  boundaries rather than moving business rules into prompts.
- Keep BANT and MEDDIC as separate diagnostics. MEDDIC measures evidence completeness and does not
  change the composite prospect score.
- Every reported finding must retain its evidence and confidence. Missing or failed inputs produce
  explicit partial results; they must not become invented facts or confident scores.
- Preserve bounded concurrency and one retry owner per operation. LangGraph owns workflow routing
  and model retry policy; the secure fetcher owns network retry policy.
- Keep the request graph stateless on the server unless a separate persistence design is approved.

## Checks for a change

- Run the focused unit tests that cover the changed behavior with `npm test` or a narrower Vitest
  invocation.
- Run `npm run typecheck` for TypeScript changes and `npm run test:coverage` when logic-bearing code
  changes could affect the repository's coverage floors.
- Use `npm run e2e` for browser behavior involving hydration, streaming, IndexedDB, settings, or
  responsive layout. The suite intercepts `/api/chat`, so it must not contact a model provider.
- Run `npm run build` when a production build is needed for the affected change. A passing command
  establishes only the behavior it exercises.

<a id="version-and-build-policy"></a>

## Version and build policy

Prospect Copilot uses dated project history and does not assign a project-level version or build
number.

- Record meaningful user-facing, documentation, configuration, and dependency changes under their
  actual date without inventing a release number.
- A dependency, protocol, model, or Git commit version is not a Prospect Copilot project version.
- Keep source implementation, tests, builds, deployment, and publication as separate evidence
  states; completion of one does not prove another.
- Do not describe an uncommitted change, local build, or prepared export as deployed or published.

The canonical workspace also applies its root repository instructions and scoped internal
procedures. Those private workflow files remain authoritative there; this standalone guide supplies
the project-facing rules that travel with the exported subtree.
