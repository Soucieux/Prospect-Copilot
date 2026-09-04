/**
 * Shared client-side chat types - used by the page and the
 * IndexedDB conversation store. The wire-carried shapes are inferred from
 * their Zod schemas so the validator and the rendered type cannot diverge.
 */

import type { z } from "zod";
import type {
  MATCH_CANDIDATE_SCHEMA,
  REPORT_STATE_SCHEMA,
} from "@/lib/agent/schemas";

export interface ProgressEvent {
  kind: "phase" | "agent";
  label: string;
  detail: string;
  status?: "running" | "done" | "failed";
  score?: number;
}

export type MatchCandidate = z.infer<typeof MATCH_CANDIDATE_SCHEMA>;

export type ReportState = z.infer<typeof REPORT_STATE_SCHEMA>;

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  progress?: ProgressEvent[];
  report?: ReportState;
}
