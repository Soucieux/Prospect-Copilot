"use client";

import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ACTIVE_CONVERSATION_STORAGE_KEY,
  LLM_API_KEY_HEADER,
  LLM_BASE_URL_HEADER,
  LLM_MODEL_HEADER,
} from "@/lib/constants";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type Settings,
} from "@/lib/settings-storage";
import type {
  ChatMessage,
  MatchCandidate,
  ProgressEvent,
  ReportState,
} from "@/lib/chat-types";
import {
  replaceMessageSnapshot,
  updateLastMessageSnapshot,
} from "@/lib/chat-state";
import { buildChatHistory } from "@/lib/chat-history";
import { consumeStream } from "@/lib/chat-stream";
import {
  createConversation,
  deleteConversation,
  listConversations,
  saveConversation,
  titleFromMessages,
  type StoredConversation,
} from "@/lib/storage/conversations";

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
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [error, setError] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  const activeRequestRef = useRef<AbortController | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);

  useEffect(() => {
    listConversations()
      .then((stored) => {
        setConversations(stored);
        const activeId = window.localStorage.getItem(
          ACTIVE_CONVERSATION_STORAGE_KEY,
        );
        const active = stored.find((conversation) => conversation.id === activeId);
        if (active) {
          setActiveConversationId(active.id);
          setMessages(replaceMessageSnapshot(messagesRef, active.messages));
        }
      })
      .catch(() => {
        // IndexedDB unavailable - persistence is silently disabled.
      });
  }, []);

  useEffect(() => {
    setSettings(loadSettings(window.localStorage));
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [messages]);

  /**
   * Apply one settings edit and persist the result immediately. Settings are
   * written here rather than in an effect so that mounting the page can never
   * overwrite stored settings with the defaults it renders before they load.
   * @param patch the settings fields the user changed
   */
  function updateSettings(patch: Partial<Settings>): void {
    const next = { ...settings, ...patch };
    saveSettings(window.localStorage, next);
    setSettings(next);
  }

  /**
   * Apply a patch function to the trailing message in the conversation.
   * @param patch transform applied to the last message
   */
  const updateLast = useCallback(
    (patch: (message: ChatMessage) => ChatMessage): void => {
      const next = updateLastMessageSnapshot(messagesRef, patch);
      if (!next) return;
      setMessages(next);
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
    const current = messagesRef.current;
    const history = buildChatHistory(current);
    const pendingMessages: ChatMessage[] = [
      ...current,
      { role: "user", content: text },
      { role: "assistant", content: "", progress: [] },
    ];
    setMessages(replaceMessageSnapshot(messagesRef, pendingMessages));
    setIsStreaming(true);
    const requestController = new AbortController();
    activeRequestRef.current = requestController;
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
        signal: requestController.signal,
      });
      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => "");
        throw new Error(`/api/chat failed (${response.status}): ${detail}`);
      }
      await consumeStream(response.body, updateLast);
    } catch (caught) {
      if (!requestController.signal.aborted) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      if (activeRequestRef.current === requestController) {
        activeRequestRef.current = null;
      }
      setIsStreaming(false);
      await persistCurrentExchange();
    }
  }

  /** Cancel the active browser request; the same signal stops server work. */
  function stopProcessing(): void {
    activeRequestRef.current?.abort();
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
    window.localStorage.setItem(ACTIVE_CONVERSATION_STORAGE_KEY, id);
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
    window.localStorage.setItem(
      ACTIVE_CONVERSATION_STORAGE_KEY,
      conversation.id,
    );
    setMessages(replaceMessageSnapshot(messagesRef, conversation.messages));
    setError("");
    setIsSidebarOpen(false);
  }

  /**
   * Start a fresh, empty conversation.
   */
  function startNewConversation(): void {
    if (isStreaming) return;
    setActiveConversationId(null);
    window.localStorage.removeItem(ACTIVE_CONVERSATION_STORAGE_KEY);
    setMessages(replaceMessageSnapshot(messagesRef, []));
    setError("");
    setIsSidebarOpen(false);
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
      <aside
        id="conversation-sidebar"
        className={`sidebar ${isSidebarOpen ? "open" : ""}`}
      >
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
          <button
            className="settings-toggle"
            onClick={() => {
              setIsSettingsOpen(true);
              setIsSidebarOpen(false);
            }}
          >
            <span aria-hidden>⚙</span> Settings
            <span className="model-chip">{settings.model}</span>
          </button>
        </div>
      </aside>

      {isSidebarOpen ? (
        <button
          className="sidebar-backdrop"
          aria-label="Close conversation menu"
          onClick={() => setIsSidebarOpen(false)}
        />
      ) : null}

      <div className="app-main">
        <header className="mobile-header">
          <button
            className="mobile-menu-button"
            aria-label="Open conversation menu"
            aria-controls="conversation-sidebar"
            aria-expanded={isSidebarOpen}
            onClick={() => setIsSidebarOpen((open) => !open)}
          >
            <span aria-hidden>☰</span>
          </button>
          <span>Prospect Copilot</span>
        </header>
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
                          labels={message.report.matchLabels ?? DEFAULT_MATCH_CARD_LABELS}
                          disabled={isStreaming}
                          onSelect={(_candidate, requestText) =>
                            void send(requestText)
                          }
                        />
                      ) : (
                        <ReportDocument
                          markdown={
                            message.report
                              ? message.report.markdown
                              : message.content
                          }
                        />
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
              className={`send-button ${isStreaming ? "stop-button" : ""}`}
              aria-label={isStreaming ? "Stop processing" : "Send message"}
              onClick={() =>
                isStreaming ? stopProcessing() : void send()
              }
              disabled={!isStreaming && !input.trim()}
            >
              <span aria-hidden>{isStreaming ? "■" : "↑"}</span>
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
                  updateSettings({ apiKey: event.target.value })
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
                  updateSettings({ model: event.target.value })
                }
              />
            </div>
            <div className="field">
              <label htmlFor="setting-base-url">API base URL</label>
              <input
                id="setting-base-url"
                value={settings.baseUrl}
                onChange={(event) =>
                  updateSettings({ baseUrl: event.target.value })
                }
              />
              <small className="field-help">
                Custom endpoints must be approved by the server through
                LLM_ALLOWED_BASE_URLS.
              </small>
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
 * Semantic, styled Markdown renderer shared by streaming and final reports.
 * @param markdown the report or streamed assistant text
 * @returns the rendered document
 */
