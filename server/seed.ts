import { db } from './db.js';
import { formatHumanDate, saveMessage } from './memory.js';

export function getLastWeekMonday(now = new Date()): Date {
  const currentDay = now.getDay();
  // Most recent past Monday relative to now
  let diff = (currentDay - 1 + 7) % 7;
  if (diff === 0) diff = 7;
  const d = new Date(now);
  d.setDate(now.getDate() - diff);
  d.setHours(10, 30, 0, 0);
  return d;
}

export function getLastWeekTuesday(now = new Date()): Date {
  const currentDay = now.getDay();
  // Most recent past Tuesday relative to now
  let diff = (currentDay - 2 + 7) % 7;
  if (diff === 0) diff = 7;
  const d = new Date(now);
  d.setDate(now.getDate() - diff);
  d.setHours(14, 15, 0, 0);
  return d;
}

export function seedSampleHistory(sessionId = 'default'): { seeded: boolean; count: number } {
  // Idempotency check: check if any sample messages already exist in this sessionId
  const existingSample = db
    .prepare(
      `SELECT id FROM messages 
       WHERE session_id = ? 
       AND (
         content LIKE '%OpenAI GPT-4o and Anthropic Claude 3.5 Sonnet%' OR
         content LIKE '%shortlisting 5 CRM tools%' OR
         content LIKE '%managed Postgres hosting providers%'
       )
       LIMIT 1`
    )
    .get(sessionId);

  if (existingSample) {
    const totalInSession = db
      .prepare('SELECT COUNT(*) as count FROM messages WHERE session_id = ?')
      .get(sessionId) as { count: number };
    return { seeded: false, count: totalInSession.count };
  }

  const now = new Date();
  const conv1Date = new Date('2026-11-03T10:15:00.000Z');
  const conv2Date = getLastWeekMonday(now);
  const conv3Date = getLastWeekTuesday(now);

  let insertedCount = 0;

  // Conversation 1: 3 November 2026
  saveMessage({
    sessionId,
    role: 'user',
    content: 'What are the current API token prices for OpenAI GPT-4o and Anthropic Claude 3.5 Sonnet?',
    createdAt: conv1Date.toISOString(),
  });
  insertedCount++;

  saveMessage({
    sessionId,
    role: 'assistant',
    content:
      'As of 3 November 2026, OpenAI GPT-4o is priced at $2.50 per 1M input tokens and $10.00 per 1M output tokens, while Anthropic Claude 3.5 Sonnet is $3.00 per 1M input tokens and $15.00 per 1M output tokens.',
    sources: [
      { title: 'OpenAI API Pricing', url: 'https://openai.com/api/pricing/' },
      { title: 'Anthropic Claude Pricing', url: 'https://www.anthropic.com/pricing' },
    ],
    promptVersion: 'agent.v1',
    createdAt: new Date(conv1Date.getTime() + 6000).toISOString(),
  });
  insertedCount++;

  // Conversation 2: Monday of last week
  saveMessage({
    sessionId,
    role: 'user',
    content: 'We are shortlisting 5 CRM tools for a 20-person sales team. Which ones should we consider?',
    createdAt: conv2Date.toISOString(),
  });
  insertedCount++;

  saveMessage({
    sessionId,
    role: 'assistant',
    content:
      'For a 20-person sales team, the top 5 CRM options are HubSpot Sales Hub (Starter/Pro), Pipedrive, Close, Salesforce Sales Cloud, and Attio.',
    sources: [
      { title: 'HubSpot Sales Hub', url: 'https://www.hubspot.com/products/sales' },
      { title: 'Salesforce Sales Cloud', url: 'https://www.salesforce.com/products/sales-cloud/' },
      { title: 'Pipedrive CRM', url: 'https://www.pipedrive.com' },
      { title: 'Close CRM', url: 'https://www.close.com' },
      { title: 'Attio CRM', url: 'https://attio.com' },
    ],
    promptVersion: 'agent.v1',
    createdAt: new Date(conv2Date.getTime() + 8000).toISOString(),
  });
  insertedCount++;

  // Conversation 3: Tuesday of last week
  saveMessage({
    sessionId,
    role: 'user',
    content: 'What are the best managed Postgres hosting providers for a startup?',
    createdAt: conv3Date.toISOString(),
  });
  insertedCount++;

  saveMessage({
    sessionId,
    role: 'assistant',
    content:
      'Top managed Postgres providers include Neon (usage-based serverless), Supabase ($25/mo Pro tier with $10 compute credits), Railway, and Render.',
    sources: [
      { title: 'Neon Serverless Postgres', url: 'https://neon.tech' },
      { title: 'Supabase Managed Postgres', url: 'https://supabase.com' },
      { title: 'Railway Postgres Hosting', url: 'https://railway.app' },
      { title: 'Render Managed Postgres', url: 'https://render.com' },
    ],
    promptVersion: 'agent.v1',
    createdAt: new Date(conv3Date.getTime() + 7000).toISOString(),
  });
  insertedCount++;

  return { seeded: true, count: insertedCount };
}
