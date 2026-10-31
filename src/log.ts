import { pino, type Logger } from "pino";

// Message text, tokens and auth headers never reach the logs.
const REDACT = [
  "token",
  "*.token",
  "access_token",
  "*.access_token",
  "authorization",
  "*.authorization",
  "headers.authorization",
  "text",
  "*.text",
  "secret",
  "*.secret",
];

export function createLogger(level = "info"): Logger {
  return pino({ level, redact: { paths: REDACT, censor: "[redacted]" }, base: undefined });
}

export type { Logger };
