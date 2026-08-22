"use client";

import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import Markdown from "react-markdown";
import {
  DEFAULT_LLM_BASE_URL,
  DEFAULT_LLM_MODEL,
  LLM_API_KEY_HEADER,
  LLM_BASE_URL_HEADER,
  LLM_MODEL_HEADER,
  SETTINGS_STORAGE_KEY,
} from "@/lib/constants";
import type {
  ChatMessage,
  MatchCandidate,
  ProgressEvent,
  ReportState,
} from "@/lib/chat-types";
import {
  createConversation,
  deleteConversation,
  listConversations,
  saveConversation,
  titleFromMessages,
  type StoredConversation,
} from "@/lib/storage/conversations";

interface Settings {
  baseUrl: string;
  model: string;
  apiKey: string;
}

const DEFAULT_SETTINGS: Settings = {
  baseUrl: DEFAULT_LLM_BASE_URL,
  model: DEFAULT_LLM_MODEL,
  apiKey: "",
};

/** Empty-state prompt cards, one per headline skill. */
const SUGGESTIONS: { title: string; example: string }[] = [
  {
    title: "Prospect audit",
    example: "analyze https://stripe.com as a prospect",
  },
  {
    title: "Company research",
    example: "research https://www.linear.app",
  },
  {
    title: "Find decision makers",
    example: "find decision makers at https://vercel.com",
  },
  {
    title: "Outreach sequence",
    example: "draft an outreach sequence for Acme Analytics",
  },
];

/**
 * The chat page: settings, conversation sidebar, message log, and composer.
 * @returns the root page component
 */
