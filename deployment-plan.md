# Deployment Plan: Hosting the Gmail/Docs MCP Server on Render

This plan covers deploying the MCP server in `BuildMCP` (see [`README.md`](./README.md), [`implementationplan.md`](./implementationplan.md)) to [Render](https://render.com) as a persistent, remotely-reachable service.

> **Note:** this project previously targeted Railway (`railway.json`, still present in the repo). This plan supersedes that for Render; `render.yaml` is the Render equivalent of `railway.json`. The two are independent — you can deploy to either platform without deleting the other's config file.

> **Status: deployed.** The service is live at `https://mcp-server-ziee.onrender.com` (`/health` and authenticated `/mcp` verified working). Remaining open item: the Google OAuth client was rotated (see the callout in Phase 1 and updated Phase 4/5 below) — Render's `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` env vars and the deployed `/authorize` flow still need to be re-run against the new client.

## 0. Prerequisite: HTTP transport — ✅ already done

Render, like Railway, runs your app as a long-lived network service — it has no calling process to pipe stdio to, so a stdio-only MCP server can't be hosted there. This was already solved in a prior change:

- `src/httpServer.ts` + `src/mcpServer.ts` implement a Streamable HTTP transport (`StreamableHTTPServerTransport`) at `/mcp`, gated by `Authorization: Bearer <MCP_AUTH_TOKEN>`, plus an unauthenticated `GET /health` and a remote `/authorize` + OAuth callback flow.
- `src/config.ts`'s `MCP_TRANSPORT` (`stdio` default, set to `http` for remote hosting) and `PORT` (reads `process.env.PORT`, binds `0.0.0.0`) already work as-is on Render — **no code changes are needed for the transport itself.** The rest of this plan is Render-specific mechanics only.

## 1. Phase 1 — Render-specific compatibility notes

A few things that differ from Railway and are worth knowing before you deploy:

1. **Port binding:** Render sets the `PORT` env var itself (default `10000`) and expects your server to bind `0.0.0.0:$PORT` — `src/httpServer.ts` already does exactly this via `config.ts`'s `PORT`. Nothing to change.
2. **Build command safety:** Unlike Railway's Nixpacks builder (which runs `npm ci` automatically in a separate install phase and breaks if you also put `npm ci` in your build command — see the `railway.json` history in this repo), Render's Node runtime just runs your **Build Command** and **Start Command** verbatim, once each, in a normal writable filesystem. So `npm ci && npm run build` as the build command is structurally safe on Render — no equivalent `EBUSY`/cache-mount conflict to worry about. **However**, see the very next point — it needs one flag added.
3. **`NODE_ENV=production` breaks the build unless devDependencies are forced:** Render applies every configured env var (including `NODE_ENV=production`, which you want set for the *runtime*) during the *build* step too. `npm ci`/`npm install` treat `NODE_ENV=production` as an implicit `--omit=dev`, silently skipping `devDependencies` — which is where `typescript` and `@types/node` live. The symptom is `tsc` failing with a wall of `TS2591: Cannot find name 'process'/'Buffer'/'node:fs'...` errors, even though the exact same code compiles fine locally. **Fix:** this repo has a committed `.npmrc` with `include=dev`, which forces devDependencies to install on *any* `npm ci`/`npm install` regardless of `NODE_ENV` or what's typed into a platform's dashboard Build Command field — verified locally by running `npm ci` with `NODE_ENV=production` set and confirming `tsc` still succeeds. (`render.yaml`'s `buildCommand` also redundantly passes `--include=dev` as a second safety net.)
4. **Node version:** Render checks, in order: the `NODE_VERSION` env var, a `.node-version` file, a `.nvmrc` file, then `package.json`'s `engines.node`. This repo's `package.json` now pins `"engines": { "node": ">=20 <25" }` — a bounded range, per Render's own recommendation (an unbounded `>=20` would silently ride up to whatever Node major is newest whenever Render updates its default).
5. **Health checks:** `healthCheckPath: /health` (already implemented) works identically to Railway's `healthcheckPath` — Render won't route traffic to a new deploy until it passes.
6. **OAuth client type — must be "Web application", not "Desktop app":** Google's **Desktop app** OAuth client type only supports loopback (`localhost`/`127.0.0.1`) redirect URIs and doesn't let you register arbitrary HTTPS callback URLs in Cloud Console at all. Since Render's `/oauth2callback` is a public HTTPS URL (`https://<service>.onrender.com/oauth2callback`), you need a **Web application**-type OAuth client instead, which requires every redirect URI (including `http://localhost:3000/oauth2callback` for local dev, if still needed) to be explicitly added to that client's **Authorized redirect URIs** allow-list in Google Cloud Console — unlike Desktop clients, Web clients reject anything not on the list with `redirect_uri_mismatch`. If you originally created a Desktop-type client for local dev, you'll need to create a separate Web application client for this deployment (a new `client_id`/`client_secret`, downloaded as a new `credentials.json`) and update `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` everywhere (local `.env` and Render's Environment tab) to match. Any previously-issued `tokens.json` is tied to whichever client requested it, so rotating the client also means re-running the authorize flow (Phase 5) — both locally and on Render.

## 2. Phase 2 — Persistent storage for OAuth tokens

The server reads/writes two files at runtime (see `src/config.ts`, `src/tokenCrypto.ts`):

| File | Purpose | Path source |
|---|---|---|
| `GOOGLE_TOKEN_STORAGE_PATH` (default `./tokens.json`) | Encrypted Google access/refresh token | `.env` / Render env var |
| `.token.key` | AES-256-GCM key auto-generated on first run if `TOKEN_ENCRYPTION_KEY` isn't set | `PROJECT_ROOT` |

**Render's filesystem is ephemeral by default** — any change to local files disappears on every redeploy, restart, *and* (critically, unlike Railway) every time a Free-tier service **spins down from inactivity** (after 15 idle minutes). Without persistent storage, you'd have to re-run the `/authorize` flow constantly.

- **Persistent Disks on Render require a paid instance type ("Starter" or above) — Free web services cannot attach a disk at all.** This is the single biggest practical reason **Free tier is not viable** for this server beyond a quick smoke test: every spin-down would silently discard the token file.
- **Recommended: Starter plan + a Render Disk.** `render.yaml` (added to this repo) already declares:

    ```yaml
    disk:
      name: mcp-token-store
      mountPath: /data
      sizeGB: 1
    ```

  With `GOOGLE_TOKEN_STORAGE_PATH=/data/tokens.json` set (also already in `render.yaml`), tokens survive redeploys and restarts. Also **explicitly set `TOKEN_ENCRYPTION_KEY`** (see Phase 4) rather than relying on the auto-generated `.token.key` — simpler than also relocating that file onto the disk.
- Note a real tradeoff: attaching a disk **disables zero-downtime deploys** for this service (Render briefly stops the old instance before starting the new one, to avoid two instances writing the disk at once) and **caps it at a single instance** — both are already fine for this server (single-user, single-process rate limiter/metrics; see Phase 11).

## 3. Phase 3 — Render service setup

1. Push this repo to GitHub (already done — Render deploys from a GitHub repo, same as Railway).
2. In the [Render Dashboard](https://dashboard.render.com): **New > Blueprint**, select this repo. Render detects `render.yaml` at the repo root and proposes the service, disk, and env vars it declares.
   - Alternative (no Blueprint): **New > Web Service**, select this repo, and manually fill in: Runtime `Node`, Build Command `npm ci && npm run build`, Start Command `npm start`, Instance Type `Starter` (not Free — see Phase 2), Health Check Path `/health`, then add a Disk under the service's **Disks** tab (mount path `/data`, 1 GB).
3. If deploying via Blueprint, Render will prompt you to fill in a value for every env var marked `sync: false` in `render.yaml` (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `MCP_AUTH_TOKEN`, `TOKEN_ENCRYPTION_KEY`) before the first deploy runs — see Phase 4 for what to put in each.
4. Once created, Render assigns a public domain immediately: `https://<service-name>.onrender.com` (no manual "generate domain" step like Railway). You'll need this for `GOOGLE_REDIRECT_URI` in Phase 4/5.

**✅ Done:** the service is live at `https://mcp-server-ziee.onrender.com`.

## 4. Phase 4 — Environment variables on Render

Set these under the service's **Environment** tab (or via the Blueprint prompts in Phase 3) — never commit them; `.env` stays local-only per `.gitignore`:

| Variable | Value on Render | Notes |
|---|---|---|
| `GOOGLE_CLIENT_ID` | from Google Cloud Console | must be a **Web application**-type client, not Desktop — see Phase 1 callout. Can be shared with local dev (as long as both redirect URIs are registered on it) or a separate client for prod. |
| `GOOGLE_CLIENT_SECRET` | from Google Cloud Console | mark as a "secret" in Render's env var editor |
| `GOOGLE_REDIRECT_URI` | `https://mcp-server-ziee.onrender.com/oauth2callback` | **must change from `localhost`** — see Phase 5. If Render's UI rejects editing this because of a "duplicate key" error, edit the existing row in place rather than adding a new one. |
| `GOOGLE_TOKEN_STORAGE_PATH` | `/data/tokens.json` | already set in `render.yaml`; on the mounted disk (Phase 2) |
| `TOKEN_ENCRYPTION_KEY` | a generated 32-byte base64 key | generate once locally: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` — don't rely on auto-generated `.token.key`, which won't survive redeploys without living on the disk too |
| `MCP_SERVER_NAME` | `google-workspace-mcp-server` | already set in `render.yaml` |
| `MCP_TRANSPORT` | `http` | already set in `render.yaml` — **required**, defaults to `stdio` otherwise |
| `MCP_AUTH_TOKEN` | a generated random token | generate once: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` — required by remote clients as a Bearer token |
| `LOG_LEVEL` | `info` | already set in `render.yaml` |
| `NODE_ENV` | `production` | already set in `render.yaml` |
| `PORT` | _(don't set — Render injects it, default `10000`)_ | app already reads `process.env.PORT` |
| `RATE_LIMIT_PER_MINUTE`, `MAX_CONFLICT_RETRIES`, `MAX_ATTACHMENT_BYTES` | same defaults as local, or tune per Phase 6 | already supported by `config.ts`, not in `render.yaml` — add manually if you want non-default values |
| `ALLOWED_GOOGLE_ACCOUNTS`, `ENABLE_HTML_EMAIL`, `ENABLE_DOCS_APPEND`, `GOOGLE_APPLICATION_CREDENTIALS` | as needed | already supported by `config.ts` |

## 5. Phase 5 — Completing the OAuth authorize flow against Render

`npm run authorize` (`src/authorize.ts`) opens a local browser and a temporary HTTP listener on `GOOGLE_REDIRECT_URI` to catch the auth code. On a headless Render instance there's no browser to open, so:

1. Update the OAuth client in Google Cloud Console to add `https://mcp-server-ziee.onrender.com/oauth2callback` as an **Authorized redirect URI** (on the **Web application**-type client — see Phase 1 callout).
2. ✅ Code already handles this: `src/httpServer.ts` exposes `GET /authorize` (redirects to Google's consent screen, gated by `?token=<MCP_AUTH_TOKEN>`) and `GET <GOOGLE_REDIRECT_URI's path>` (exchanges the code, persists the token to the disk via the existing encryption pipeline, and makes the already-running server's Gmail/Docs tools usable immediately — no restart needed). After the first deploy, visit `https://mcp-server-ziee.onrender.com/authorize?token=<MCP_AUTH_TOKEN>` in your own browser once, complete consent, and `tokens.json` will be written to `/data` on the disk.
3. Alternative — run `npm run authorize` **locally** as today, then copy the resulting encrypted `tokens.json` onto the Render disk via **Shell** access (Render Dashboard > service > Shell tab, available on paid plans) — `cat`/paste the file contents into `/data/tokens.json`, or use `scp`-equivalent tooling if you prefer. More manual than option 2; only useful if you don't want to expose `/authorize` at all, even temporarily.

Either way, treat the token file, `MCP_AUTH_TOKEN`, and `TOKEN_ENCRYPTION_KEY` as production secrets.

> **Client rotation note:** if the OAuth client's `client_id`/`client_secret` ever change (e.g. switching from a Desktop-type client to a Web application-type client, as happened during this deployment), any token minted under the old client stops refreshing under the new one. After updating `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` on Render, you must redo step 2 above (re-visit `/authorize?token=...`) even if `/data/tokens.json` already exists from a prior authorization — the old file will cause `REAUTH_REQUIRED`/refresh errors until overwritten by a fresh consent flow against the new client.

## 6. Phase 6 — Networking, security & rate limiting review

- Render provisions a public HTTPS domain and TLS certificate automatically (`*.onrender.com`, or attach a custom domain) — no TLS setup needed on your end.
- Reconfirm `RATE_LIMIT_PER_MINUTE` (from `src/rateLimiter.ts`) is appropriately tuned now that the server is reachable beyond just your own machine.
- Consider tightening `ALLOWED_GOOGLE_ACCOUNTS` (see `config.ts`/`auth.ts` "NOTE" comments) now that the deployment is internet-facing, or ensure `MCP_AUTH_TOKEN` from Phase 1 is a strong, unique secret and rotate it if ever leaked.
- The structured JSON logs (`src/logging.ts`) already write to stderr and redact tokens/bodies — Render's log viewer (Dashboard > service > Logs) will show these as-is; no extra config needed.
- **Don't use the Free instance type in production** (see Phase 2) — beyond losing the token on every spin-down, a Free service also takes ~1 minute to "wake up" on the first request after 15 idle minutes, which most MCP clients will treat as a timeout.

## 7. Phase 7 — CI/CD

- `.github/workflows/ci.yml` (already added) runs `npm ci && npm run build` on every PR and push to `main`, catching broken builds before Render attempts (and fails) a deploy.
- Render auto-deploys on every push to the connected branch by default (`autoDeployTrigger: commit` in `render.yaml`; configurable per-service in the dashboard's **Settings**).
- Recommended: use a separate Render service (e.g. from a `staging` branch) for testing changes to the HTTP transport or OAuth flow before they hit the token/disk you actually use day-to-day — Render's Blueprint previews or a second manually-created service both work for this.

## 8. Phase 8 — Connecting Cursor (or another MCP client) to the deployed server

Once deployed, update `mcp.json` to point at the Render URL instead of a local `node` process:

```json
{
  "mcpServers": {
    "gmail-docs": {
      "url": "https://<your-service>.onrender.com/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_AUTH_TOKEN>"
      }
    }
  }
}
```

(Exact key names depend on the MCP client's support for remote/HTTP servers with custom headers — confirm against Cursor's current MCP config schema when you get to this step.)

## 9. Phase 9 — Post-deploy validation

1. ✅ `curl https://mcp-server-ziee.onrender.com/health` → `200` confirmed. Authenticated `/mcp` requests with `MCP_AUTH_TOKEN` also verified working.
2. ⬜ Complete the Phase 5 authorize flow against the current (Web application) OAuth client; confirm the token persisted by checking Render's Shell tab (`ls /data`) or simply by calling a Gmail/Docs tool without re-authorizing. **Still pending** as of the client rotation in Phase 1/5 — the client_id/secret env vars need updating on Render first.
3. From an MCP client configured per Phase 8, call `server_metrics` — confirms the transport, auth header, and tool registry all work end-to-end.
4. Call `gmail_create_draft` (safe — doesn't send) and `docs_create` to confirm the Google API calls succeed from Render's egress IPs.
5. Trigger a redeploy (e.g. push an empty commit) and re-check `/health` and `server_metrics` to confirm the disk-backed token survived the restart without needing to re-authorize.
6. If you started on the Free instance type to test cheaply, upgrade to Starter (or above) via the dashboard before relying on this in daily use — see Phase 2/6.

## 10. Rollback & ongoing operations

- Render keeps deployment history — use **Manual Deploy > Deploy a specific commit**, or the **Rollback** action on a previous successful deploy, to revert instantly if a release misbehaves.
- Because `healthCheckPath` is configured, Render won't route traffic to a new deploy until `/health` passes, avoiding downtime from a bad release — though note attaching a disk (Phase 2) means deploys are *not* zero-downtime regardless (a few seconds of unavailability during the instance swap).
- Token refresh happens automatically in `auth.ts`'s `client.on("tokens", ...)` handler and persists back to the disk — no manual re-authorization needed unless the refresh token is revoked (Google shows `REAUTH_REQUIRED` errors per `errors.ts` if so; re-run Phase 5's authorize route/flow).

## 11. Cost note

This is a single-user personal integration server with light, bursty traffic (rate-limited to `RATE_LIMIT_PER_MINUTE` per tool). On Render, that means:

- **Starter plan** (~$7/mo at time of writing — confirm current pricing at [render.com/pricing](https://render.com/pricing)) for an always-on instance that supports a disk and doesn't spin down.
- **+ $0.25/GB/month** for the 1 GB disk declared in `render.yaml` (i.e. ~$0.25/mo extra).
- No autoscaling or multi-replica setup is needed or even possible with a disk attached (the in-memory rate limiter and metrics in `rateLimiter.ts`/`metrics.ts` are also per-process, so a single instance is the right shape anyway).
- The Free instance type is fine for an initial functional smoke test (Phases 1–3, minus the disk) but isn't viable long-term per Phase 2/6.

## Summary checklist

- [x] Phase 0/1: HTTP transport + `/health` + `MCP_AUTH_TOKEN` auth middleware — already implemented, no Render-specific code changes needed
- [x] `render.yaml` added (Blueprint: web service, disk, health check, env var declarations)
- [x] `package.json` `engines.node` bounded to `>=20 <25` per Render's recommendation
- [x] Phase 3: Service deployed and live at `https://mcp-server-ziee.onrender.com`
- [x] Phase 4 (initial): Secrets filled in for the original OAuth client
- [ ] Phase 4 (rotation): OAuth client was rotated to a Web application-type client (see Phase 1 callout) — **update `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` on Render's Environment tab** to the new values (manual, not yet done)
- [ ] Phase 5: Add both redirect URIs to the new Web application OAuth client in Google Cloud Console; re-complete the one-time authorize flow against the deployed URL now that the client rotated (manual)
- [ ] Phase 6: Confirm auth token, rate limits, account allowlist, and instance type (not Free) are production-appropriate (manual)
- [ ] Phase 7: Confirm Render auto-deploy is enabled (manual; CI build check already in place)
- [ ] Phase 8: Update `mcp.json` to point at the Render URL (manual, once you have the domain)
- [x] Phase 9 (partial): `/health` and authenticated `/mcp` verified; token persistence/tool-call validation still pending re-authorization (see Phase 5 rotation note)
