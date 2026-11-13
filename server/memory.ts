import { db } from './db.js';

export interface SaveMessageInput {
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  sources?: unknown[];
  promptVersion?: string | null;
  createdAt?: string;
}

export interface MessageRecord {
  id: number;
  session_id: string;
  role: 'user' | 'assistant';
  content: string;
  sources_json: string;
  prompt_version: string | null;
  created_at: string;
  human_date: string;
}

export function formatHumanDate(date: Date): string {
  const weekday = date.toLocaleDateString('en-US', { weekday: 'long' });
  const day = date.getDate();
  const month = date.toLocaleDateString('en-US', { month: 'long' });
  const year = date.getFullYear();
  return `${weekday}, ${day} ${month} ${year}`;
}

export function saveMessage(input: SaveMessageInput): MessageRecord {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const humanDate = formatHumanDate(new Date(createdAt));
  const sourcesJson = JSON.stringify(input.sources ?? []);
  const promptVersion = input.promptVersion ?? null;

  const stmt = db.prepare(`
    INSERT INTO messages (
      session_id, role, content, sources_json, prompt_version, created_at, human_date
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    input.sessionId,
    input.role,
    input.content,
    sourcesJson,
    promptVersion,
    createdAt,
    humanDate
  );

  return {
    id: Number(result.lastInsertRowid),
    session_id: input.sessionId,
    role: input.role,
    content: input.content,
    sources_json: sourcesJson,
    prompt_version: promptVersion,
    created_at: createdAt,
    human_date: humanDate,
  };
}

export function getSessionMessages(sessionId: string) {
  const stmt = db.prepare(`
    SELECT id, session_id, role, content, sources_json, prompt_version, created_at, human_date
    FROM messages
    WHERE session_id = ?
    ORDER BY created_at ASC, id ASC
  `);

  const rows = stmt.all(sessionId) as MessageRecord[];
  return rows.map((row) => {
    let parsedSources: unknown[] = [];
    try {
      parsedSources = JSON.parse(row.sources_json || '[]');
    } catch {
      parsedSources = [];
    }

    return {
      id: row.id,
      sessionId: row.session_id,
      role: row.role,
      content: row.content,
      sources: parsedSources,
      promptVersion: row.prompt_version,
      createdAt: row.created_at,
      humanDate: row.human_date,
    };
  });
}

const MONTH_MAP: Record<string, number> = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'what', 'when',
  'where', 'which', 'who', 'how', 'why', 'can', 'could', 'will', 'would', 'should',
  'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such',
  'than', 'too', 'very', 'you', 'your', 'about', 'above', 'after', 'again', 'against',
  'are', 'was', 'were', 'been', 'being', 'has', 'had', 'having', 'does',
  'did', 'doing', 'our', 'their', 'them', 'then', 'there', 'these', 'they',
  'into', 'just', 'also', 'tell', 'show', 'give', 'know', 'think', 'out',
]);

export function extractTargetDates(userMessage: string, now: Date): string[] {
  const dates = new Set<string>();
  const lower = userMessage.toLowerCase();

  const toISODate = (d: Date): string => {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  // 1. today
  if (/\btoday\b/i.test(lower)) {
    dates.add(toISODate(now));
  }

  // 2. yesterday
  if (/\byesterday\b/i.test(lower)) {
    const y = new Date(now);
    y.setDate(now.getDate() - 1);
    dates.add(toISODate(y));
  }

  // 3. last week / past week
  if (/\b(?:last|past)\s+week\b/i.test(lower)) {
    for (let i = 1; i <= 7; i++) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      dates.add(toISODate(d));
    }
  }

  // 4. weekdays (e.g. "monday", "last tuesday")
  for (const [weekday, dayNum] of Object.entries(WEEKDAYS)) {
    const regex = new RegExp(`\\b(?:last\\s+|past\\s+|this\\s+|on\\s+)?${weekday}\\b`, 'i');
    if (regex.test(lower)) {
      const currentDay = now.getDay();
      let diff = (currentDay - dayNum + 7) % 7;
      if (diff === 0) diff = 7;
      const target = new Date(now);
      target.setDate(now.getDate() - diff);
      dates.add(toISODate(target));
    }
  }

  const monthNames = Object.keys(MONTH_MAP).join('|');

  // 5. Month Day: e.g. "November 3", "Nov 3rd", "November 3 2026"
  const monthDayRegex = new RegExp(`\\b(${monthNames})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+(\\d{4}))?\\b`, 'gi');
  let match: RegExpExecArray | null;
  while ((match = monthDayRegex.exec(lower)) !== null) {
    const m = MONTH_MAP[match[1].toLowerCase()];
    const d = parseInt(match[2], 10);
    const y = match[3] ? parseInt(match[3], 10) : now.getFullYear();
    if (m && d >= 1 && d <= 31) {
      dates.add(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    }
  }

  // 6. Day Month: e.g. "3 November", "3rd of November", "3rd Nov 2026"
  const dayMonthRegex = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+(${monthNames})(?:\\s+(\\d{4}))?\\b`, 'gi');
  while ((match = dayMonthRegex.exec(lower)) !== null) {
    const d = parseInt(match[1], 10);
    const m = MONTH_MAP[match[2].toLowerCase()];
    const y = match[3] ? parseInt(match[3], 10) : now.getFullYear();
    if (m && d >= 1 && d <= 31) {
      dates.add(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    }
  }

  // 7. ISO YYYY-MM-DD
  const isoRegex = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
  while ((match = isoRegex.exec(lower)) !== null) {
    dates.add(match[0]);
  }

  return Array.from(dates);
}

