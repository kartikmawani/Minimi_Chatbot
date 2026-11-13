import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  GOOGLE_GENERATIVE_AI_API_KEY: z
    .string({
      message: 'GOOGLE_GENERATIVE_AI_API_KEY is required',
    })
    .min(1, 'GOOGLE_GENERATIVE_AI_API_KEY cannot be empty'),
  TAVILY_API_KEY: z
    .string({
      message: 'TAVILY_API_KEY is required',
    })
    .min(1, 'TAVILY_API_KEY cannot be empty'),
  MODEL_NAME: z
    .preprocess((val) => {
      if (typeof val === 'string' && val.trim() === '') {
        return undefined;
      }
      return val;
    }, z.string())
    .default('gemini-2.5-flash'),
  PORT: z
    .preprocess((val) => {
      if (typeof val === 'string' && val.trim() === '') {
        return undefined;
      }
      return val;
    }, z.coerce.number())
    .default(3000),
  LOG_RAW_PAYLOADS: z
    .preprocess((val) => {
      if (typeof val === 'string') {
        const lower = val.trim().toLowerCase();
        return lower === 'true' || lower === '1';
      }
      return val === true;
    }, z.boolean())
    .default(false),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Environment validation error:');
  const fieldErrors = parsed.error.flatten().fieldErrors;
  for (const [field, errors] of Object.entries(fieldErrors)) {
    console.error(`  - ${field}: ${(errors ?? []).join(', ')}`);
  }
  process.exit(1);
}

export const ENV = parsed.data;
export const env = ENV;
export type Env = z.infer<typeof envSchema>;
