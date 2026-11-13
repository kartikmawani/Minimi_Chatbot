import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    env: {
      GOOGLE_GENERATIVE_AI_API_KEY: 'mock-google-api-key',
      TAVILY_API_KEY: 'mock-tavily-api-key',
      MODEL_NAME: 'gemini-2.5-flash',
      LOG_RAW_PAYLOADS: 'false',
    },
  },
});
