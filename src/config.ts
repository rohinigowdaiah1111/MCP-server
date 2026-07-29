import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Root of the project (one level up from src/dist), used to resolve
 * relative paths (e.g. token storage) that live alongside the source, not
 * inside dist/.
 */
export const PROJECT_ROOT = path.resolve(__dirname, "..");

/** OAuth client credentials from Google Cloud Console (APIs & Services > Credentials > OAuth client ID). */
export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";
export const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? "";

/**
 * Full redirect URI used both to request the auth code (generateAuthUrl) and
 * to exchange it for tokens (getToken) — must exactly match what's
 * registered on the OAuth client. `npm run authorize` parses this to know
 * which local host/port/path to listen on.
 */
export const GOOGLE_REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI ?? "http://localhost:3000/oauth2callback";

/**
 * Where the access/refresh token is persisted, encrypted at rest (see
 * tokenCrypto.ts). Relative paths resolve from the project root so the
 * location doesn't depend on the process's current working directory.
 */
export const GOOGLE_TOKEN_STORAGE_PATH = path.resolve(
  PROJECT_ROOT,
  process.env.GOOGLE_TOKEN_STORAGE_PATH ?? "./tokens.json"
);

/** Name this server identifies itself with over MCP (McpServer({ name, ... })). */
export const MCP_SERVER_NAME = process.env.MCP_SERVER_NAME ?? "google-workspace-mcp-server";

/**
 * Which MCP transport to expose (deployment-plan.md, Phase 1):
 *  - "stdio" (default): spawned as a local child process by an MCP client (e.g. Cursor's mcp.json). Unchanged behavior.
 *  - "http": binds an HTTP server on PORT with a Streamable HTTP /mcp endpoint, for remote hosting (e.g. Railway).
 * Set explicitly via env when deploying remotely — local/stdio usage is unaffected by this change.
 */
export const MCP_TRANSPORT: "stdio" | "http" = process.env.MCP_TRANSPORT === "http" ? "http" : "stdio";

/** Port the HTTP transport binds to (0.0.0.0). Railway injects PORT automatically — never hardcode it. */
export const PORT = Number(process.env.PORT ?? 8080);

/**
 * Shared secret required as `Authorization: Bearer <token>` on the HTTP /mcp
 * endpoint, and as a `?token=` query param on /authorize, once the server is
 * reachable over the network. Required (server refuses to start) when
 * MCP_TRANSPORT=http; unused in stdio mode.
 */
export const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;

/**
 * Scopes required by the tools this server exposes:
 *  - gmail.compose: create/read/update/delete drafts, and send messages/drafts.
 *  - documents: create and edit Google Docs.
 */
export const SCOPES = [
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/documents",
];

// --- Optional settings -------------------------------------------------

/**
 * Path to a service-account key file (Google's standard Application Default
 * Credentials env var name). NOT yet wired into the auth flow — this server
 * currently always authenticates as a single Google user via
 * GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET above. Reserved for a future
 * service-account / domain-wide-delegation auth mode; see the NOTE in
 * auth.ts's createOAuth2Client for where that branch would go.
 */
export const GOOGLE_APPLICATION_CREDENTIALS = process.env.GOOGLE_APPLICATION_CREDENTIALS;

/**
 * Optional allowlist of Google account emails permitted to use this server,
 * e.g. "alice@example.com,bob@example.com". NOT yet enforced — doing so
 * requires requesting the 'openid'/'userinfo.email' scopes so the
 * authenticated user's email can be checked; see the NOTE in auth.ts's
 * getAuthenticatedClient for where that check would go.
 */
export const ALLOWED_GOOGLE_ACCOUNTS = (process.env.ALLOWED_GOOGLE_ACCOUNTS ?? "")
  .split(",")
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);

/** Feature toggle: allow `isHtml: true` on gmail_create_draft/gmail_send_email. See gmail.ts. */
export const ENABLE_HTML_EMAIL = (process.env.ENABLE_HTML_EMAIL ?? "true") !== "false";

/** Feature toggle: whether the docs_append_text tool is registered at all. See index.ts. */
export const ENABLE_DOCS_APPEND = (process.env.ENABLE_DOCS_APPEND ?? "true") !== "false";

// --- Additional hardening (kept from the previous env var set; see chat) ---

/** Max attempts for conflict-retry (e.g. concurrent Google Docs edits). */
export const MAX_CONFLICT_RETRIES = Number(process.env.MAX_CONFLICT_RETRIES ?? 3);

/** Max attachment size (bytes) accepted by gmail tools, before base64 overhead. */
export const MAX_ATTACHMENT_BYTES = Number(
  process.env.MAX_ATTACHMENT_BYTES ?? 20 * 1024 * 1024 // 20 MB, Gmail's own limit
);
