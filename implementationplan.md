# Implementation Plan: Generic MCP Server for AI Agent Integrations

This plan translates the [Problem Statement](./problemstatement.md) into a concrete, phased engineering plan for building a generic, extensible MCP server that lets AI agents send Gmail emails and append content to Google Docs.

## 1. Guiding Principles

- **Protocol-first:** Build on the standard [Model Context Protocol (MCP)](https://modelcontextprotocol.io) spec so any MCP-compatible agent (Cursor, Claude, custom agents) can consume the server with zero custom integration code.
- **Provider abstraction:** No tool implementation should hardcode "Gmail" or "Google Docs" logic directly into the server core — each integration is a pluggable "connector" behind a common interface, so adding Slack/Notion/Calendar later means adding a connector, not modifying the core.
- **Secure by default:** Tokens are never exposed to the calling agent; all OAuth handling and credential storage happens server-side.
- **Fail loud, fail useful:** Every error surfaced to an agent is structured, actionable, and logged with correlation IDs.

## 2. High-Level Architecture

```
                          ┌─────────────────────────┐
                          │        AI Agents         │
                          │ (Cursor, Claude, custom)  │
                          └────────────┬─────────────┘
                                       │ MCP (stdio / HTTP+SSE)
                          ┌────────────▼─────────────┐
                          │       MCP Server Core      │
                          │  - Tool Registry            │
                          │  - Request Validation (Zod) │
                          │  - Auth Middleware           │
                          │  - Logging / Tracing          │
                          └──────┬──────────────┬────────┘
                                 │              │
                     ┌───────────▼───┐   ┌──────▼─────────┐
                     │ Gmail Connector │   │ Docs Connector  │
                     │ (send_email)    │   │ (append_content)│
                     └───────┬─────────┘   └──────┬──────────┘
                             │                     │
                     ┌───────▼─────────────────────▼────────┐
                     │   Google Auth Service (OAuth 2.0)      │
                     │  - Token store (encrypted, per-user)   │
                     │  - Refresh & revoke handling            │
                     └────────────────┬────────────────────────┘
                                      │
                          ┌───────────▼────────────┐
                          │   Google APIs (Gmail,    │
                          │   Docs, People, etc.)     │
                          └───────────────────────────┘
```

**Key modules:**
1. **MCP Server Core** — protocol transport, tool registration, schema validation, cross-cutting middleware (auth, logging, rate limiting).
2. **Connector Interface** — a common `Connector` contract (`name`, `tools[]`, `authProvider`) that every integration implements.
3. **Gmail Connector** — implements `send_email` tool.
4. **Google Docs Connector** — implements `append_to_doc` tool.
5. **Auth Service** — shared OAuth 2.0 flow + token storage, reusable across all Google-based connectors (and future providers).
6. **Observability layer** — structured logging, request tracing, metrics.

## 3. Tech Stack

| Layer | Choice | Rationale |
|---|---|---|
| Language/runtime | TypeScript on Node.js 20+ | First-class support in the official `@modelcontextprotocol/sdk`; strong typing for schemas. |
| MCP framework | `@modelcontextprotocol/sdk` | Official SDK, handles stdio/HTTP transports and protocol handshake. |
| Schema validation | `zod` | Type-safe input/output schemas, shared between validation and TypeScript types. |
| Google API access | `googleapis` (official Node client) | Maintained, covers Gmail + Docs + OAuth2 client in one package. |
| Token storage | SQLite (dev) / Postgres (prod) via `Prisma` ORM, values encrypted with `libsodium`/AES-256-GCM | Simple to start, swappable for prod scale; encryption at rest for tokens. |
| Logging | `pino` (structured JSON logs) | Low overhead, easy to pipe into log aggregators. |
| Testing | `vitest` + `nock`/`msw` for mocking Google API calls | Fast, TS-native, good mocking ergonomics. |
| Config/secrets | `.env` via `dotenv` locally; secret manager (e.g., Doppler/Vault/cloud secret manager) in prod | Keeps client secrets out of source control. |
| Packaging | npm workspaces (`core`, `connectors/gmail`, `connectors/gdocs`) | Enforces the connector-as-plugin boundary from day one. |

## 4. Repository Structure

```
mcp-server/
├── packages/
│   ├── core/                  # MCP server bootstrap, tool registry, middleware
│   │   ├── src/
│   │   │   ├── server.ts
│   │   │   ├── connector.ts   # Connector interface/contract
│   │   │   ├── auth/          # Shared OAuth2 utilities
│   │   │   ├── logging.ts
│   │   │   └── errors.ts
│   │   └── package.json
│   ├── connector-gmail/
│   │   ├── src/
│   │   │   ├── index.ts       # registers `send_email` tool
│   │   │   ├── schema.ts      # zod input/output schemas
│   │   │   └── client.ts      # Gmail API wrapper
│   │   └── package.json
│   └── connector-gdocs/
│       ├── src/
│       │   ├── index.ts       # registers `append_to_doc` tool
│       │   ├── schema.ts
│       │   └── client.ts      # Docs API wrapper
│       └── package.json
├── prisma/
│   └── schema.prisma          # token store models
├── test/
├── .env.example
├── docker-compose.yml
└── README.md
```

## 5. Tool API Design

### 5.1 `send_email` (Gmail Connector)

**Request schema:**
```ts
{
  to: string[];          // required, validated emails
  cc?: string[];
  bcc?: string[];
  subject: string;       // required
  body: string;          // required, plain text or HTML
  bodyType?: "text" | "html"; // default "text"
  attachments?: { filename: string; contentBase64: string; mimeType: string }[];
  userId: string;        // identifies whose Google credentials to use
}
```

**Response schema:**
```ts
{
  success: boolean;
  messageId?: string;
  threadId?: string;
  error?: { code: string; message: string };
}
```

### 5.2 `append_to_doc` (Google Docs Connector)

**Request schema:**
```ts
{
  documentId: string;         // required
  content: string;            // required
  format?: "plainText" | "markdown"; // default "plainText"
  insertAt?: "end" | "afterHeading"; // default "end"
  headingText?: string;       // required if insertAt === "afterHeading"
  userId: string;
}
```

**Response schema:**
```ts
{
  success: boolean;
  documentId: string;
  updatedRevisionId?: string;
  error?: { code: string; message: string };
}
```

Concurrent-update safety: fetch the doc's current `revisionId` before writing, use Google Docs `batchUpdate` with `writeControl.requiredRevisionId`, and retry with exponential backoff on `409` conflicts (up to N attempts) before surfacing a structured conflict error.

## 6. Authentication & Security (OAuth 2.0)

1. **Auth flow:** Standard Google OAuth 2.0 Authorization Code flow with PKCE, run through a small local/hosted callback endpoint (`/oauth/callback`) separate from the MCP transport.
2. **Scopes (least privilege):**
   - `https://www.googleapis.com/auth/gmail.send`
   - `https://www.googleapis.com/auth/documents`
3. **Token storage:** Access + refresh tokens encrypted at rest (AES-256-GCM), keyed by `userId`; never returned to the agent in tool responses.
4. **Token refresh:** Auth Service transparently refreshes expired access tokens before each API call; failures return a `REAUTH_REQUIRED` structured error so the calling agent/user can re-trigger consent.
5. **Secrets management:** OAuth client ID/secret loaded from environment/secret manager, never committed.
6. **Transport security:** MCP over stdio for local/dev; MCP over HTTP+SSE with TLS for remote deployments, with a bearer-token or mTLS layer authenticating the *agent* to the *server* (separate from the Google user OAuth).

## 7. Error Handling & Logging

- Centralized `MCPError` class with `code`, `httpStatus`-equivalent, `retryable` flag, and safe `message` (no leaking secrets/stack traces to agents).
- Standard error codes: `INVALID_INPUT`, `REAUTH_REQUIRED`, `RATE_LIMITED`, `UPSTREAM_ERROR`, `CONFLICT`, `INTERNAL_ERROR`.
- Every request gets a correlation/request ID propagated through logs and included in error responses for debugging.
- Structured JSON logs (`pino`) with levels; no PII (email bodies, tokens) logged at info level — only at debug level behind a flag, and redacted in prod.
- Metrics: request count, latency, error rate per tool (exposed via Prometheus-compatible `/metrics` endpoint).

## 8. Extensibility Model

New services are added by implementing the `Connector` interface:

```ts
interface Connector {
  name: string;
  authProvider: AuthProvider;     // e.g., reuse GoogleAuthProvider or add SlackAuthProvider
  tools: ToolDefinition[];        // each with name, zod schema, handler
}
```

The core server auto-discovers connectors registered in `packages/*` at startup and merges their tools into a single MCP tool registry — no changes to `core` needed to add Slack/Notion/Calendar later.

## 9. Phased Delivery Plan

| Phase | Scope | Duration (est.) |
|---|---|---|
| **Phase 0: Setup** | Repo scaffolding, npm workspaces, CI pipeline, lint/format config, `.env` templates | 2–3 days |
| **Phase 1: Core MCP server** | Implement server bootstrap with `@modelcontextprotocol/sdk`, tool registry, connector interface, error/logging framework | 3–5 days |
| **Phase 2: Auth Service** | OAuth 2.0 flow, encrypted token store (Prisma + SQLite/Postgres), refresh logic, `REAUTH_REQUIRED` handling | 4–5 days |
| **Phase 3: Gmail Connector** | `send_email` tool: schema, MIME/attachment handling, Gmail API integration, unit + integration tests | 3–4 days |
| **Phase 4: Google Docs Connector** | `append_to_doc` tool: schema, revision-safe append logic, formatting (plain/markdown → Docs requests), conflict retry, tests | 4–5 days |
| **Phase 5: Observability & Hardening** | Structured logging, metrics endpoint, rate limiting, input sanitation, security review | 3–4 days |
| **Phase 6: Docs & Packaging** | README, API reference docs, `docker-compose` for local dev, example agent configs (Cursor `mcp.json`) | 2 days |
| **Phase 7: Validation** | End-to-end tests against real Gmail/Docs test accounts, load testing basic concurrency, UAT with a sample agent | 3 days |

**Total estimate:** ~4 weeks for a single engineer (parallelizable across 2 engineers to ~2.5 weeks by splitting connectors from core/auth work).

## 10. Testing Strategy

- **Unit tests:** Schema validation, connector business logic (mocked Google API responses via `nock`/`msw`).
- **Integration tests:** Real calls against a sandboxed Google Workspace test account (behind a CI secret, run on a schedule rather than every PR to avoid quota issues).
- **Contract tests:** Verify tool schemas conform to MCP tool-definition spec so any compliant agent can introspect them.
- **Concurrency tests:** Simulate simultaneous `append_to_doc` calls to validate conflict-retry logic.
- **Security tests:** Token leakage checks (ensure tokens never appear in logs/responses), scope minimization checks.

## 11. Deployment

- **Local/dev:** Run via stdio transport, launched directly by the agent (e.g., Cursor `mcp.json` entry pointing at `node dist/server.js`).
- **Shared/prod:** Containerize (`Dockerfile` + `docker-compose.yml`), deploy behind HTTPS with the MCP HTTP+SSE transport, Postgres for token storage, secrets injected via cloud secret manager.
- **CI/CD:** GitHub Actions — lint, typecheck, unit tests on every PR; integration tests + build/publish Docker image on merge to `main`.

## 12. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Google API rate limits under multi-agent load | Implement request queuing/backoff per user; expose `RATE_LIMITED` error with `retryAfter`. |
| Token leakage or over-broad scopes | Least-privilege scopes, encrypted storage, redacted logging, periodic secret audits. |
| Concurrent Google Docs edits causing lost updates | Revision-controlled `batchUpdate` with retry-on-conflict (Section 5.2). |
| Tight coupling creeping back into core as connectors grow | Enforce the `Connector` interface via lint rule/type check; code review checklist item. |
| MCP spec evolving | Pin SDK version, track upstream changelog, isolate protocol-transport code in `core` only. |

## 13. Next Steps

1. Confirm tech stack choices (TypeScript/Node vs. alternative) with stakeholders.
2. Scaffold repository per Section 4 (Phase 0).
3. Stand up Google Cloud project, enable Gmail + Docs APIs, register OAuth consent screen and client credentials.
4. Begin Phase 1 (core MCP server) implementation.
