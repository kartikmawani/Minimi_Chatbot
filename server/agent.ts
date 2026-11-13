import { streamText, stepCountIs } from 'ai';
import { google } from '@ai-sdk/google';
import { ENV } from './env.js';
import { webSearchTool } from './searchTool.js';
import { formatHumanDate, retrieveTemporalContext } from './memory.js';

export const PROMPT_VERSION = 'agent.v1';

export const STATIC_SYSTEM_PROMPT = `You are an expert AI research assistant equipped with real-time web search and conversation memory.

RULES AND CONSTRAINTS:
1. Past Conversation & Date Reference Rule:
   - Quote exact past questions and answers when asked about prior dates (e.g. "on Monday", "on 3 November", "last Tuesday") based on the retrieved conversation history.
2. Verification & Live Research Rule:
   - Whenever asked if an old answer is still accurate or if pricing/features changed since a past date, treat history as a point-in-time snapshot and you MUST call web_search to verify current facts.
3. Parallel Tool Calling:
   - Emit parallel web_search calls in a single step when checking multiple entities (e.g., checking 5 CRM tools).
4. Conflict Rule (Recency Wins):
   - When old conversation history and live search results conflict, recency wins—explicitly explain what changed since the earlier date.
5. Refusal Rule:
   - If web_search returns an error or empty/unverified results, honestly state that current data could not be verified rather than guessing.
6. Grounding Rule:
   - Cite sources inline [1], [2] using ONLY URLs returned by web_search. Never invent URLs.`;

export function buildSystemPrompt(temporalContext: string, now = new Date()): string {
  const humanDateStr = formatHumanDate(now);
  const timeStr = now.toLocaleTimeString('en-US', { hour12: false });
  const dynamicSuffix = `

Current Date & Time: ${humanDateStr}, ${timeStr}

RETRIEVED CONVERSATION HISTORY:
${temporalContext || 'No prior conversation history recorded.'}`;

  return STATIC_SYSTEM_PROMPT + dynamicSuffix;
}

export interface RunChatAgentStreamOptions {
  userMessage: string;
  sessionId: string;
  abortSignal?: AbortSignal;
}

export async function runChatAgentStream({
  userMessage,
  sessionId,
  abortSignal,
}: RunChatAgentStreamOptions) {
  const temporalContext = retrieveTemporalContext(userMessage, sessionId);
  const system = buildSystemPrompt(temporalContext);

  const isGemini25 = ENV.MODEL_NAME.startsWith('gemini-2.5');
  const providerOptions = isGemini25
    ? {
        google: {
          thinkingConfig: {
            thinkingBudget: 0,
          },
        },
      }
    : undefined;

  return streamText({
    model: google(ENV.MODEL_NAME),
    system,
    messages: [{ role: 'user', content: userMessage }],
    tools: {
      web_search: webSearchTool,
    },
    stopWhen: stepCountIs(4),
    temperature: 0.2,
    abortSignal,
    providerOptions,
  });
}
