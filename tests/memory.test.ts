import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { db } from '../server/db.js';

afterAll(() => {
  db.prepare("DELETE FROM messages WHERE session_id LIKE 'test-%'").run();
});
import {
  formatHumanDate,
  saveMessage,
  getSessionMessages,
  extractTargetDates,
  extractFTSKeywords,
  retrieveTemporalContext,
} from '../server/memory.js';

describe('server/memory.ts: Date Formatting & Persistence', () => {
  it('formatHumanDate formats date with weekday, day, month, and year', () => {
    const fixedDate = new Date('2026-11-13T10:00:00Z');
    const result = formatHumanDate(fixedDate);
    expect(result).toBe('Friday, 13 November 2026');
  });

  it('saveMessage inserts into messages and returns saved record', () => {
    const testSession = 'test-session-save-' + Date.now();
    const saved = saveMessage({
      sessionId: testSession,
      role: 'user',
      content: 'What is the speed of light?',
      sources: [{ title: 'Physics', url: 'https://example.com/physics' }],
      promptVersion: 'agent.v1',
      createdAt: '2026-11-13T10:00:00.000Z',
    });

    expect(saved.id).toBeGreaterThan(0);
    expect(saved.session_id).toBe(testSession);
    expect(saved.role).toBe('user');
    expect(saved.content).toBe('What is the speed of light?');
    expect(saved.human_date).toBe('Friday, 13 November 2026');
    expect(saved.prompt_version).toBe('agent.v1');
    expect(JSON.parse(saved.sources_json)).toEqual([
      { title: 'Physics', url: 'https://example.com/physics' },
    ]);
  });

  it('getSessionMessages returns chronological messages with parsed sources', () => {
    const testSession = 'test-session-chron-' + Date.now();

    saveMessage({
      sessionId: testSession,
      role: 'user',
      content: 'Question 1',
      createdAt: '2026-11-13T10:00:00.000Z',
    });

    saveMessage({
      sessionId: testSession,
      role: 'assistant',
      content: 'Answer 1',
      sources: [{ title: 'Source 1', url: 'https://example.com/1' }],
      createdAt: '2026-11-13T10:01:00.000Z',
    });

    const messages = getSessionMessages(testSession);
    expect(messages.length).toBe(2);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('Question 1');
    expect(messages[0].sources).toEqual([]);

    expect(messages[1].role).toBe('assistant');
    expect(messages[1].content).toBe('Answer 1');
    expect(messages[1].sources).toEqual([
      { title: 'Source 1', url: 'https://example.com/1' },
    ]);
  });
});

describe('server/memory.ts: Date Reference Extraction', () => {
  const mockNow = new Date('2026-11-13T12:00:00Z'); // Friday, 13 November 2026

  it('parses "today" and "yesterday"', () => {
    const todayDates = extractTargetDates('What did we do today?', mockNow);
    expect(todayDates).toContain('2026-11-13');

    const yesterdayDates = extractTargetDates('Review yesterday notes', mockNow);
    expect(yesterdayDates).toContain('2026-11-12');
  });

  it('parses "last week"', () => {
    const lastWeekDates = extractTargetDates('Summarize last week conversations', mockNow);
    expect(lastWeekDates.length).toBe(7);
    expect(lastWeekDates).toContain('2026-11-12');
    expect(lastWeekDates).toContain('2026-11-06');
  });

  it('parses weekday references relative to now', () => {
    // If today is Friday Nov 13, Monday was Nov 9
    const mondayDates = extractTargetDates('What was discussed on monday?', mockNow);
    expect(mondayDates).toContain('2026-11-09');

    // Tuesday was Nov 10
    const tuesdayDates = extractTargetDates('Did we talk about pricing on last tuesday?', mockNow);
    expect(tuesdayDates).toContain('2026-11-10');
  });

  it('parses explicit dates (Month Day, Day Month, ISO)', () => {
    const d1 = extractTargetDates('Meeting on November 3 was critical', mockNow);
    expect(d1).toContain('2026-11-03');

    const d2 = extractTargetDates('Meeting on 3 November was critical', mockNow);
    expect(d2).toContain('2026-11-03');

    const d3 = extractTargetDates('Check status on 2026-11-05', mockNow);
    expect(d3).toContain('2026-11-05');
  });
});

describe('server/memory.ts: FTS Keywords & Context Assembly', () => {
  it('extracts sanitized non-stopword keywords', () => {
    const keywords = extractFTSKeywords('Can you tell me about quantum cryptography and algorithms?!');
    expect(keywords).toContain('quantum');
    expect(keywords).toContain('cryptography');
    expect(keywords).toContain('algorithms');
    expect(keywords).not.toContain('can');
    expect(keywords).not.toContain('you');
    expect(keywords).not.toContain('tell');
    expect(keywords).not.toContain('and');
  });

  it('retrieveTemporalContext merges recent messages, date matches, and FTS results into formatted lines', () => {
    const sessionId = 'session-temporal-' + Date.now();
    const otherSession = 'session-other-' + Date.now();

    // Past message on Nov 3 in another session
    saveMessage({
      sessionId: otherSession,
      role: 'user',
      content: 'Comparing Salesforce and HubSpot pricing',
      createdAt: '2026-11-03T09:00:00.000Z',
    });
    saveMessage({
      sessionId: otherSession,
      role: 'assistant',
      content: 'HubSpot was $50/mo and Salesforce was $75/mo on 3 November.',
      sources: [{ url: 'https://hubspot.com' }],
      createdAt: '2026-11-03T09:01:00.000Z',
    });

    // Recent message in current session
    saveMessage({
      sessionId,
      role: 'user',
      content: 'Hello assistant',
      createdAt: '2026-11-13T10:00:00.000Z',
    });
    saveMessage({
      sessionId,
      role: 'assistant',
      content: 'Hello! How can I help you today?',
      createdAt: '2026-11-13T10:00:05.000Z',
    });

    const now = new Date('2026-11-13T12:00:00Z');
    const context = retrieveTemporalContext(
      'Is the HubSpot pricing we talked about on 3 November still accurate?',
      sessionId,
      now
    );

    // Expect formatted lines
    expect(context).toContain('HubSpot was $50/mo and Salesforce was $75/mo on 3 November.');
    expect(context).toContain('(Sources: https://hubspot.com)');
    expect(context).toContain('Hello! How can I help you today?');
    expect(context.length).toBeLessThanOrEqual(6000);
  });
});
