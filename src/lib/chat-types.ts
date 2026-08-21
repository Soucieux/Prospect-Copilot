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

export interface ReportState {
  kind: "prospect" | "research" | "qualify" | "contacts" | "outreach";
  companyName: string;
  url: string | null;
  score: number | null;
  grade: string | null;
  confidence: string | null;
  categories: { category: string; score: number; weight: number }[] | null;
  markdown: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  progress?: ProgressEvent[];
  report?: ReportState;
}
