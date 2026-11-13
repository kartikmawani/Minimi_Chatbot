import React, { useState, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

export interface SourceItem {
  title?: string;
  url: string;
}

export interface MessageItem {
  id: number;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  sources: SourceItem[];
  promptVersion?: string | null;
  createdAt: string;
  humanDate: string;
}

const PROMPT_CHIPS = [
  'What did I ask you on 3 November? Is your answer still correct today?',
  'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?',
  'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?',
];

function FormattedContent({ text }: { text: string }) {
  const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  const elements: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = linkRegex.exec(text)) !== null) {
    const textBefore = text.slice(lastIndex, match.index);
    if (textBefore) {
      elements.push(textBefore);
    }
    const label = match[1];
    const url = match[2];
    elements.push(
      <a key={match.index} href={url} target="_blank" rel="noopener noreferrer">
        {label}
      </a>
    );
    lastIndex = match.index + match[0].length;
  }

  const textAfter = text.slice(lastIndex);
  if (textAfter) {
    elements.push(textAfter);
  }

  return <>{elements.length > 0 ? elements : text}</>;
}

function deduplicateSources(sources: SourceItem[]): SourceItem[] {
  const seen = new Set<string>();
  const unique: SourceItem[] = [];
  for (const s of sources) {
    if (s && s.url && !seen.has(s.url)) {
      seen.add(s.url);
      unique.push(s);
    }
  }
  return unique;
}

