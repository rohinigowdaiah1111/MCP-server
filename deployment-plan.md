# Deployment Plan: Hosting the Gmail/Docs MCP Server on Railway

This plan covers deploying the MCP server in `BuildMCP` (see [`README.md`](./README.md), [`implementationplan.md`](./implementationplan.md)) to [Railway](https://railway.com) as a persistent, remotely-reachable service.

## 0. Critical prerequisite: this server currently can't be hosted remotely as-is

**Status: done.** `src/index.ts` originally only connected the MCP server over **stdio** (`StdioServerTransport`), which only works when an MCP client (Cursor, Claude Desktop, etc.) spawns the server as a local child process — there's nothing for Railway to "host" over stdio. This has been resolved by Phase 1 below; everything after it is standard Railway deployment mechanics.

## 1. Phase 1 — Add a network (HTTP) MCP transport ✅ implemented

The `@modelcontextprotocol/sdk` version already in `package.json` (`^1.30.0`) ships `StreamableHTTPServerTransport` (`@modelcontextprotocol/sdk/server/streamableHttp.js`), the current standard remote-MCP transport (replaces the older HTTP+SSE transport). Implemented as:

1. No new dependency needed — `StreamableHTTPServerTransport.handleRequest()` works directly against Node's built-in `http` module (`IncomingMessage`/`ServerResponse`), so `src/httpServer.ts` uses `node:http` directly rather than adding `express`.
2. Tool registration was extracted out of `index.ts` into `src/mcpServer.ts`'s `createMcpServer(gmail, docs)` factory — no tool logic changed, only where it lives. It's a *factory* rather than a singleton because the SDK's `Protocol.connect()` only allows one transport per server instance; the HTTP transport is intentionally **stateless**, creating a fresh `McpServer` + `StreamableHTTPServerTransport` pair (`sessionIdGenerator: undefined`) per request, per the SDK's documented pattern for stateless/serverless hosting.
3. `src/httpServer.ts` stands up a plain `http.createServer` that:
   - Listens on `process.env.PORT` (via `config.ts`'s `PORT`, default `8080` locally — Railway injects its own value), bound to `0.0.0.0`.
   - Mounts the transport at `/mcp` for `POST`/`GET`/`DELETE`.
4. **Application-level auth in front of `/mcp`:** a new `MCP_AUTH_TOKEN` env var (`config.ts`) is required whenever `MCP_TRANSPORT=http` — the server refuses to start without it. Requests to `/mcp` are rejected with `401` unless `Authorization: Bearer <MCP_AUTH_TOKEN>` matches exactly. This is separate from, and in addition to, the Google OAuth token used to call Gmail/Docs.
5. `GET /health` is unauthenticated and returns `200 { status: "ok", uptimeSeconds }`.
6. `MCP_TRANSPORT=stdio|http` (`config.ts`, default `stdio`) selects the transport in `index.ts`; local Cursor usage via `node dist/index.js` is unchanged unless this is explicitly set to `http`.
7. To smoke-test locally: set `MCP_TRANSPORT=http` and `MCP_AUTH_TOKEN=<something>` in `.env`, `npm run build && npm start`, then `curl http://localhost:8080/health` and `curl -X POST http://localhost:8080/mcp -H "Authorization: Bearer $MCP_AUTH_TOKEN" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'` before touching Railway.

## 2. Phase 2 — Persistent storage for OAuth tokens

The server reads/writes two files at runtime (see `src/config.ts`, `src/tokenCrypto.ts`):

| File | Purpose | Path source |
|---|---|---|
| `GOOGLE_TOKEN_STORAGE_PATH` (default `./tokens.json`) | Encrypted Google access/refresh token | `.env` |
| `.token.key` | AES-256-GCM key auto-generated on first run if `TOKEN_ENCRYPTION_KEY` isn't set | `PROJECT_ROOT` |

Railway's container filesystem is **ephemeral** — anything written to disk is lost on every redeploy/restart unless it's on a mounted [Volume](https://docs.railway.com/reference/volumes). Two options:

- **Option A (recommended): Railway Volume.** Create a Volume, mount it at e.g. `/data`, and set:
  - `GOOGLE_TOKEN_STORAGE_PATH=/data/tokens.json`
  - Explicitly set `TOKEN_ENCRYPTION_KEY` (see Phase 4) so `.token.key` isn't needed at all — simpler than also relocating `.token.key` onto the volume.
- **Option B: no volume.** Set `TOKEN_ENCRYPTION_KEY` explicitly, and instead of writing `tokens.json` to disk, store the (small, encrypted) token blob directly in a Railway variable (e.g. `GOOGLE_TOKEN_BLOB`) and adapt `auth.ts`'s `loadToken`/`saveToken` to read/write that variable via the [Railway public API](https://docs.railway.com/reference/public-api) instead of `fs`. More moving parts; only worth it if you want to avoid paying for a Volume.

This plan assumes **Option A**.

## 3. Phase 3 — Railway project setup

1. Push this repo to GitHub (Railway deploys from a GitHub repo or the Railway CLI). *(manual — requires your GitHub account; not done by this change)*
2. In Railway: **New Project > Deploy from GitHub repo**, select this repo. Railway auto-detects Node.js via Nixpacks. *(manual — requires your Railway account)*
3. ✅ Done: `railway.json` exists at the repo root with the build/start/health-check config below, reviewable in version control instead of only living in the dashboard:

    ```json
    {
      "$schema": "https://railway.com/railway.schema.json",
      "build": {
        "builder": "NIXPACKS",
        "buildCommand": "npm run build"
      },
      "deploy": {
        "startCommand": "npm start",
        "restartPolicyType": "ON_FAILURE",
        "restartPolicyMaxRetries": 5,
        "healthcheckPath": "/health",
        "healthcheckTimeout": 60
      }
    }
    ```

    **Note:** don't put `npm ci` (or `npm install`) in `buildCommand` — Nixpacks already runs it automatically in its own install phase (detected from `package-lock.json`), which sets up a `node_modules/.cache` mount for that step. Running `npm ci` again in the build phase collides with that mount and fails with `EBUSY: resource busy or locked, rmdir '/app/node_modules/.cache'` ([railwayapp/railpack#255](https://github.com/railwayapp/railpack/issues/255)). `buildCommand` should only contain the actual build step (`npm run build`).

4. Attach a Volume (Phase 2) via the service's **Settings > Volumes**, mount path `/data`. **Do not** mount a volume at `/app` — that would hide your deployed code. *(manual — requires your Railway account)*
5. ✅ Done: `package.json` now pins `"engines": { "node": ">=20" }` so Nixpacks doesn't have to guess the Node version.

## 4. Phase 4 — Environment variables on Railway

Set these under the service's **Variables** tab (never commit them — `.env` stays local-only per `.gitignore`):

| Variable | Value on Railway | Notes |
|---|---|---|
| `GOOGLE_CLIENT_ID` | from Google Cloud Console | same OAuth client as local dev, or a separate one for prod |
| `GOOGLE_CLIENT_SECRET` | from Google Cloud Console | mark sensitive in Railway's UI |
| `GOOGLE_REDIRECT_URI` | `https://<your-railway-domain>/oauth2callback` | **must change from `localhost`** — see Phase 5 |
| `GOOGLE_TOKEN_STORAGE_PATH` | `/data/tokens.json` | on the mounted Volume (Phase 2) |
| `TOKEN_ENCRYPTION_KEY` | a generated 32-byte base64 key | generate once locally (`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`) and set explicitly — don't rely on auto-generated `.token.key`, which won't survive redeploys without the volume |
| `MCP_SERVER_NAME` | `google-workspace-mcp-server` | |
| `LOG_LEVEL` | `info` | |
| `MCP_AUTH_TOKEN` | a generated random token | new var from Phase 1; required by remote clients as a Bearer token |
| `PORT` | _(don't set — Railway injects it)_ | app must read `process.env.PORT` |
| `NODE_ENV` | `production` | |
| `RATE_LIMIT_PER_MINUTE`, `MAX_CONFLICT_RETRIES`, `MAX_ATTACHMENT_BYTES` | same defaults as local, or tune per Phase 6 | already supported by `config.ts` |
| `ALLOWED_GOOGLE_ACCOUNTS`, `ENABLE_HTML_EMAIL`, `ENABLE_DOCS_APPEND`, `GOOGLE_APPLICATION_CREDENTIALS` | as needed | already supported by `config.ts` |

## 5. Phase 5 — Completing the OAuth authorize flow against Railway

`npm run authorize` (`src/authorize.ts`) opens a local browser and a temporary HTTP listener on `GOOGLE_REDIRECT_URI` to catch the auth code. On a headless Railway container there's no browser to open, so:

1. Update the OAuth client in Google Cloud Console to add `https://<your-railway-domain>/oauth2callback` as an **Authorized redirect URI** (required once you're not using a bare "Desktop app" loopback URI). *(manual — do this after you know your Railway domain)*
2. ✅ Code done, manual step remains: `src/httpServer.ts` now exposes `GET /authorize` (redirects to Google's consent screen, gated by `?token=<MCP_AUTH_TOKEN>`) and `GET <GOOGLE_REDIRECT_URI's path>` (exchanges the code, persists the token via the existing `saveToken`/encryption pipeline, and immediately makes the shared `auth` client usable — no restart needed). Once deployed, visit `https://<your-railway-domain>/authorize?token=<MCP_AUTH_TOKEN>` in your own browser once, complete consent, and the Volume-backed token file will be created.
3. Alternative (simpler, less clean) — run `npm run authorize` **locally** against `http://localhost:3000/oauth2callback` as today, then securely copy the resulting encrypted `tokens.json` onto the Railway Volume (`railway ssh`, or a one-off Railway CLI `run` command that copies the file in). Works, but means the token file and the `TOKEN_ENCRYPTION_KEY` must be moved out-of-band and kept in sync.

Either way, treat the token file, `MCP_AUTH_TOKEN`, and `TOKEN_ENCRYPTION_KEY` as production secrets.

## 6. Phase 6 — Networking, security & rate limiting review

- Railway provisions a public HTTPS domain automatically (`*.up.railway.app`, or attach a custom domain) — no TLS setup needed on your end.
- Reconfirm `RATE_LIMIT_PER_MINUTE` (from `src/rateLimiter.ts`) is appropriately tuned now that the server is reachable beyond just your own machine.
- Consider tightening `ALLOWED_GOOGLE_ACCOUNTS` (see `config.ts`/`auth.ts` "NOTE" comments) now that the deployment is internet-facing, or ensure `MCP_AUTH_TOKEN` from Phase 1 is a strong, unique secret and rotate it if ever leaked.
- The structured JSON logs (`src/logging.ts`) already write to stderr and redact tokens/bodies — Railway's log viewer will show these as-is; no extra config needed.

## 7. Phase 7 — CI/CD

- Railway auto-deploys on every push to the connected branch by default (configurable per-branch/per-environment in **Settings > Environments**). *(manual — Railway dashboard)*
- Recommended: keep a `main` branch → production environment, and use a Railway "PR environment" or a separate `staging` Railway environment for testing changes (e.g. to the HTTP transport or OAuth flow) before they hit the token store you actually use day-to-day. *(manual)*
- ✅ Done: `.github/workflows/ci.yml` runs `npm ci && npm run build` on every PR and push to `main`, so broken builds are caught before Railway attempts (and fails) a deploy.

## 8. Phase 8 — Connecting Cursor (or another MCP client) to the deployed server

Once deployed, update `mcp.json` to point at the Railway URL instead of a local `node` process:

```json
{
  "mcpServers": {
    "gmail-docs": {
      "url": "https://<your-railway-domain>/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_AUTH_TOKEN>"
      }
    }
  }
}
```

(Exact key names depend on the MCP client's support for remote/HTTP servers with custom headers — confirm against Cursor's current MCP config schema when you get to this step.)

## 9. Phase 9 — Post-deploy validation

1. `curl https://<your-railway-domain>/health` → expect `200`.
2. Complete the Phase 5 authorize flow; confirm `tokens.json` appears on the Volume (`railway ssh` + `ls /data`, or check the Railway Volume browser).
3. From an MCP client configured per Phase 8, call `server_metrics` — confirms the transport, auth header, and tool registry all work end-to-end.
4. Call `gmail_create_draft` (safe — doesn't send) and `docs_create` to confirm the Google API calls succeed from Railway's egress IPs (Google doesn't IP-allowlist OAuth user tokens, so this should just work, but it's worth confirming).
5. Trigger a redeploy (e.g. push an empty commit) and re-check `/health` and `server_metrics` to confirm the Volume-backed token survived the restart without needing to re-authorize.

## 10. Rollback & ongoing operations

- Railway keeps deployment history — use **Deployments > Redeploy** on a previous build to roll back instantly if a release misbehaves.
- Because `healthcheckPath` is configured, Railway won't route traffic to a new deploy until `/health` passes, avoiding downtime from a bad release (see `railway.json` in Phase 3).
- Token refresh happens automatically in `auth.ts`'s `client.on("tokens", ...)` handler and persists back to the Volume — no manual re-authorization needed unless the refresh token is revoked (Google shows `REAUTH_REQUIRED` errors per `errors.ts` if so; re-run Phase 5's authorize route/flow).

## 11. Cost note

This is a single-user personal integration server with light, bursty traffic (rate-limited to `RATE_LIMIT_PER_MINUTE` per tool). Railway's lowest-tier Hobby plan plus a small Volume should comfortably cover it; no autoscaling or multi-replica setup is needed (the server also isn't currently stateless-safe for multiple replicas — the in-memory rate limiter and metrics in `rateLimiter.ts`/`metrics.ts` are per-process, so stick to a single instance).

## Summary checklist

- [x] Phase 1: Add `StreamableHTTPServerTransport` + `/health` + `MCP_AUTH_TOKEN` auth middleware (`src/httpServer.ts`, `src/mcpServer.ts`)
- [x] Phase 2: Decided — Volume (Option A); no code change needed, `GOOGLE_TOKEN_STORAGE_PATH`/`TOKEN_ENCRYPTION_KEY` already configurable via env
- [ ] Phase 3: ✅ `railway.json` + `engines` added — ⬜ connect GitHub repo, attach Volume (manual, needs your accounts)
- [ ] Phase 4: Set all environment variables in Railway's Variables tab (manual)
- [ ] Phase 5: ✅ `/authorize` + OAuth callback routes implemented — ⬜ update Google OAuth client redirect URI, run the flow once against the deployed URL (manual)
- [ ] Phase 6: Confirm auth token, rate limits, and account allowlist are production-appropriate (manual review once deployed)
- [x] Phase 7: `.github/workflows/ci.yml` added; Railway auto-deploy is a dashboard setting (manual)
- [ ] Phase 8: Update `mcp.json` to point at the Railway URL (manual, once you have a domain)
- [ ] Phase 9: Run through post-deploy validation steps (manual, requires a live deployment)
