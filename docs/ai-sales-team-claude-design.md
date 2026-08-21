# AI Sales Team for Claude Code — Design Document

> Reverse-engineered architecture and design reference for
> [`zubair-trabzada/ai-sales-team-claude`](https://github.com/zubair-trabzada/ai-sales-team-claude),
> based on a full scan of the repository (README, install/uninstall scripts, 1 orchestrator skill,
> 13 sub-skills, 5 subagents, 4 Python scripts, and 6 output templates).
> MIT licensed, © 2026 Zubair Trabzada.

---

## 1. Purpose and Scope

AI Sales Team is a **prompt/skill-based extension for Claude Code**, not a standalone application.
It has no server, no database, and no build system — it is a curated set of Markdown "skill"
instructions and small Python helper scripts that get copied into `~/.claude/skills/` and
`~/.claude/agents/` so that Claude Code's slash-command router (`/sales ...`) can pick them up.

Its job: turn Claude Code into a CLI-based sales-intelligence tool that researches a prospect
company, qualifies the lead (BANT + MEDDIC), maps the buying committee, drafts outreach,
preps for meetings, drafts proposals, and rolls everything up into a pipeline report — all from
public web data, written to Markdown files in the user's working directory.

---

## 2. High-Level Architecture

```
                              User types /sales <command> in Claude Code
                                              │
                                              ▼
                          ┌───────────────────────────────────────┐
                          │        sales/SKILL.md (Orchestrator)   │
                          │   Parses command → routes to sub-skill │
                          └───────────────────┬─────────────────────┘
                                              │
              ┌───────────────────────────────┼────────────────────────────────┐
              ▼                               ▼                                ▼
     /sales prospect <url>           /sales <individual command>       /sales report[-pdf]
     (flagship, multi-agent)         (13 standalone sub-skills)        (pipeline aggregator)
              │
              ▼
  ┌─────────────────────────────────────────────────────────────────────┐
  │  Phase 1: Discovery (sequential)                                     │
  │   - WebFetch homepage + up to 6 interior pages                       │
  │   - Detect company type (SaaS/Agency/Ecommerce/Enterprise/SMB/Startup)│
  │   - Run scripts/analyze_prospect.py for structured extraction        │
  │   - Compile a "Discovery Briefing" shared by all subagents           │
  └───────────────────────────────┬────────────────────────────────────┘
                                  ▼
  ┌─────────────────────────────────────────────────────────────────────┐
  │  Phase 2: Parallel Analysis — 5 subagents launched simultaneously    │
  │   sales-company (25%) │ sales-contacts (20%) │ sales-opportunity(20%)│
  │   sales-competitive (15%) │ sales-strategy (20%)                     │
  └───────────────────────────────┬────────────────────────────────────┘
                                  ▼
  ┌─────────────────────────────────────────────────────────────────────┐
  │  Phase 3: Synthesis (sequential)                                     │
  │   - Weighted composite Prospect Score (0-100)                        │
  │   - 3-tier action plan (24-48h / 1-2wk / 1-3mo)                      │
  │   - Ready-to-send first email                                        │
  │   - Confidence rating (subagent completion + data richness)          │
  └───────────────────────────────┬────────────────────────────────────┘
                                  ▼
                        PROSPECT-ANALYSIS.md written
                     to the current working directory
```

Every command follows the same contract: **read the working directory for prior analysis
files → do web research → score something 0–100 → write one Markdown file → print a condensed
terminal scorecard.** This makes the tool stateless between invocations (state lives in the
Markdown files on disk) and lets skills "cross-pollinate" simply by reading each other's output.

---

## 3. Repository Layout

```
ai-sales-team-claude/
├── sales/SKILL.md                 Orchestrator — routes all /sales <command> invocations
├── skills/                        13 standalone sub-skills, each also usable as a subagent
│   ├── sales-prospect/SKILL.md       Flagship: launches the 5-agent parallel audit
│   ├── sales-research/SKILL.md       Company research (8 dimensions) → COMPANY-RESEARCH.md
│   ├── sales-qualify/SKILL.md        BANT + MEDDIC → LEAD-QUALIFICATION.md
│   ├── sales-contacts/SKILL.md       Buying-committee mapping → DECISION-MAKERS.md
│   ├── sales-outreach/SKILL.md       5-email cold sequence → OUTREACH-SEQUENCE.md
│   ├── sales-followup/SKILL.md       Post-meeting/demo/proposal sequences → FOLLOWUP-SEQUENCE.md
│   ├── sales-prep/SKILL.md           Meeting brief → MEETING-PREP.md
│   ├── sales-proposal/SKILL.md       11-section client proposal → CLIENT-PROPOSAL.md
│   ├── sales-objections/SKILL.md     15 universal + industry objections → OBJECTION-PLAYBOOK.md
│   ├── sales-icp/SKILL.md            ICP builder → IDEAL-CUSTOMER-PROFILE.md
│   ├── sales-competitors/SKILL.md    Battle cards → COMPETITIVE-INTEL.md
│   ├── sales-report/SKILL.md         Aggregates all prospect files → SALES-REPORT.md
│   └── sales-report-pdf/SKILL.md     Renders SALES-REPORT.md → SALES-REPORT-<date>.pdf
├── agents/                        5 subagent definitions used by /sales prospect
│   ├── sales-company.md              Company Fit (25%) — mirrors skills/sales-research logic
│   ├── sales-contacts.md             Contact Access (20%) — mirrors skills/sales-contacts logic
│   ├── sales-opportunity.md          Opportunity Quality (20%) — mirrors skills/sales-qualify logic
│   ├── sales-competitive.md          Competitive Position (15%) — mirrors skills/sales-competitors
│   └── sales-strategy.md             Outreach Readiness (20%) — mirrors skills/sales-outreach logic
├── scripts/                       Stdlib-only Python 3 helpers (no third-party deps required)
│   ├── analyze_prospect.py           HTML scraper: tech stack, socials, team, pricing, contacts
│   ├── contact_finder.py             Leadership/team extractor with seniority + buying-role tagging
│   ├── lead_scorer.py                Deterministic BANT+MEDDIC scoring given a JSON signal blob
│   └── generate_pdf_report.py        ReportLab-based PDF renderer for the pipeline report
├── templates/                     Static Markdown templates (human-fillable, [PLACEHOLDER] style)
│   ├── outreach-cold.md              5-email cold framework (mirrors sales-outreach output shape)
│   ├── outreach-warm.md              3-email warm-intro framework
│   ├── outreach-referral.md          3-email referral framework
│   ├── meeting-prep.md               Meeting brief template
│   ├── proposal-template.md          11-section proposal template
│   └── objection-playbook.md         15 universal objections, LAER framework
├── install.sh                     Copies skills/agents/scripts/templates into ~/.claude/
├── uninstall.sh                   Removes them again (Python packages untouched)
├── requirements.txt               reportlab>=4.0, beautifulsoup4>=4.12, requests>=2.31 (all optional)
└── LICENSE                        MIT
```

**Design note:** `agents/*.md` and `skills/sales-{research,contacts,qualify,competitors,outreach}/SKILL.md`
are near-duplicates by design — each subagent file is a leaner, subagent-oriented rewrite of its
standalone skill counterpart (same scoring rubric, same output schema, tighter framing for
autonomous execution inside a parallel Task). `templates/*.md` are a third, even more static
layer: fill-in-the-blank versions of the same document shapes, intended as starting points for
manual editing rather than being generated by a skill run.

---

## 4. Command Surface

| Command | Skill file | Output | Standalone or Subagent |
|---|---|---|---|
| `/sales prospect <url>` | `skills/sales-prospect/SKILL.md` | `PROSPECT-ANALYSIS.md` | Orchestrates all 5 agents |
| `/sales quick <url>` | inline in `sales/SKILL.md` | terminal only (<30 lines) | No subagents — single WebFetch |
| `/sales research <url>` | `skills/sales-research/SKILL.md` | `COMPANY-RESEARCH.md` | Standalone or `sales-company` subagent |
| `/sales qualify <url>` | `skills/sales-qualify/SKILL.md` | `LEAD-QUALIFICATION.md` | Standalone or `sales-opportunity` subagent |
| `/sales contacts <url>` | `skills/sales-contacts/SKILL.md` | `DECISION-MAKERS.md` | Standalone or `sales-contacts` subagent |
| `/sales outreach <prospect>` | `skills/sales-outreach/SKILL.md` | `OUTREACH-SEQUENCE.md` | Standalone or `sales-strategy` subagent |
| `/sales followup <prospect>` | `skills/sales-followup/SKILL.md` | `FOLLOWUP-SEQUENCE.md` | Standalone only |
| `/sales prep <url>` | `skills/sales-prep/SKILL.md` | `MEETING-PREP.md` | Standalone only |
| `/sales proposal <client>` | `skills/sales-proposal/SKILL.md` | `CLIENT-PROPOSAL.md` | Standalone only |
| `/sales objections <topic>` | `skills/sales-objections/SKILL.md` | `OBJECTION-PLAYBOOK.md` | Standalone only |
| `/sales icp <description>` | `skills/sales-icp/SKILL.md` | `IDEAL-CUSTOMER-PROFILE.md` | Standalone only |
| `/sales competitors <url>` | `skills/sales-competitors/SKILL.md` | `COMPETITIVE-INTEL.md` | Standalone or `sales-competitive` subagent |
| `/sales report` | `skills/sales-report/SKILL.md` | `SALES-REPORT.md` | Standalone — scans cwd via Glob |
| `/sales report-pdf` | `skills/sales-report-pdf/SKILL.md` | `SALES-REPORT-<date>.pdf` | Standalone — shells out to `generate_pdf_report.py` |

All outputs default to the **current working directory** (no config file, no project root
detection beyond locating `scripts/generate_pdf_report.py` for the PDF path).

---

## 5. The `/sales prospect` Pipeline (Flagship Flow)

### 5.1 Phase 1 — Discovery (sequential, single agent)

1. `WebFetch` the homepage; on failure, retry with/without `www` and `http`/`https`; abort with
   an explicit error if nothing is reachable (never fabricate a report from zero data).
2. Fetch up to 6 interior pages: About, Team/Leadership, Pricing, Blog, Careers, Contact.
3. Classify **company type** — SaaS/Software, Agency/Services, E-commerce, Enterprise, SMB,
   Startup — using homepage/pricing/careers signals; this classification re-weights what each
   subagent focuses on.
4. Shell out to `python3 scripts/analyze_prospect.py --url <url> --output json` for structured
   extraction (tech stack signatures, JSON-LD people, social links, pricing tiers, contact info).
   If the script or Python 3 is unavailable, the skill degrades gracefully to manual
   WebFetch-only extraction and notes the gap in the final report.
5. Compile a single **Discovery Briefing** object (URL, company name/type/vertical, fetched page
   content, script output) that is handed identically to all 5 subagents — this is the only
   coupling between Phase 1 and Phase 2, and it exists specifically to avoid 5x redundant fetches.

### 5.2 Phase 2 — Parallel Analysis (5 subagents, `general-purpose`, launched simultaneously)

| Subagent | Skill it mirrors | Weight | Scores |
|---|---|---|---|
| `sales-company` | `skills/sales-research` | 25% | Size Fit, Industry Fit, Growth Trajectory, Tech Sophistication, Budget Signals (0–20 each) |
| `sales-contacts` | `skills/sales-contacts` | 20% | Decision Makers, Contact Info Accessibility, Personalization Anchors, Warm Paths (0–25 each) |
| `sales-opportunity` | `skills/sales-qualify` | 20% | BANT (Budget/Authority/Need/Timeline, 0–25 each) blended with MEDDIC completeness |
| `sales-competitive` | `skills/sales-competitors` | 15% | Solution Gaps, Switching Feasibility, Competitive Advantage, Positioning Clarity, Win Probability (0–10 each) |
| `sales-strategy` | `skills/sales-outreach` | 20% | Personalization Depth, Trigger Events, Channel Strategy, Message-Market Fit (0–25 each) |

Design invariant repeated in every subagent's "Important Rules" section: **never fabricate a
name, number, or claim** — absent data is reported as "Not publicly available" and lowers the
score rather than being guessed. Every factual line must carry a source (URL, page, or search
query) and a confidence tag (High/Medium/Low/Inferred).

### 5.3 Phase 3 — Synthesis (sequential)

```
Prospect Score = Company_Fit×0.25 + Contact_Access×0.20 + Opportunity_Quality×0.20
               + Competitive_Position×0.15 + Outreach_Readiness×0.20
```

| Score | Grade | Label | Action |
|---|---|---|---|
| 90–100 | A+ | Hot Lead | Prioritize immediately, multi-thread within 24h |
| 75–89 | A | Strong Prospect | Personalized outreach within 48h |
| 60–74 | B | Qualified Lead | Standard outreach sequence |
| 40–59 | C | Lukewarm | Nurture only, no hard sell |
| 0–39 | D | Poor Fit | Deprioritize |

Failure handling: any subagent that fails or times out gets a **neutral score of 50** for its
category (not zero — a missing dimension shouldn't be punished as a negative signal), the report
notes which category is degraded, and overall **confidence** drops one level
(High → Medium → Low → Very Low, based on how many of the 5 subagents completed and how much
public data existed).

Output: `PROSPECT-ANALYSIS.md` (fixed schema: header block → executive summary → snapshot table →
score breakdown → company profile → decision-maker map/org chart → BANT/MEDDIC → competitive
landscape → 3-tier action plan → ready-to-send first email) plus a terminal-only condensed
scorecard using Unicode block-bar rendering (`█`/`░`, 10 chars per bar).

---

## 6. Scoring Model Summary

The whole system is built on **five 0–100 scores that always roll up the same way** — this
consistency is what lets `/sales report` compare prospects that were analyzed by different
commands on different days.

| Score | Owner skill | Sub-dimensions | Formula |
|---|---|---|---|
| Company Fit | sales-research | Size / Industry / Growth / Tech / Budget (0–20 ×5) | sum |
| Contact Access | sales-contacts | Decision Makers / Contact Info / Personalization / Warm Paths (0–25 ×4) | sum |
| Opportunity Quality | sales-qualify | BANT (0–100) × 0.50 + MEDDIC completeness × 0.30 + Urgency modifier × 0.20 | weighted |
| Competitive Position | sales-competitors | Gaps / Switching / Advantage / Positioning / Win Prob (0–10 ×5 → ×10) | sum ×10 |
| Outreach Readiness | sales-outreach | Personalization / Triggers / Channel / Message Fit (0–25 ×4) | sum |
| **Prospect Score** | sales-prospect | weighted blend of the five above | 0.25/0.20/0.20/0.15/0.20 |

`scripts/lead_scorer.py` implements a **deterministic, code-based** version of the BANT+MEDDIC
half of this model (given a hand-shaped JSON signal blob — funding amount, employee count,
decision-makers found, pain points detected, etc.) so that scoring logic isn't purely
"prompt vibes." It is optional tooling the LLM can shell out to; the skills themselves also
define the rubric in prose so they can score correctly even if the script is unavailable.

---

## 7. Cross-Skill Integration (File-System-as-State)

There is no database or session object. Every skill's **first move** is to check the current
directory for sibling output files and read them instead of re-researching:

```
IDEAL-CUSTOMER-PROFILE.md ──► calibrates scoring in sales-company, sales-contacts,
                                sales-opportunity, sales-strategy, sales-competitive
PROSPECT-ANALYSIS.md ─┬─► sales-outreach, sales-prep, sales-proposal, sales-followup
COMPANY-RESEARCH.md  ─┤    (each reuses prior findings instead of re-fetching the site)
LEAD-QUALIFICATION.md ┤
DECISION-MAKERS.md    ┤
COMPETITIVE-INTEL.md  ┘
OUTREACH-SEQUENCE.md ──► sales-followup, sales-prep
                                │
                                ▼
              sales-report Globs **/PROSPECT-ANALYSIS.md (+ siblings)
              across the working tree → SALES-REPORT.md
                                │
                                ▼
              sales-report-pdf reads SALES-REPORT.md → JSON → generate_pdf_report.py
                                → SALES-REPORT-<date>.pdf
```

This means the *order* commands are run in changes their output quality but never breaks
anything — every skill has an explicit fallback path for "the file I'd like to reuse doesn't
exist yet, so I'll research from scratch."

---

## 8. Python Scripts

All four scripts are **stdlib-only except the PDF generator**, use `argparse`, and print a
single JSON object to stdout — they're designed to be invoked by the LLM via Bash and parsed,
not to be a real service.

| Script | Deps | Purpose | Notable techniques |
|---|---|---|---|
| `analyze_prospect.py` | stdlib only (`urllib`, `html.parser`, `re`) | Fetch homepage + 10 common subpages, extract company name/description/tech-stack/socials/team/pricing/contact/size signals | Custom `HTMLParser` subclass (`TagCollector`) that also parses JSON-LD; a `TECH_SIGNATURES` regex dict fingerprints ~16 tools (WordPress, Shopify, HubSpot, Segment, Stripe, etc.); SSL verification is disabled (`CERT_NONE`) to maximize fetch success against misconfigured sites |
| `contact_finder.py` | stdlib only | Crawl 9 team/leadership URL patterns, extract people via JSON-LD `Person`/`Organization`, HTML card patterns, and list patterns; classify each into seniority (C-Suite/VP/Director/Manager/IC), department, and predicted buying role | Three independent extraction heuristics (`extract_json_ld_people`, `extract_card_people`, `extract_list_people`) merged and deduplicated by lowercased name |
| `lead_scorer.py` | stdlib only | Deterministic BANT scoring (4×0–25) + MEDDIC completeness (6 dimensions, each a % of boolean/count signals present) + grade (A/B/C/D) + confidence (High/Med/Low from field-fill ratio) + a templated recommended action | Pure functions, CLI reads a JSON file or stdin, no network calls — this is the one script that could run fully offline/unit-tested |
| `generate_pdf_report.py` | `reportlab` | Renders `SALES-REPORT.md`'s extracted JSON into a 6-page branded PDF: cover with a hand-drawn circular score gauge (`Wedge`/`Circle` shapes), horizontal bar chart of category scores, prospect cards, pipeline summary table, action plan, methodology/grade-scale appendix | Custom `draw_score_gauge()` and `create_bar_chart()` built directly from `reportlab.graphics.shapes` rather than a charting library; includes a **demo mode** (`python3 generate_pdf_report.py` with no args) that renders a fully fake sample pipeline — useful for visually testing the PDF layout without running any real analysis |

None of the scripts require `beautifulsoup4` or `requests` despite `requirements.txt` listing
them — those are explicitly "optional, enhances parsing" per the README; the scraping is done
with regex and a hand-rolled `HTMLParser` so the tool works with zero pip installs beyond Python
3 itself. Only PDF export (`generate_pdf_report.py`) hard-requires `reportlab`.

---

## 9. Installation Model

`install.sh` (bash, `set -e`) supports two invocation modes:

1. **Local clone** — detects it's running from within a checked-out repo (`install.sh` +
   `skills/` sibling present) and installs directly from there.
2. **`curl | bash` remote** — `git clone --depth 1` into a `mktemp -d` scratch dir, installs from
   there, then removes the temp dir.

It copies (never symlinks) into:
- `~/.claude/skills/sales/SKILL.md` (+ `scripts/`, `templates/` subfolders)
- `~/.claude/skills/sales-<name>/SKILL.md` for each of the 13 sub-skills
- `~/.claude/agents/sales-<name>.md` for each of the 5 subagents

It's tolerant of partial installs (missing files just print a `⚠` and skip, non-fatal), checks
for `python3`/`reportlab`/`beautifulsoup4` and prints install hints rather than failing, and
prints a full command reference at the end. `uninstall.sh` mirrors it exactly (`rm -rf` each
skill dir, `rm -f` each agent file) and explicitly leaves pip packages installed.

There is **no version pinning, no update mechanism, and no manifest file** — re-running
`install.sh` simply overwrites what's there, which is the intended upgrade path.

---

## 10. Cross-Cutting Design Principles

These rules recur nearly verbatim across all 13 skill files and 5 agent files, and are the
closest thing this repo has to a style guide:

1. **Never fabricate.** Every name, title, revenue figure, or pain point must be evidence-backed
   or explicitly labeled "Not publicly available" / "Inferred" / "Unverified."
2. **Cite sources for every claim**, with freshness flags (e.g., "funding data from 2022 — may
   be stale").
3. **Score honestly** — a mediocre prospect gets a mediocre score; no grade inflation.
4. **Ready-to-use over theoretical** — outreach emails must be copy-paste ready with zero
   `[PLACEHOLDER]` brackets in *generated* output (the static `templates/` files are the
   intentional exception — they exist specifically as fill-in-the-blank starting points).
5. **One CTA per message, low-friction, framed as a question.**
6. **Be honest about competitors** — battle cards must list genuine competitor strengths;
   "bash the competitor" language is explicitly forbidden.
7. **Respectful breakup emails** — no guilt-tripping, no fake urgency, always leave the door open.
8. **Degrade gracefully, never fail silently on zero data** — if a URL is unreachable or a
   subagent errors, the skill still produces a report, but flags the gap and lowers confidence
   rather than either crashing or pretending the data exists.
9. **Read-before-research** — every skill checks the working directory for prior analysis files
   before re-fetching or re-searching the same ground.

---

## 11. Known Gaps / Things Not Implemented

Documenting what this repo does **not** do, since it's easy to assume more automation than
exists after reading the skill prose:

- No actual email sending, CRM integration, or LinkedIn automation — every "send" is a drafted
  Markdown block the human copies out.
- No persistent scoring history — re-running `/sales prospect` on the same URL simply overwrites
  `PROSPECT-ANALYSIS.md`; there's no diffing or trend tracking across runs.
- No authentication/secrets handling anywhere in the repo — it only ever touches public web pages.
- No test suite (unit or integration) for any of the four Python scripts.
- `lead_scorer.py` is defined but not directly invoked by any skill's documented step list — the
  skills describe the same BANT/MEDDIC rubric in prose and expect the LLM to apply it directly,
  making the script effectively optional/companion tooling rather than a hard dependency.
