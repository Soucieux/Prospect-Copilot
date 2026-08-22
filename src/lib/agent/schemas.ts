/**
 * Zod schemas: the LLM JSON contract for subagents and the SSE wire
 * events streamed from /api/chat to the browser.
 */

import { z } from "zod";

/** Confidence tag every factual finding must carry. */
export const CONFIDENCE_VALUES = ["High", "Medium", "Low", "Inferred"] as const;

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
  /** The seller's product/ICP, when stated anywhere in the conversation. */
  sellingContext: z.string().nullable(),
  /** Companies explicitly named as match candidates, verbatim; null otherwise. */
  candidates: z.array(z.string()).nullable(),
});

export type RouterResult = z.infer<typeof ROUTER_RESULT_SCHEMA>;

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
});

export type SynthesisResult = z.infer<typeof SYNTHESIS_SCHEMA>;

/** SSE wire events (discriminated by `type`). */
export const CHAT_EVENT_SCHEMA = z.discriminatedUnion("type", [
  z.object({ type: z.literal("phase"), phase: z.string(), detail: z.string() }),
  z.object({
    type: z.literal("agent"),
    agent: z.string(),
    status: z.enum(["running", "done", "failed"]),
    score: z.number().optional(),
  }),
  z.object({ type: z.literal("token"), text: z.string() }),
  z.object({
    type: z.literal("report"),
    report: z.object({
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
      markdown: z.string(),
    }),
  }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);

export type ChatEvent = z.infer<typeof CHAT_EVENT_SCHEMA>;

/** Progress callback shared by every skill that streams SSE events. */
export type EmitCallback = (event: ChatEvent) => void;
