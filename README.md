# System Design: Temporal Memory & Real-Time Research Agent

## 1. How It Works

```
Browser (React + TanStack Query + SSE Reader)
  │  POST /api/chat { message, sessionId }
  ▼
Express API (/api/chat + Two-Phase Error Boundary)
  │  Retrieves deterministic temporal context (<2ms)
  ▼
Deterministic Temporal Retriever (server/memory.ts)
  │  • Explicit & relative date parsing ("3 November", "Monday", "last Tuesday")
  │  • SQLite index (session_id, created_at) + sanitized FTS5
  ▼
Versioned Static-Prefix Prompt (PROMPT_VERSION = "agent.v1")
  │  • Static rules at prefix for KV cache reuse; dynamic time & history at suffix
  │  • Model: gemini-2.5-flash with thinkingBudget: 0 (~300ms TTFT)
  ▼
Single Hardened Tool: web_search (server/searchTool.ts)
  │  • 200-entry TTL cache + singleflight coalescing (<1ms repeat hits)
  │  • 3-state circuit breaker (CLOSED -> OPEN on 3 failures -> 30s probe)
  │  • 3.5s timeout, full-jitter exponential backoff (max 2 retries)
  ▼
Cited SSE Token Stream & SQLite Persistence
     Streams status, text deltas, deduplicated URLs, and done event
```

## 2. Why I Built It This Way

- **Embedded SQLite + Compound Date Index + FTS5:**
  Calendar-relative prompts (`"3 November"`, `"last Tuesday"`, `"on Monday"`) fail under vector embeddings. SQLite with a compound `(session_id, created_at)` index and `FTS5` table resolves explicit dates and sanitized keywords across sessions in `<2ms`. This honors the single-tool constraint deterministically while keeping boot zero-config (`npm install && npm run dev`, no Docker or external database).

- **Parallel Tool Calls (`stopWhen: stepCountIs(4)`) + Singleflight TTL Cache:**
  When checking multiple entities (e.g., 5 CRM tools), the agent executes parallel `web_search` calls in one step (~1.5s total) rather than stalling sequentially. A bounded cache (200 entries, 15-min TTL) serves repeat queries in `<1ms`, and singleflight coalescing deduplicates concurrent identical queries to a single upstream request.

- **Static-Prefix Prompt Ordering & "Recency Wins" Rule:**
  Static rules remain fixed at the prompt head for provider prefix caching; dynamic time and history append to the tail. Setting `thinkingBudget: 0` removes reasoning latency for ~300ms TTFT. Explicit rules enforce that recency wins when past records and live web results conflict, requiring inline citations (`[1]`, `[2]`) grounded strictly in returned URLs and honest refusal on unverified search results.

- **Defensive Resilience & Observability:**
  Outbound search uses a 3-state circuit breaker, per-attempt `AbortController` timeouts (3.5s), and full-jitter backoff against upstream rate limits. Express wraps execution in a two-phase error boundary (JSON 400/500 before headers; SSE error frames once streaming). Single-line structured JSON logs track latency, TTFT, tokens, and errors, redacting prompts by default. A 54-test Vitest suite verifies the pipeline.

## 3. What I Considered and Rejected

- **Vector DB (Pinecone / pgvector):** Rejected because cosine similarity fails on exact calendar dates (`"3 November"`) and introduces cloud latency, setup friction, and external API keys.
- **Cloud DB / Docker Postgres:** Rejected to eliminate setup friction, port conflicts, migration overhead, and cold starts, preserving instant local boot.
- **Second `search_history` Tool:** Rejected to strictly satisfy the single-tool constraint. Pre-retrieving historical context deterministically before model invocation is faster (<2ms) and 100% reliable.

## 4. What I'd Do With Another Week (Honest Limitations)

- **Parallel Citation Re-Indexing:** Concurrent `web_search` calls resolve out-of-order over the wire, which can misalign inline citations (`[1]`, `[2]`) against the final aggregated `sources` list. A streaming buffer or post-stream normalizer would enforce deterministic numbering.
- **Persistent Cache & History Compression:** Moving the in-memory search cache to SQLite would preserve cached results across restarts. Rolling conversation summarization would prevent long sessions from exceeding prompt retrieval caps.
- **Semantic Hybrid Recall & Evals:** Complementing FTS5 lexical matching with lightweight local embeddings (Transformers.js) would improve fuzzy synonym recall. Adding an automated LLM-as-a-judge evaluation suite and OpenTelemetry tracing would ensure ongoing output quality.
