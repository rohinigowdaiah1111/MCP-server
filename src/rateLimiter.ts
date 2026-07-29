import { AppError } from "./errors.js";

/**
 * Simple in-memory sliding-window rate limiter, applied per tool
 * (implementationplan.md, Section 9 — Phase 5 hardening). Protects both this
 * process and the caller's Google API quota from a runaway/misbehaving agent
 * issuing rapid-fire tool calls.
 *
 * A single local MCP server process handles one user's traffic, so a
 * per-process, per-tool window (rather than a distributed store) is
 * sufficient here.
 */
const WINDOW_MS = 60_000;
const MAX_CALLS_PER_WINDOW = Number(process.env.RATE_LIMIT_PER_MINUTE ?? 60);

const callTimestamps = new Map<string, number[]>();

export function enforceRateLimit(tool: string): void {
  const now = Date.now();
  const windowStart = now - WINDOW_MS;
  const timestamps = (callTimestamps.get(tool) ?? []).filter((t) => t > windowStart);

  if (timestamps.length >= MAX_CALLS_PER_WINDOW) {
    const retryAfterMs = timestamps[0] + WINDOW_MS - now;
    throw new AppError(
      "RATE_LIMITED",
      `Too many calls to "${tool}" (${MAX_CALLS_PER_WINDOW}/min limit). Please slow down.`,
      { retryable: true, details: { retryAfterMs: Math.max(retryAfterMs, 0) } }
    );
  }

  timestamps.push(now);
  callTimestamps.set(tool, timestamps);
}