function ReportDocument({ markdown }: { markdown: string }): JSX.Element {
  return (
    <article className="report-document">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {markdown}
      </Markdown>
    </article>
  );
}

/**
 * Live phase/agent progress list during a pipeline run.
 * @param events progress events accumulated so far
 * @returns the progress list
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

/** English recovery labels for reports saved before per-message localization. */
const DEFAULT_SCORE_LABELS = {
  grade: "Grade",
  confidence: "confidence",
  confidenceValue: "",
  report: "Report",
};

/**
 * Score summary card with Unicode block bars, ported from the CLI design.
 * @param report the structured report payload
 * @returns the summary card
 */
function Scorecard({ report }: ReportSectionProps): JSX.Element {
  const labels = report.scoreLabels ?? DEFAULT_SCORE_LABELS;
  return (
    <div className="scorecard">
      <div className="scorecard-head">
        <strong>{report.companyName}</strong>
        {report.score !== null && report.categories ? (
          <span className="scorecard-total">
            {report.score}/100 · {labels.grade} {report.grade} ·{" "}
            {labels.confidenceValue} {labels.confidence}
          </span>
        ) : (
          <span className="scorecard-total">{labels.report}</span>
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

/** English fallback card labels, used only if a stored report predates matchLabels. */
const DEFAULT_MATCH_CARD_LABELS = {
  founded: "Founded",
  fit: "Fit",
  auditHint: "Click for a full prospect audit →",
  auditRequestTemplate: "Analyze {url} as a prospect",
};

/**
 * Ranked candidate cards for the match skill: full company name, score,
 * website, location/founded when known, factual description, fit judgment,
 * and a separate action that runs a full prospect audit.
 * @param candidates the ranked candidates to show
 * @param labels localized card chrome labels
 * @param disabled true while another request is streaming
 * @param onSelect called with the clicked candidate and localized request text
 * @returns the ranked candidate cards
 */
function MatchCandidateCards({
  candidates,
  labels,
  disabled,
  onSelect,
}: {
  candidates: MatchCandidate[];
  labels: {
    founded: string;
    fit: string;
    auditHint: string;
    auditRequestTemplate: string;
  };
  disabled: boolean;
  onSelect: (candidate: MatchCandidate, requestText: string) => void;
}): JSX.Element {
  return (
    <div className="match-cards">
      {candidates.map((candidate) => (
        <article
          key={candidate.url}
          className="match-card"
        >
          <div className="match-card-head">
            <strong className="match-card-title">
              {candidate.companyName}
            </strong>
            <span className="match-card-score">{candidate.score}/100</span>
          </div>
          <a
            className="match-card-url"
            href={candidate.url}
            target="_blank"
            rel="noreferrer"
          >
            {candidate.url}
          </a>
          {candidate.location || candidate.founded ? (
            <div className="match-card-meta">
              {candidate.location ? <span>{candidate.location}</span> : null}
              {candidate.founded ? (
                <span>
                  {labels.founded} {candidate.founded}
                </span>
              ) : null}
            </div>
          ) : null}
          <p className="match-card-description">{candidate.description}</p>
          <p className="match-card-fit">
            <strong>{labels.fit}:</strong> {candidate.fitReason}
          </p>
          <button
            type="button"
            className="match-card-audit"
            disabled={disabled}
            onClick={() =>
              onSelect(
                candidate,
                labels.auditRequestTemplate.replace("{url}", candidate.url),
              )
            }
          >
            {labels.auditHint}
          </button>
        </article>
      ))}
    </div>
  );
}