export default function Home() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversations, setConversations] = useState<StoredConversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<
    string | null
  >(null);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [error, setError] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  messagesRef.current = messages;

  useEffect(() => {
    listConversations()
      .then(setConversations)
      .catch(() => {
        // IndexedDB unavailable - persistence is silently disabled.
      });
  }, []);

  useEffect(() => {
    const stored = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as Partial<Settings>;
        setSettings({ ...DEFAULT_SETTINGS, ...parsed });
      } catch {
        // Corrupt settings fall back to defaults.
      }
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [messages]);

  /**
   * Apply a patch function to the trailing message in the conversation.
   * @param patch transform applied to the last message
   */
  const updateLast = useCallback(
    (patch: (message: ChatMessage) => ChatMessage): void => {
      setMessages((prev) => {
        if (prev.length === 0) return prev;
        const next = [...prev];
        next[next.length - 1] = patch(next[next.length - 1]);
        return next;
      });
    },
    [],
  );

  /**
   * Send a message to /api/chat and consume the event stream.
   * @param overrideText message to send instead of the composer's input,
   *   used when a match candidate card triggers a follow-up audit
   */
  async function send(overrideText?: string): Promise<void> {
    const text = (overrideText ?? input).trim();
    if (!text || isStreaming) return;
    if (!settings.apiKey) {
      setError("Add your DeepSeek API key in the settings bar first.");
      return;
    }
    setError("");
    setInput("");
    const history = messages.map(({ role, content }) => ({ role, content }));
    setMessages((prev) => [
      ...prev,
      { role: "user", content: text },
      { role: "assistant", content: "", progress: [] },
    ]);
    setIsStreaming(true);
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        [LLM_BASE_URL_HEADER]: settings.baseUrl,
        [LLM_API_KEY_HEADER]: settings.apiKey,
        [LLM_MODEL_HEADER]: settings.model,
      };
      const response = await fetch("/api/chat", {
        method: "POST",
        headers,
        body: JSON.stringify({ message: text, history }),
      });
      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => "");
        throw new Error(`/api/chat failed (${response.status}): ${detail}`);
      }
      await consumeStream(response.body, updateLast);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setIsStreaming(false);
      await persistCurrentExchange();
    }
  }

  /**
   * Persist the on-screen conversation to IndexedDB after an exchange,
   * creating the record on the first save.
   */
  async function persistCurrentExchange(): Promise<void> {
    const current = messagesRef.current;
    if (current.length < 2) return;
    const id = activeConversationId ?? createConversation().id;
    setActiveConversationId(id);
    const now = new Date().toISOString();
    const existing = conversations.find((item) => item.id === id);
    const record: StoredConversation = {
      id,
      title: titleFromMessages(current),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      messages: current,
    };
    try {
      await saveConversation(record);
      const stored = await listConversations();
      setConversations(stored);
    } catch {
      // Persistence is best-effort; the chat itself still works.
    }
  }

  /**
   * Open a stored conversation in the chat log.
   * @param conversation the conversation to load
   */
  function openConversation(conversation: StoredConversation): void {
    if (isStreaming) return;
    setActiveConversationId(conversation.id);
    setMessages(conversation.messages);
    setError("");
  }

  /**
   * Start a fresh, empty conversation.
   */
  function startNewConversation(): void {
    if (isStreaming) return;
    setActiveConversationId(null);
    setMessages([]);
    setError("");
  }

  /**
   * Delete a stored conversation after a confirmation prompt.
   * @param conversation the conversation to remove
   */
  async function removeConversation(
    conversation: StoredConversation,
  ): Promise<void> {
    if (!window.confirm(`Delete "${conversation.title}"?`)) return;
    await deleteConversation(conversation.id);
    setConversations((prev) =>
      prev.filter((item) => item.id !== conversation.id),
    );
    if (activeConversationId === conversation.id) startNewConversation();
  }

  return (
    <main className="app">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="sidebar-brand-dot" aria-hidden /> Prospect Copilot
        </div>
        <button className="new-chat-button" onClick={startNewConversation}>
          <span aria-hidden>＋</span> New chat
        </button>
        <ul className="conversation-list">
          {conversations.map((conversation) => (
            <li
              key={conversation.id}
              className={`conversation-item ${
                conversation.id === activeConversationId ? "active" : ""
              }`}
            >
              <button
                className="conversation-open"
                onClick={() => openConversation(conversation)}
                title={conversation.title}
              >
                {conversation.title}
              </button>
              <button
                className="conversation-delete"
                aria-label={`Delete ${conversation.title}`}
                onClick={() => void removeConversation(conversation)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        <div className="sidebar-footer">
          <button className="settings-toggle" onClick={() => setIsSettingsOpen(true)}>
            <span aria-hidden>⚙</span> Settings
            <span className="model-chip">{settings.model}</span>
          </button>
        </div>
      </aside>

      <div className="app-main">
      {error ? <div className="error-banner">{error}</div> : null}

      {messages.length === 0 ? (
        <div className="empty-state">
          <h2 className="empty-greeting">What can I help you sell today?</h2>
          <p className="empty-sub">
            Ask anything, or pick a sales skill - I&apos;ll route it
            automatically.
          </p>
          <div className="suggestions">
            {SUGGESTIONS.map((suggestion) => (
              <button
                key={suggestion.title}
                className="suggestion"
                onClick={() => setInput(suggestion.example)}
              >
                <span className="suggestion-title">{suggestion.title}</span>
                <span className="suggestion-example">{suggestion.example}</span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="chat-log" ref={logRef}>
          <div className="chat-log-inner">
            {messages.map((message, index) => (
              <div key={index} className={`message ${message.role}`}>
                {message.role === "assistant" ? (
                  <>
                    <div className="assistant-label">
                      <span className="assistant-avatar" aria-hidden>AI</span>
                      Prospect Copilot
                    </div>
                    {message.progress && message.progress.length > 0 ? (
                      <ProgressPanel events={message.progress} />
                    ) : null}
                    {message.report ? (
                      <Scorecard report={message.report} />
                    ) : null}
                    {message.report?.kind === "match" &&
                    message.report.matches &&
                    message.report.matches.length > 0 ? (
                      <MatchCandidateCards
                        candidates={message.report.matches}
                        disabled={isStreaming}
                        onSelect={(candidate) =>
                          void send(`analyze ${candidate.url} as a prospect`)
                        }
                      />
                    ) : (
                      <Markdown>
                        {message.report
                          ? message.report.markdown
                          : message.content}
                      </Markdown>
                    )}
                    {isStreaming && index === messages.length - 1 ? (
                      <span className="streaming-cursor" aria-hidden />
                    ) : null}
                  </>
                ) : (
                  message.content
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="composer">
        <div className="composer-inner">
          <input
            className="chat-input"
            placeholder="Try: analyze https://stripe.com as a prospect"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            disabled={isStreaming}
          />
          <button
            className="send-button"
            aria-label="Send message"
            onClick={() => void send()}
            disabled={isStreaming || !input.trim()}
          >
            {isStreaming ? "…" : "↑"}
          </button>
        </div>
        <p className="composer-hint">
          Reports may contain public web data - verify before acting on it.
        </p>
      </div>
      </div>

      {isSettingsOpen ? (
        <div
          className="modal-overlay"
          onClick={(event) => {
            if (event.target === event.currentTarget) setIsSettingsOpen(false);
          }}
        >
          <div className="modal" role="dialog" aria-label="Settings">
            <h2>Settings</h2>
            <p>
              Your API key stays in this browser (localStorage) and is sent
              per-request only. It is never stored server-side.
            </p>
            <div className="field">
              <label htmlFor="setting-api-key">API key</label>
              <input
                id="setting-api-key"
                type="password"
                placeholder="Your DeepSeek API key"
                value={settings.apiKey}
                onChange={(event) =>
                  setSettings({ ...settings, apiKey: event.target.value })
                }
                onCopy={(event) => event.preventDefault()}
                onCut={(event) => event.preventDefault()}
              />
            </div>
            <div className="field">
              <label htmlFor="setting-model">Model</label>
              <input
                id="setting-model"
                value={settings.model}
                onChange={(event) =>
                  setSettings({ ...settings, model: event.target.value })
                }
              />
            </div>
            <div className="field">
              <label htmlFor="setting-base-url">API base URL</label>
              <input
                id="setting-base-url"
                value={settings.baseUrl}
                onChange={(event) =>
                  setSettings({ ...settings, baseUrl: event.target.value })
                }
              />
            </div>
            <div className="modal-actions">
              <button
                className="secondary"
                onClick={() => setIsSettingsOpen(false)}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

/**
 * Live phase/agent progress list during a pipeline run.
 * @param events progress events accumulated so far
 */
function ProgressPanel({ events }: { events: ProgressEvent[] }): JSX.Element {
  return (
    <ul className="progress">
      {events.map((event, index) => (
        <li key={index} className={`progress-item ${event.status ?? ""}`}>
          <span className="progress-marker">
            {event.status === "done"
              ? "✓"
              : event.status === "failed"
                ? "✗"
                : event.kind === "phase"
                  ? "▶"
                  : "…"}
          </span>{" "}
          {event.detail}
          {typeof event.score === "number" ? ` (${event.score}/100)` : ""}
        </li>
      ))}
    </ul>
  );
}

interface ReportSectionProps {
  report: ReportState;
}

/**
 * Score summary card with Unicode block bars, ported from the CLI design.
 * @param report the structured report payload
 */
function Scorecard({ report }: ReportSectionProps): JSX.Element {
  return (
    <div className="scorecard">
      <div className="scorecard-head">
        <strong>{report.companyName}</strong>
        {report.score !== null && report.categories ? (
          <span className="scorecard-total">
            {report.score}/100 · Grade {report.grade} · {report.confidence}{" "}
            confidence
          </span>
        ) : (
          <span className="scorecard-total">{report.kind} report</span>
        )}
      </div>
      {(report.categories ?? []).map((category) => (
        <div key={category.category} className="scorecard-row">
          <span className="scorecard-label">{category.category}</span>
          <span className="scorecard-bar" aria-hidden>
            {bar(category.score)}
          </span>
          <span className="scorecard-value">{category.score}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Render a 10-character block bar for a 0-100 score.
 * @param score the numeric score
 * @returns a string of filled and empty block characters
 */
function bar(score: number): string {
  const filled = Math.max(0, Math.min(10, Math.round(score / 10)));
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

/**
 * Ranked candidate cards for the match skill: title, score, and a one-line
 * reason up front; clicking one runs a full prospect audit on it.
 * @param candidates the ranked candidates to show
 * @param disabled true while another request is streaming
 * @param onSelect called with the clicked candidate
 */
function MatchCandidateCards({
  candidates,
  disabled,
  onSelect,
}: {
  candidates: MatchCandidate[];
  disabled: boolean;
  onSelect: (candidate: MatchCandidate) => void;
}): JSX.Element {
  return (
    <div className="match-cards">
      {candidates.map((candidate) => (
        <button
          key={candidate.url}
          className="match-card"
          disabled={disabled}
          onClick={() => onSelect(candidate)}
        >
          <div className="match-card-head">
            <strong className="match-card-title">
              {candidate.companyName}
            </strong>
            <span className="match-card-score">{candidate.score}/100</span>
          </div>
          <p className="match-card-summary">{candidate.summary}</p>
          <span className="match-card-hint">
            Click for a full prospect audit →
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * Read the SSE stream from /api/chat, updating the last assistant message.
 * @param body the fetch response body
 * @param updateLast patches the trailing assistant message
 */
async function consumeStream(
  body: ReadableStream<Uint8Array>,
  updateLast: (patch: (message: ChatMessage) => ChatMessage) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      applyEvent(frame, updateLast);
    }
  }
}

/**
 * Apply one SSE frame to the trailing assistant message.
 * @param frame raw SSE frame
 * @param updateLast patches the trailing assistant message
 */
function applyEvent(
  frame: string,
  updateLast: (patch: (message: ChatMessage) => ChatMessage) => void,
): void {
  const trimmed = frame.trim();
  if (!trimmed.startsWith("data:")) return;
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(trimmed.slice(5).trim());
  } catch {
    return;
  }
  if (event.type === "token") {
    const text = typeof event.text === "string" ? event.text : "";
    updateLast((message) => ({ ...message, content: message.content + text }));
  } else if (event.type === "phase") {
    updateLast((message) => ({
      ...message,
      progress: [
        ...(message.progress ?? []),
        {
          kind: "phase",
          label: String(event.phase),
          detail: String(event.detail),
        },
      ],
    }));
  } else if (event.type === "agent") {
    updateLast((message) => ({
      ...message,
      progress: [
        ...(message.progress ?? []),
        {
          kind: "agent",
          label: String(event.agent),
          detail: `${event.agent}: ${event.status}`,
          status: event.status as ProgressEvent["status"],
          score: typeof event.score === "number" ? event.score : undefined,
        },
      ],
    }));
  } else if (event.type === "report") {
    const report = event.report as ReportState;
    updateLast((message) => ({ ...message, report }));
  } else if (event.type === "error") {
    throw new Error(String(event.message));
  }
}
