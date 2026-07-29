import pino from "pino";
import { randomUUID } from "node:crypto";

/**
 * Structured logging (implementationplan.md, Section 7).
 *
 * IMPORTANT: this server communicates with its MCP client over stdout, so all
 * logs MUST go to stderr (pino's default `destination: 2`) — anything written
 * to stdout would corrupt the MCP protocol stream.
 *
 * Sensitive fields (tokens, email/document bodies, raw attachment bytes) are
 * redacted at the default log level; set LOG_LEVEL=debug locally only when
 * you need to inspect payloads, never in shared/production environments.
 */
const level = process.env.LOG_LEVEL ?? "info";

// Plain structured JSON logs, written synchronously straight to stderr (fd 2).
// Deliberately avoids pino's async `transport`/worker-thread pipeline (e.g.
// pino-pretty) so nothing can ever interleave with the stdout MCP channel.
export const logger = pino(
  {
    level,
    redact: {
      paths: [
        "*.access_token",
        "*.refresh_token",
        "*.id_token",
        "*.body",
        "*.text",
        "*.contentBase64",
        "*.raw",
        "req.token",
      ],
      censor: "[REDACTED]",
    },
    base: { service: "gmail-docs-mcp-server" },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.destination({ dest: 2, sync: true }) // fd 2 = stderr
);

/** Creates a per-request child logger tagged with a correlation ID for tracing a single tool call. */
export function createRequestLogger(tool: string) {
  const requestId = randomUUID();
  return { requestId, log: logger.child({ requestId, tool }) };
}
