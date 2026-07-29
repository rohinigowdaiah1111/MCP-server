import http from "node:http";
import { URL } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { OAuth2Client } from "google-auth-library";
import { createMcpServer } from "./mcpServer.js";
import { GmailClient } from "./gmail.js";
import { DocsClient } from "./docs.js";
import { createOAuth2Client, saveToken } from "./auth.js";
import { GOOGLE_REDIRECT_URI, MCP_AUTH_TOKEN, PORT, SCOPES } from "./config.js";
import { logger } from "./logging.js";

const MCP_PATH = "/mcp";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

function sendHtml(res: http.ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function bearerTokenFrom(req: http.IncomingMessage): string | undefined {
  const header = req.headers["authorization"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value?.startsWith("Bearer ")) return undefined;
  return value.slice("Bearer ".length);
}

/**
 * Starts the HTTP MCP transport (deployment-plan.md, Phase 1) for remote
 * hosting (e.g. Railway), instead of the stdio transport used for local
 * Cursor usage. Exposes:
 *
 *  - GET  /health          - unauthenticated, for Railway's health checks
 *  - GET  /authorize        - starts the Google consent flow (query param `?token=`)
 *  - GET  <redirect path>   - Google's OAuth callback (path taken from GOOGLE_REDIRECT_URI)
 *  - *    /mcp               - the actual MCP endpoint, bearer-token gated
 *
 * `auth` is the same OAuth2Client instance shared with `gmail`/`docs`, so
 * completing /authorize immediately makes subsequent /mcp tool calls work
 * without a restart (see auth.ts's createClientWithStoredCredentials).
 */
export function startHttpServer(auth: OAuth2Client, gmail: GmailClient, docs: DocsClient): void {
  if (!MCP_AUTH_TOKEN) {
    throw new Error(
      "MCP_AUTH_TOKEN must be set when MCP_TRANSPORT=http — it protects the /mcp endpoint and the " +
        "/authorize route once this server is reachable over the network. Generate one with e.g.\n" +
        '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"'
    );
  }

  const redirect = new URL(GOOGLE_REDIRECT_URI);

  const server = http.createServer(async (req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }

    // Unauthenticated: Railway (or any uptime monitor) health checks.
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { status: "ok", uptimeSeconds: Math.round(process.uptime()) });
      return;
    }

    // One-time (or re-auth) Google consent flow. Gated by the same shared
    // secret as /mcp, passed as a query param since this is opened directly
    // in a browser rather than called with an Authorization header.
    if (req.method === "GET" && url.pathname === "/authorize") {
      if (url.searchParams.get("token") !== MCP_AUTH_TOKEN) {
        sendHtml(res, 401, "<h1>Unauthorized</h1><p>Append <code>?token=&lt;MCP_AUTH_TOKEN&gt;</code> to this URL.</p>");
        return;
      }
      const authUrl = createOAuth2Client().generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        scope: SCOPES,
      });
      res.writeHead(302, { Location: authUrl });
      res.end();
      return;
    }

    // Google's redirect target after consent.
    if (req.method === "GET" && url.pathname === redirect.pathname) {
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        sendHtml(res, 400, `<h1>Authorization failed</h1><p>${error}</p>`);
        return;
      }
      if (!code) {
        sendHtml(res, 400, "<h1>Missing authorization code</h1>");
        return;
      }

      try {
        // `auth` (not a fresh client) so the already-registered 'tokens'
        // listener persists this exchange automatically, and gmail/docs
        // (which hold a reference to this same object) become usable
        // immediately without restarting the process.
        const { tokens } = await auth.getToken(code);
        auth.setCredentials(tokens);
        saveToken(tokens);
        logger.info("Authorized via remote /authorize flow; Google account connected.");
        sendHtml(res, 200, "<h1>Success!</h1><p>Google account connected. You can close this tab.</p>");
      } catch (err) {
        logger.error({ err }, "Remote /authorize callback failed");
        sendHtml(res, 500, "<h1>Authorization failed</h1><p>See server logs for details.</p>");
      }
      return;
    }

    // The actual MCP endpoint. Stateless: a fresh McpServer + transport per
    // request, matching the SDK's guidance for stateless/serverless HTTP
    // hosting (Protocol.connect() only supports one transport per instance).
    if (url.pathname === MCP_PATH) {
      if (bearerTokenFrom(req) !== MCP_AUTH_TOKEN) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }

      const mcpServer = createMcpServer(gmail, docs);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        transport.close().catch(() => undefined);
        mcpServer.close().catch(() => undefined);
      });

      try {
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res);
      } catch (err) {
        logger.error({ err }, "Error handling /mcp request");
        if (!res.headersSent) sendJson(res, 500, { error: "Internal server error" });
      }
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  server.listen(PORT, "0.0.0.0", () => {
    logger.info(
      { port: PORT, mcpPath: MCP_PATH },
      `Gmail/Docs MCP server listening on http://0.0.0.0:${PORT}${MCP_PATH}`
    );
  });
}
