import { describe, it, expect, afterAll } from 'vitest';
import { db } from '../server/db.js';
import { seedSampleHistory, getLastWeekMonday, getLastWeekTuesday } from '../server/seed.js';
import { getSessionMessages } from '../server/memory.js';
import { server } from '../server/index.js';

afterAll(() => {
  db.prepare("DELETE FROM messages WHERE session_id LIKE 'test-%'").run();
  if (server) {
    server.close();
  }
});

describe('server/seed.ts: Date computation', () => {
  it('computes realistic Monday and Tuesday dates relative to now', () => {
    const fixedNow = new Date('2026-11-13T12:00:00Z'); // Friday
    const monday = getLastWeekMonday(fixedNow);
    const tuesday = getLastWeekTuesday(fixedNow);

    expect(monday.getDay()).toBe(1); // Monday
    expect(tuesday.getDay()).toBe(2); // Tuesday
    expect(tuesday.getTime()).toBeGreaterThan(monday.getTime());
  });
});

describe('server/seed.ts: seedSampleHistory', () => {
  it('seeds 3 conversations (6 messages) and is idempotent', () => {
    const sessionId = 'test-seed-session-' + Date.now();

    // 1st seed call
    const firstResult = seedSampleHistory(sessionId);
    expect(firstResult.seeded).toBe(true);
    expect(firstResult.count).toBe(6);

    // Verify messages in DB
    const messages = getSessionMessages(sessionId);
    expect(messages.length).toBe(6);

    // Conversation 1: 3 November 2026
    const conv1User = messages.find((m) =>
      m.content.includes('OpenAI GPT-4o and Anthropic Claude 3.5 Sonnet')
    );
    expect(conv1User).toBeDefined();
    expect(conv1User?.createdAt).toBe('2026-11-03T10:15:00.000Z');
    expect(conv1User?.humanDate).toBe('Tuesday, 3 November 2026');

    const conv1Assistant = messages.find((m) =>
      m.content.includes('As of 3 November 2026, OpenAI GPT-4o is priced at $2.50')
    );
    expect(conv1Assistant).toBeDefined();
    expect(conv1Assistant?.sources.length).toBeGreaterThan(0);

    // Conversation 2: CRM tools
    const conv2User = messages.find((m) => m.content.includes('shortlisting 5 CRM tools'));
    expect(conv2User).toBeDefined();
    const conv2Assistant = messages.find((m) => m.content.includes('HubSpot Sales Hub'));
    expect(conv2Assistant?.sources.some((s: any) => s.url.includes('hubspot.com'))).toBe(true);

    // Conversation 3: Postgres hosting
    const conv3User = messages.find((m) =>
      m.content.includes('best managed Postgres hosting providers')
    );
    expect(conv3User).toBeDefined();
    const conv3Assistant = messages.find((m) => m.content.includes('Neon'));
    expect(conv3Assistant?.sources.some((s: any) => s.url.includes('neon.tech'))).toBe(true);

    // FTS5 index sync check
    const ftsResults = db
      .prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?')
      .all('Anthropic');
    expect(ftsResults.length).toBeGreaterThan(0);

    // 2nd seed call: Idempotent (should skip and return seeded: false)
    const secondResult = seedSampleHistory(sessionId);
    expect(secondResult.seeded).toBe(false);
    expect(secondResult.count).toBe(6);

    // Messages count in DB remains 6
    const messagesAfter = getSessionMessages(sessionId);
    expect(messagesAfter.length).toBe(6);
  });
});

describe('server/index.ts: POST /api/seed endpoint', () => {
  it('seeds sample history via HTTP endpoint', async () => {
    const sessionId = 'test-api-seed-' + Date.now();
    const res = await fetch('http://localhost:3001/api/seed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.seeded).toBe(true);
    expect(json.count).toBe(6);

    // GET /api/messages returns seeded messages
    const msgRes = await fetch(`http://localhost:3001/api/messages?sessionId=${sessionId}`);
    expect(msgRes.status).toBe(200);
    const msgJson = await msgRes.json();
    expect(msgJson.messages.length).toBe(6);
  });
});
