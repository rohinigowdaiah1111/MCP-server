import "dotenv/config";
import http from "node:http";
import { URL } from "node:url";
import open from "open";
import { createOAuth2Client, saveToken } from "./auth.js";
import { GOOGLE_REDIRECT_URI, GOOGLE_TOKEN_STORAGE_PATH, SCOPES } from "./config.js";

/**
 * One-time interactive setup: opens a browser for the user to grant consent,
 * then exchanges the returned code for tokens and saves them to the
 * configured token storage file. Run with: `npm run authorize`
 */
async function main(): Promise<void> {
  const client = createOAuth2Client();

  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });

  // Listen on whatever host/port/path GOOGLE_REDIRECT_URI specifies, so the
  // local callback server always matches the URI actually sent to Google.
  const redirect = new URL(GOOGLE_REDIRECT_URI);
  const port = Number(redirect.port) || (redirect.protocol === "https:" ? 443 : 80);

  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (!req.url) return;
      const url = new URL(req.url, `${redirect.protocol}//${redirect.host}`);
      if (url.pathname !== redirect.pathname) {
        res.writeHead(404);
        res.end();
        return;
      }

      const authCode = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`<h1>Authorization failed</h1><p>${error}</p>`);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (authCode) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<h1>Success!</h1><p>You can close this tab and return to the terminal.</p>"
        );
        server.close();
        resolve(authCode);
      }
    });

    server.listen(port, () => {
      console.log("Opening browser for Google sign-in...");
      console.log(`If it doesn't open automatically, visit:\n${authUrl}\n`);
      open(authUrl).catch(() => {
        /* ignore; user can open the URL manually */
      });
    });

    server.on("error", reject);
  });

  const { tokens } = await client.getToken(code);
  saveToken(tokens);

  console.log(`\nAuthorization complete. Tokens saved to ${GOOGLE_TOKEN_STORAGE_PATH}`);
  console.log("You can now start the MCP server with `npm start`.");
}

main().catch((err) => {
  console.error("Authorization failed:", err);
  process.exit(1);
});
