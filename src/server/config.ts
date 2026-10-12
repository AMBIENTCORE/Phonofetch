import { z } from "zod";

const configSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_PATH: z.string().min(1).default("/data/phonofetch.sqlite"),
  SLSKD_BASE_URL: z.url().default("http://slskd:5030"),
  SLSKD_API_KEY: z.string().min(1),
  PHONOFETCH_AUTH_USERNAME: z.string().min(1),
  PHONOFETCH_AUTH_PASSWORD: z.string().min(12),
  PHONOFETCH_SESSION_SECRET: z.string().min(32),
  TRUST_PROXY: z.enum(["true", "false"]).default("false").transform(value => value === "true"),
  SEARCH_CONCURRENCY: z.coerce.number().int().min(1).max(5).default(2),
  SEARCH_TIMEOUT_MS: z.coerce.number().int().min(10000).max(120000).default(45000),
  SEARCH_RESULT_LIMIT: z.coerce.number().int().min(1).max(500).default(120),
  MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(3),
  AUTO_TRACK_SCORE: z.coerce.number().min(0.8).max(1).default(0.93),
  AUTO_ALBUM_SCORE: z.coerce.number().min(0.9).max(1).default(0.98),
  MAX_FOLDER_FILES: z.coerce.number().int().min(1).max(2000).default(250),
  MAX_FOLDER_BYTES: z.coerce.number().int().positive().default(10737418240)
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return configSchema.parse(env);
}
