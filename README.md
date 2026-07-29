# Gmail + Google Docs MCP Server

An [MCP](https://modelcontextprotocol.io) server that gives an AI agent tools to:

- Draft and send Gmail emails
- Create Google Docs and append content to them

Built with the official `@modelcontextprotocol/sdk` and Google's `googleapis` client, using a one-time OAuth 2.0 browser login (no Google Workspace admin setup required — works with a normal personal or Workspace Gmail account).

## Tools exposed

| Tool | Description |
|---|---|
| `gmail_create_draft` | Creates a draft email (not sent) |
| `gmail_send_email` | Sends an email immediately |
| `gmail_send_draft` | Sends a previously created draft by ID |
| `gmail_list_drafts` | Lists existing drafts |
| `docs_create` | Creates a new Google Doc, optionally with initial text |
| `docs_append_text` | Appends text to the end of an existing Google Doc (safe under concurrent edits — see below) |
| `server_metrics` | Returns per-tool call counts, error rates, and latency for this running server |

`gmail_create_draft` and `gmail_send_email` also accept an optional `attachments` array (up to 10 files, 20MB each): `{ filename, contentBase64, mimeType }`.

## 1. Set up Google Cloud credentials

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and create (or select) a project.
2. Enable these two APIs (APIs & Services > Library):
   - **Gmail API**
   - **Google Docs API**
3. Configure the OAuth consent screen (APIs & Services > OAuth consent screen):
   - User type: "External" is fine for personal use (add yourself as a test user), or "Internal" if using a Workspace account.
4. Create credentials (APIs & Services > Credentials > Create Credentials > OAuth client ID):
   - Application type: **Desktop app** (accepts any loopback redirect URI, so `GOOGLE_REDIRECT_URI` below doesn't need to be pre-registered).
5. Copy `.env.example` to `.env` and fill in `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from that OAuth client (adjust `GOOGLE_REDIRECT_URI` too if you want a different local port/path).

## 2. Install dependencies and build

```bash
npm install
npm run build
```

## 3. Authorize (one-time)

```bash
npm run authorize
```

This opens your browser to sign in to Google and grant access to Gmail (compose/send) and Docs. After you approve, tokens are saved to the path in `GOOGLE_TOKEN_STORAGE_PATH` (default `tokens.json` in the project root). Re-run this if you ever revoke access or delete that file.

`.env` and the token storage file contain secrets — they're already excluded via `.gitignore` and should never be committed.

## 4. Run the server

```bash
npm start
```

By default (`MCP_TRANSPORT=stdio`) the server communicates over stdio, so normally you won't run it directly — instead point your MCP client (e.g. Cursor) at it. To host it remotely instead (e.g. on Render), see [`deployment-plan.md`](./deployment-plan.md) and the "Remote (HTTP) hosting" section below.

## 5. Connect it to Cursor

Add this to your `mcp.json` (Cursor Settings > MCP, or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "gmail-docs": {
      "command": "node",
      "args": ["C:\\Users\\thriv\\OneDrive\\Documents\\BuildMCP\\dist\\index.js"]
    }
  }
}
```

Restart Cursor (or reload MCP servers) and the tools above will become available to the agent.

## Configuration

Required (see `.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `GOOGLE_CLIENT_ID` | _(required)_ | OAuth client ID from Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | _(required)_ | OAuth client secret from Google Cloud Console |
| `GOOGLE_REDIRECT_URI` | `http://localhost:3000/oauth2callback` | Redirect URI used for the one-time `npm run authorize` flow; `npm run authorize` listens on whatever host/port/path this specifies |
| `GOOGLE_TOKEN_STORAGE_PATH` | `./tokens.json` | Where the access/refresh token is stored (encrypted at rest); relative paths resolve from the project root |
| `MCP_SERVER_NAME` | `google-workspace-mcp-server` | Name this server reports over MCP |
| `LOG_LEVEL` | `info` | Structured (JSON) log verbosity written to stderr: `trace`\|`debug`\|`info`\|`warn`\|`error`\|`fatal` |

Remote (HTTP) transport — only relevant when hosting this server remotely instead of running it locally via stdio (see [`deployment-plan.md`](./deployment-plan.md)):

| Variable | Default | Purpose |
|---|---|---|
| `MCP_TRANSPORT` | `stdio` | `"stdio"` for local Cursor usage, or `"http"` to bind an HTTP server instead (for remote hosting) |
| `PORT` | `8080` | Port the HTTP transport binds to (`0.0.0.0`). Render (default `10000`) or Railway injects this automatically — don't set it yourself there. |
| `MCP_AUTH_TOKEN` | _(required if `MCP_TRANSPORT=http`)_ | Shared secret remote clients must send as `Authorization: Bearer <token>` to `/mcp`, and `?token=<token>` to `/authorize`. The server refuses to start in http mode without it. |

Optional:

| Variable | Default | Purpose |
|---|---|---|
| `GOOGLE_APPLICATION_CREDENTIALS` | _(unset)_ | Path to a service-account key file. **Not yet used** — reserved for a future service-account auth mode; see the `NOTE` comment in `src/auth.ts`. |
| `ALLOWED_GOOGLE_ACCOUNTS` | _(unset, i.e. any account)_ | Comma-separated email allowlist. **Not yet enforced** — see the `NOTE` comment in `src/auth.ts` for what's needed to wire it up (requires the `openid`/`userinfo.email` scopes). |
| `ENABLE_HTML_EMAIL` | `true` | If `false`, `gmail_create_draft`/`gmail_send_email` reject `isHtml: true` with an `INVALID_INPUT` error |
| `ENABLE_DOCS_APPEND` | `true` | If `false`, the `docs_append_text` tool is not registered at all |

Additional hardening (kept from the previous `.env` layout — see `.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `RATE_LIMIT_PER_MINUTE` | `60` | Max calls allowed per tool per rolling 60s window before returning a `RATE_LIMITED` error |
| `MAX_CONFLICT_RETRIES` | `3` | Retry attempts for `docs_append_text` when a concurrent edit is detected |
| `MAX_ATTACHMENT_BYTES` | `20971520` (20MB) | Max size per email attachment |
| `TOKEN_ENCRYPTION_KEY` | _(auto-generated)_ | Base64, 32-byte key used to encrypt the token storage file at rest; if unset, a random key is generated once into `.token.key` |

## Notes & safety

- `gmail_send_email` sends immediately with no human review — if you want a safety net, have the agent use `gmail_create_draft` and then a human sends it from Gmail (or call `gmail_send_draft` explicitly).
- The Gmail scope used is `gmail.compose`, which allows creating/sending drafts and sending messages, but does **not** grant read access to the mailbox.
- The Docs scope used is `documents`, which allows creating and editing docs but does not touch other Drive files.
- Access tokens refresh automatically and are persisted back to the token storage file, which is encrypted at rest (AES-256-GCM). Existing plaintext token files are migrated transparently on first read.

## Reliability & observability (Phase 5 hardening)

- **Structured errors:** every tool failure is normalized to `Error [CODE]: message`, where `CODE` is one of `INVALID_INPUT`, `REAUTH_REQUIRED`, `RATE_LIMITED`, `UPSTREAM_ERROR`, `CONFLICT`, or `INTERNAL_ERROR`, plus a `retryable` hint and a `requestId` for correlating with logs.
- **Rate limiting:** each tool is capped at `RATE_LIMIT_PER_MINUTE` calls/minute (in-process, sliding window) to protect your Google API quota from a runaway agent loop.
- **Conflict-safe Docs writes:** `docs_append_text` reads the document's current revision and writes with `writeControl.requiredRevisionId`; if another edit races it, the request is retried with exponential backoff (`MAX_CONFLICT_RETRIES` attempts) instead of silently overwriting.
- **Structured logs:** JSON logs go to stderr (never stdout, which is reserved for the MCP protocol channel) with a `requestId` per tool call. Only non-sensitive metadata is logged (e.g. recipient counts, string lengths) — email bodies, document text, attachment bytes, and tokens are never written to logs.
- **Metrics:** call the `server_metrics` tool at any time to see call counts, error rates, and average latency per tool for the running process.

## Remote (HTTP) hosting

Setting `MCP_TRANSPORT=http` switches the entrypoint to bind an HTTP server (instead of stdio) exposing:

- `GET /health` — unauthenticated; returns `200 { status: "ok" }` for platform health checks.
- `POST/GET/DELETE /mcp` — the actual MCP endpoint (Streamable HTTP transport), gated by `Authorization: Bearer <MCP_AUTH_TOKEN>`.
- `GET /authorize` — starts the Google consent flow remotely (gated by `?token=<MCP_AUTH_TOKEN>` since it's opened in a browser). Needed because a headless remote server has no browser for `npm run authorize` to open.
- `GET <path from GOOGLE_REDIRECT_URI>` — Google's OAuth callback; exchanges the code and persists the token, no restart required.

This mode is stateless: each `/mcp` request gets its own short-lived MCP server + transport pair (per the SDK's guidance for stateless HTTP hosting), so a single process can serve concurrent requests without cross-talk. The in-memory rate limiter and metrics are still per-process, so run a single instance (see `deployment-plan.md`, Phase 11).

Full step-by-step Render deployment instructions (persistent Disk for token storage, environment variables, redirect URI updates, CI, etc.) are in [`deployment-plan.md`](./deployment-plan.md). `render.yaml` at the repo root declares the service, disk, and env vars for a one-click Render Blueprint deploy (a `railway.json` is also kept in the repo if you'd rather deploy to Railway instead).

## Project structure

```
src/
  config.ts       - env-driven settings: OAuth client, token path, server name, scopes, transport, feature toggles, hardening limits
  errors.ts        - AppError type + Google API error -> standardized error code mapping
  logging.ts       - structured pino logger (stderr-only) + per-request correlation IDs
  metrics.ts       - in-memory per-tool call/error/latency counters
  rateLimiter.ts   - per-tool sliding-window rate limiting
  tokenCrypto.ts   - AES-256-GCM encryption at rest for token.json
  auth.ts          - OAuth2 client creation + encrypted token load/save (stdio: eager/fail-fast; HTTP: lazy/non-throwing)
  authorize.ts     - one-time interactive `npm run authorize` script (local/stdio setup)
  gmail.ts         - GmailClient: createDraft, sendEmail (with attachments), sendDraft, listDrafts
  docs.ts          - DocsClient: createDocument, appendText (conflict-safe with retries)
  mcpServer.ts     - createMcpServer(): tool registry + shared logging/rate-limit/error middleware (used by both transports)
  httpServer.ts    - Streamable HTTP transport: /health, /mcp (bearer-token gated), /authorize, OAuth callback
  index.ts         - entrypoint; picks stdio or HTTP transport based on MCP_TRANSPORT

render.yaml        - Render Blueprint (web service, persistent disk, env vars) — see deployment-plan.md
railway.json       - equivalent config for Railway, kept for reference
```
