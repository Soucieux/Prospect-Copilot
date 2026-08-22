/**
 * Shared client-side chat types - used by the page and the
 * IndexedDB conversation store.
 */

export interface ProgressEvent {
  kind: "phase" | "agent";
  label: string;
  detail: string;
  status?: "running" | "done" | "failed";
  score?: number;
}

export interface MatchCandidate {
  url: string;
  companyName: string;
  score: number;
  description: string;
  fitReason: string;
  location: string | null;
  founded: string | null;
}

export interface ReportState {
  kind: "prospect" | "research" | "qualify" | "contacts" | "outreach" | "match";
  companyName: string;
  url: string | null;
  score: number | null;
  grade: string | null;
  confidence: string | null;
  categories: { category: string; score: number; weight: number }[] | null;
  /** Populated only for kind "match": the ranked candidates to render as cards. */
  matches: MatchCandidate[] | null;
  markdown: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  progress?: ProgressEvent[];
  report?: ReportState;
}
