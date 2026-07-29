import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClientWithStoredCredentials, getAuthenticatedClient } from "./auth.js";
import { GmailClient } from "./gmail.js";
import { DocsClient } from "./docs.js";
import { createMcpServer } from "./mcpServer.js";
import { startHttpServer } from "./httpServer.js";
import { logger } from "./logging.js";
import { MCP_TRANSPORT } from "./config.js";

async function main(): Promise<void> {
  if (MCP_TRANSPORT === "http") {
    // Lazy/non-throwing: the server (and its /authorize + /oauth2callback
    // routes) must be able to start even before the first authorization has
    // happened — see deployment-plan.md, Phase 5, and auth.ts.
    const auth = createClientWithStoredCredentials();
    const gmail = new GmailClient(auth);
    const docs = new DocsClient(auth);
    startHttpServer(auth, gmail, docs);
    return;
  }

  // stdio (default, local/Cursor usage): fail fast with a clear message if
  // `npm run authorize` hasn't been run yet, since there's no remote
  // /authorize flow available to a locally-spawned child process.
  const auth = getAuthenticatedClient();
  const gmail = new GmailClient(auth);
  const docs = new DocsClient(auth);
  const server = createMcpServer(gmail, docs);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("Gmail/Docs MCP server running on stdio.");
}

main().catch((error) => {
  logger.fatal({ err: error }, "Fatal error starting MCP server");
  process.exit(1);
});
