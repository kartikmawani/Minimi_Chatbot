import { describe, it, expect, vi, afterAll } from 'vitest';
import {
  PROMPT_VERSION,
  STATIC_SYSTEM_PROMPT,
  buildSystemPrompt,
  runChatAgentStream,
} from '../server/agent.js';
import { server } from '../server/index.js';

afterAll(() => {
  if (server) {
    server.close();
  }
});

describe('server/agent.ts: Prompt Engineering', () => {
  it('exports PROMPT_VERSION as "agent.v1"', () => {
    expect(PROMPT_VERSION).toBe('agent.v1');
  });

  it('structures system prompt with static rules first and dynamic history at the end', () => {
    const fakeContext = '[Friday, 13 November 2026 | 2026-11-13T10:00:00.000Z] User: Question';
    const now = new Date('2026-11-13T12:00:00Z');
    const prompt = buildSystemPrompt(fakeContext, now);

    // Static rules first
    expect(prompt.startsWith(STATIC_SYSTEM_PROMPT)).toBe(true);

    // Core operational rules present
    expect(prompt).toContain('Past Conversation & Date Reference Rule');
    expect(prompt).toContain('Verification & Live Research Rule');
    expect(prompt).toContain('Parallel Tool Calling');
    expect(prompt).toContain('Conflict Rule (Recency Wins)');
    expect(prompt).toContain('Refusal Rule');
    expect(prompt).toContain('Grounding Rule');

    // Dynamic context at the end
    expect(prompt).toContain('Current Date & Time: Friday, 13 November 2026');
    expect(prompt).toContain('RETRIEVED CONVERSATION HISTORY:');
    expect(prompt).toContain(fakeContext);
  });
});

describe('server/index.ts: API Endpoints (GET /api/messages & POST /api/chat)', () => {
  it('GET /api/messages returns empty or saved messages list for a session', async () => {
    const res = await fetch('http://localhost:3001/api/messages?sessionId=test-session-api');
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json).toHaveProperty('messages');
    expect(Array.isArray(json.messages)).toBe(true);
  });

  it('POST /api/chat rejects empty message in Phase 1 with 400 validation error', async () => {
    const res = await fetch('http://localhost:3001/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '', sessionId: 'default' }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe('validation_failure');
    expect(json.error.message).toBe('Validation failed');
  });

  it('POST /api/chat rejects payload exceeding 4000 chars in Phase 1 with 400', async () => {
    const res = await fetch('http://localhost:3001/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'x'.repeat(4001), sessionId: 'default' }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe('validation_failure');
  });
});
