/**
 * Lightweight in-memory metrics (implementationplan.md, Section 7).
 *
 * Instead of a Prometheus `/metrics` endpoint, we keep per-tool counters in
 * memory and expose them through the `server_metrics` MCP tool (see
 * mcpServer.ts) — good enough for a single-process server (whether running
 * over stdio or the stateless HTTP transport in httpServer.ts, which shares
 * this same module-level state across requests within one process). Not
 * safe to scale beyond a single instance without a shared backend.
 */

interface ToolStats {
  calls: number;
  errors: number;
  totalLatencyMs: number;
  lastErrorCode?: string;
}

const stats = new Map<string, ToolStats>();
const startedAt = Date.now();

function getOrCreate(tool: string): ToolStats {
  let entry = stats.get(tool);
  if (!entry) {
    entry = { calls: 0, errors: 0, totalLatencyMs: 0 };
    stats.set(tool, entry);
  }
  return entry;
}

export function recordCall(tool: string, latencyMs: number, errorCode?: string): void {
  const entry = getOrCreate(tool);
  entry.calls += 1;
  entry.totalLatencyMs += latencyMs;
  if (errorCode) {
    entry.errors += 1;
    entry.lastErrorCode = errorCode;
  }
}

export function snapshot(): Record<string, unknown> {
  const tools: Record<string, unknown> = {};
  for (const [tool, entry] of stats.entries()) {
    tools[tool] = {
      calls: entry.calls,
      errors: entry.errors,
      errorRate: entry.calls > 0 ? Number((entry.errors / entry.calls).toFixed(3)) : 0,
      avgLatencyMs: entry.calls > 0 ? Number((entry.totalLatencyMs / entry.calls).toFixed(1)) : 0,
      lastErrorCode: entry.lastErrorCode,
    };
  }
  return { uptimeSeconds: Math.round((Date.now() - startedAt) / 1000), tools };
}
