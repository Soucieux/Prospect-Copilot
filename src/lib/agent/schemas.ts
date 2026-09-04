/**
 * Zod schemas: the LLM JSON contract for subagents and the SSE wire
 * events streamed from /api/chat to the browser.
 */

import { z } from "zod";

/** Confidence tag every factual finding must carry. */
const CONFIDENCE_VALUES = ["High", "Medium", "Low", "Inferred"] as const;

/** Structured output every analysis subagent must return. */
export const SUBAGENT_RESULT_SCHEMA = z.object({
  score: z.number().min(0).max(100),
  summary: z.string().min(1),
  findings: z
    .array(
      z.object({
        claim: z.string().min(1),
        evidence: z.string().min(1),
        confidence: z.enum(CONFIDENCE_VALUES),
      }),
    )
    .max(12),
  recommendation: z.string().min(1),
  /**
   * Evidence-backed discovery signals the deterministic scorers cannot read
   * off a page themselves. Only the Opportunity Scoring subagent is asked for
   * these; every field stays optional so an absent signal scores as unknown
   * rather than as a zero the model invented.
   */
  discoverySignals: z
    .object({
      painPointsDetected: z.number().int().min(0).max(20).optional(),
      activeJobPostings: z.number().int().min(0).max(1_000).optional(),
      recentFundingWithin12Months: z.boolean().optional(),
      fundingTotalUsd: z.number().min(0).optional(),
    })
    .optional(),
});

export type SubagentResult = z.infer<typeof SUBAGENT_RESULT_SCHEMA>;

/** Intent classification output for the skill router. */
export const ROUTER_RESULT_SCHEMA = z.object({
  skill: z.enum([
    "prospect",
    "research",
    "qualify",
    "contacts",
    "outreach",
    "match",
    "none",
  ]),
  url: z.string().nullable(),
  entity: z.string().nullable(),
  /** The product/ICP relevant to the current buy or sell request. */
  sellingContext: z.string().nullable(),
  /** Whether match candidates should buy the product or sell it to the user. */
  matchDirection: z
    .enum(["sell", "buy"])
    .nullish()
    .default("sell")
    .transform((direction) => direction ?? "sell"),
  /** Explicit city, region, or country requested for matching; null otherwise. */
  matchLocation: z.string().trim().min(1).nullable().default(null),
  /** Companies explicitly named as match candidates, verbatim; null otherwise. */
  candidates: z.array(z.string()).nullable(),
  /** Language recognized from the latest user message, not scraped content. */
  language: z.string().min(1).default("English"),
  /** Partial translations of app-authored runtime labels. */
  runtimeLabels: z.record(z.string(), z.string()).default({}),
});

export type RouterResult = z.infer<typeof ROUTER_RESULT_SCHEMA>;
export type MatchDirection = RouterResult["matchDirection"];

/** Synthesis call output: the narrative parts of the final report. */
export const SYNTHESIS_SCHEMA = z.object({
  executiveSummary: z.string().min(1),
  actionPlan: z.object({
    immediate: z.array(z.string()).min(1).max(5),
    shortTerm: z.array(z.string()).min(1).max(5),
    longTerm: z.array(z.string()).min(1).max(3),
  }),
  firstEmail: z.object({
    to: z.string().min(1),
    subjectA: z.string().min(1),
    subjectB: z.string().min(1),
    body: z.string().min(1),
    cta: z.string().min(1),
  }),
  /** Localized names and evidence for the four deterministic BANT rows. */
  bantTranslations: z
    .array(
      z.object({
        name: z.string().min(1),
        evidence: z.string().min(1),
      }),
    )
    .length(4)
    .optional(),
  /** The report's static section labels, translated to the user's language. */
  labels: z.record(z.string(), z.string()).optional(),
});

export type SynthesisResult = z.infer<typeof SYNTHESIS_SCHEMA>;

/** One ranked match candidate rendered as a card. */
export const MATCH_CANDIDATE_SCHEMA = z.object({
  url: z.string(),
  companyName: z.string(),
  score: z.number(),
  description: z.string(),
  fitReason: z.string(),
  location: z.string().nullable(),
  founded: z.string().nullable(),
});

/**
 * The report payload, and the single definition of its shape: `ReportState`
 * in chat-types is inferred from this, so the wire validator and the type the
 * page renders can never drift apart.
 */
export const REPORT_STATE_SCHEMA = z.object({
  kind: z.enum([
    "prospect",
    "research",
    "qualify",
    "contacts",
    "outreach",
    "match",
  ]),
  companyName: z.string(),
  url: z.string().nullable(),
  // Standalone skills deliver a document without a numeric scorecard.
  score: z.number().nullable(),
  grade: z.string().nullable(),
  confidence: z.string().nullable(),
  categories: z
    .array(
      z.object({
        category: z.string(),
        score: z.number(),
        weight: z.number(),
      }),
    )
    .nullable(),
  /** Populated only for kind "match": the ranked candidates to render as cards. */
  matches: z.array(MATCH_CANDIDATE_SCHEMA).nullable(),
  /** Populated only for kind "match": localized card chrome labels. */
  matchLabels: z
    .object({
      founded: z.string(),
      fit: z.string(),
      auditHint: z.string(),
      auditRequestTemplate: z.string(),
    })
    .nullable(),
  /** Localized labels used by the report summary card. */
  scoreLabels: z.object({
    grade: z.string(),
    confidence: z.string(),
    confidenceValue: z.string(),
    report: z.string(),
  }),
  markdown: z.string(),
});

/** SSE wire events (discriminated by `type`). */
export const CHAT_EVENT_SCHEMA = z.discriminatedUnion("type", [
  z.object({ type: z.literal("phase"), phase: z.string(), detail: z.string() }),
  z.object({
    type: z.literal("agent"),
    agent: z.string(),
    detail: z.string(),
    status: z.enum(["running", "done", "failed"]),
    score: z.number().optional(),
  }),
  z.object({ type: z.literal("token"), text: z.string() }),
  z.object({ type: z.literal("report"), report: REPORT_STATE_SCHEMA }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);

export type ChatEvent = z.infer<typeof CHAT_EVENT_SCHEMA>;

/** Progress callback shared by every skill that streams SSE events. */
export type EmitCallback = (event: ChatEvent) => void;