export function extractFTSKeywords(userMessage: string): string[] {
  const words = userMessage.split(/\s+/);
  const keywords: string[] = [];

  for (const raw of words) {
    const sanitized = raw.replace(/[^a-zA-Z0-9]/g, '').trim();
    if (sanitized.length >= 3 && !STOPWORDS.has(sanitized.toLowerCase())) {
      keywords.push(sanitized);
    }
  }

  return Array.from(new Set(keywords));
}

export function retrieveTemporalContext(
  userMessage: string,
  sessionId: string,
  now = new Date()
): string {
  // (a) Fetch the last 8 messages in sessionId for immediate conversational continuity
  const recentMessages = db.prepare(`
    SELECT * FROM messages
    WHERE session_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 8
  `).all(sessionId) as MessageRecord[];

  // (b) Temporal queries across sessions
  const targetDates = extractTargetDates(userMessage, now);
  let dateRows: MessageRecord[] = [];
  if (targetDates.length > 0) {
    const placeholders = targetDates.map(() => '?').join(', ');
    dateRows = db.prepare(`
      SELECT * FROM messages
      WHERE substr(created_at, 1, 10) IN (${placeholders})
    `).all(...targetDates) as MessageRecord[];
  }

  // (c) Keyword FTS search
  const keywords = extractFTSKeywords(userMessage);
  let ftsRows: MessageRecord[] = [];
  if (keywords.length > 0) {
    try {
      const ftsQuery = keywords.join(' OR ');
      ftsRows = db.prepare(`
        SELECT m.* FROM messages_fts fts
        JOIN messages m ON fts.rowid = m.id
        WHERE messages_fts MATCH ?
        LIMIT 6
      `).all(ftsQuery) as MessageRecord[];
    } catch {
      ftsRows = [];
    }
  }

  // Deduplicate rows by id
  const map = new Map<number, MessageRecord>();
  for (const row of [...recentMessages, ...dateRows, ...ftsRows]) {
    map.set(row.id, row);
  }

  // Sort chronologically (created_at ASC, id ASC)
  const sorted = Array.from(map.values()).sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id
  );

  // Format: [<human_date> | <ISO timestamp>] <Role>: <content> (Sources: <urls if any>)
  const lines: string[] = [];
  for (const row of sorted) {
    const roleName = row.role === 'user' ? 'User' : 'Assistant';
    let urls: string[] = [];
    try {
      const parsed = JSON.parse(row.sources_json || '[]');
      if (Array.isArray(parsed)) {
        urls = parsed
          .map((item: any) => (typeof item === 'string' ? item : item?.url))
          .filter(Boolean);
      }
    } catch {
      urls = [];
    }
    const sourcesPart = urls.length > 0 ? ` (Sources: ${urls.join(', ')})` : '';
    lines.push(`[${row.human_date} | ${row.created_at}] ${roleName}: ${row.content}${sourcesPart}`);
  }

  let formatted = lines.join('\n');
  if (formatted.length > 6000) {
    formatted = formatted.slice(0, 6000);
  }

  return formatted;
}