export function App() {
  const queryClient = useQueryClient();
  const sessionId = 'default';

  // Input & stream state
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingUserMessage, setStreamingUserMessage] = useState<string | null>(null);
  const [streamingAssistantText, setStreamingAssistantText] = useState('');
  const [streamingStatus, setStreamingStatus] = useState<string | null>(null);
  const [streamingSources, setStreamingSources] = useState<SourceItem[]>([]);
  const [errorAlert, setErrorAlert] = useState<string | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // 1. TanStack Query ONLY for persisted history
  const { data: historyData, isLoading: isHistoryLoading } = useQuery({
    queryKey: ['messages', sessionId],
    queryFn: async () => {
      const res = await fetch(`/api/messages?sessionId=${encodeURIComponent(sessionId)}`);
      if (!res.ok) {
        throw new Error('Failed to load conversation history');
      }
      return (await res.json()) as { messages: MessageItem[] };
    },
  });

  const messages = historyData?.messages ?? [];

  // 2. TanStack useMutation for POST /api/seed
  const seedMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/seed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      if (!res.ok) {
        const errorBody = await res.json().catch(() => ({}));
        throw new Error(errorBody.error?.message || 'Failed to seed sample history');
      }
      return (await res.json()) as { seeded: boolean; count: number };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['messages'] });
    },
    onError: (err: any) => {
      setErrorAlert(err.message || 'Seeding failed');
    },
  });

  // Auto-scroll on new messages or token streaming
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingAssistantText, streamingStatus, streamingUserMessage]);

  // Handle Send Message via SSE Streaming Controller
  const handleSendMessage = async (overrideMessage?: string) => {
    const messageToSend = (overrideMessage ?? input).trim();
    if (!messageToSend || isStreaming) return;

    setErrorAlert(null);
    setInput('');
    setIsStreaming(true);
    setStreamingUserMessage(messageToSend);
    setStreamingAssistantText('');
    setStreamingStatus(null);
    setStreamingSources([]);

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: messageToSend, sessionId }),
        signal: abortController.signal,
      });

      // Handle Pre-Stream HTTP errors (res.ok is false)
      if (!response.ok) {
        const errorJson = await response.json().catch(() => ({}));
        const errorMessage =
          errorJson.error?.message ||
          errorJson.message ||
          `Request failed with status ${response.status}`;
        setErrorAlert(errorMessage);
        return;
      }

      // Handle Active SSE Stream
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('ReadableStream not supported by browser');
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? ''; // Retain split chunk in accumulator buffer

        for (const frame of frames) {
          const trimmed = frame.trim();
          if (!trimmed) continue;

          for (const line of trimmed.split('\n')) {
            if (line.startsWith('data: ')) {
              const jsonStr = line.slice(6).trim();
              try {
                const parsed = JSON.parse(jsonStr);

                if (parsed.type === 'status') {
                  setStreamingStatus(parsed.message || 'Searching the web...');
                } else if (parsed.type === 'token') {
                  setStreamingAssistantText((prev) => prev + (parsed.text ?? ''));
                } else if (parsed.type === 'sources') {
                  if (Array.isArray(parsed.sources)) {
                    setStreamingSources(parsed.sources);
                  }
                } else if (parsed.type === 'error') {
                  setErrorAlert(
                    `${parsed.errorCode ? `[${parsed.errorCode}] ` : ''}${
                      parsed.message || 'Stream error occurred.'
                    }`
                  );
                } else if (parsed.type === 'done') {
                  setStreamingStatus(null);
                  queryClient.invalidateQueries({ queryKey: ['messages'] });
                }
              } catch (parseErr) {
                console.warn('Failed to parse SSE JSON chunk:', jsonStr, parseErr);
              }
            }
          }
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        // Stream aborted cleanly by user
      } else {
        setErrorAlert(err.message || 'An error occurred during communication.');
      }
    } finally {
      queryClient.invalidateQueries({ queryKey: ['messages'] });
      setIsStreaming(false);
      setStreamingUserMessage(null);
      setStreamingAssistantText('');
      setStreamingStatus(null);
      setStreamingSources([]);
      abortControllerRef.current = null;
    }
  };

  const handleStopStreaming = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  return (
    <div className="app-container">
      {/* Header Bar */}
      <header className="app-header">
        <div className="header-top">
          <div className="app-title-group">
            <span className="app-logo">⚡</span>
            <h1 className="app-title">Temporal Research Assistant</h1>
            <span className="app-badge">Gemini Flash</span>
          </div>

          <button
            type="button"
            className="btn-seed"
            onClick={() => seedMutation.mutate()}
            disabled={seedMutation.isPending || isStreaming}
          >
            {seedMutation.isPending ? 'Seeding...' : 'Load Sample History'}
          </button>
        </div>

        {/* 3 Clickable Quick-Test Prompt Chips */}
        <div className="chips-container">
          <span className="chip-label">Quick Prompts:</span>
          {PROMPT_CHIPS.map((chip, idx) => (
            <button
              key={idx}
              type="button"
              className="chip-btn"
              onClick={() => {
                setInput(chip);
                textareaRef.current?.focus();
              }}
            >
              {chip}
            </button>
          ))}
        </div>
      </header>

      {/* Dismissible Error Alert */}
      {errorAlert && (
        <div className="error-banner" role="alert">
          <span>⚠️ {errorAlert}</span>
          <button
            type="button"
            className="error-close-btn"
            onClick={() => setErrorAlert(null)}
            aria-label="Dismiss error"
          >
            ×
          </button>
        </div>
      )}

      {/* Message List */}
      <main className="messages-container">
        {isHistoryLoading && messages.length === 0 && (
          <div className="empty-state">
            <p>Loading conversation history...</p>
          </div>
        )}

        {!isHistoryLoading && messages.length === 0 && !isStreaming && (
          <div className="empty-state">
            <h3>No Messages Yet</h3>
            <p>
              Click <strong>&ldquo;Load Sample History&rdquo;</strong> above to seed realistic past
              conversations, or click any quick prompt chip to start exploring!
            </p>
          </div>
        )}

        {messages.map((msg) => {
          const uniqueSources = deduplicateSources(msg.sources || []);
          const timeFormatted = new Date(msg.createdAt).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          });

          return (
            <div key={msg.id} className={`message-card ${msg.role}`}>
              <div className="message-header">
                <span className={`role-badge ${msg.role}`}>
                  {msg.role === 'user' ? 'User' : 'Assistant'}
                </span>
                <span className="timestamp-badge">
                  {msg.humanDate} • {timeFormatted}
                </span>
              </div>

              <div className="message-body">
                <FormattedContent text={msg.content} />
              </div>

              {msg.role === 'assistant' && uniqueSources.length > 0 && (
                <div className="sources-container">
                  <span className="sources-label">Sources:</span>
                  <div className="sources-list">
                    {uniqueSources.map((source, sIdx) => {
                      let domain = source.url;
                      try {
                        domain = new URL(source.url).hostname.replace(/^www\./, '');
                      } catch {
                        // ignore URL parse error
                      }
                      return (
                        <a
                          key={sIdx}
                          href={source.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="source-pill"
                        >
                          <span>🔗</span>
                          <span className="source-title">{source.title || domain}</span>
                        </a>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {/* Active Streaming User Bubble */}
        {isStreaming && streamingUserMessage && (
          <div className="message-card user">
            <div className="message-header">
              <span className="role-badge user">User</span>
              <span className="timestamp-badge">Just now</span>
            </div>
            <div className="message-body">{streamingUserMessage}</div>
          </div>
        )}

        {/* Active Streaming Assistant Bubble */}
        {isStreaming && (
          <div className="message-card assistant">
            <div className="message-header">
              <span className="role-badge assistant">Assistant</span>
              <span className="timestamp-badge">Live Generation</span>
            </div>

            {streamingStatus && (
              <div className="status-indicator">
                <span className="pulse-dot"></span>
                <span>{streamingStatus}</span>
              </div>
            )}

            <div className="message-body">
              <FormattedContent text={streamingAssistantText || (streamingStatus ? '' : '...')} />
            </div>

            {streamingSources.length > 0 && (
              <div className="sources-container">
                <span className="sources-label">Sources:</span>
                <div className="sources-list">
                  {deduplicateSources(streamingSources).map((source, sIdx) => (
                    <a
                      key={sIdx}
                      href={source.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="source-pill"
                    >
                      <span>🔗</span>
                      <span className="source-title">
                        {source.title || new URL(source.url).hostname.replace(/^www\./, '')}
                      </span>
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <div ref={messagesEndRef} />
      </main>

      {/* Input Area */}
      <form
        className="input-form"
        onSubmit={(e) => {
          e.preventDefault();
          handleSendMessage();
        }}
      >
        <div className="input-box-wrapper">
          <textarea
            ref={textareaRef}
            className="chat-input"
            rows={2}
            placeholder="Ask a question or reference prior dates (e.g. 'What did we talk about on 3 November?')..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isStreaming}
          />

          {isStreaming ? (
            <button
              type="button"
              className="btn-stop"
              onClick={handleStopStreaming}
              aria-label="Stop generating response"
            >
              <span>⏹</span> Stop
            </button>
          ) : (
            <button
              type="submit"
              className="btn-send"
              disabled={!input.trim()}
              aria-label="Send message"
            >
              <span>➤</span> Send
            </button>
          )}
        </div>

        <div className="input-footer">
          <span>Press Enter to send, Shift + Enter for new line</span>
          <span>Single-step parallel web search enabled</span>
        </div>
      </form>
    </div>
  );
}

export default App;
