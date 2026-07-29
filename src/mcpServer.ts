import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GmailClient } from "./gmail.js";
import { DocsClient } from "./docs.js";
import { AppError } from "./errors.js";
import { createRequestLogger } from "./logging.js";
import { enforceRateLimit } from "./rateLimiter.js";
import { recordCall, snapshot } from "./metrics.js";
import { ENABLE_DOCS_APPEND, MCP_SERVER_NAME } from "./config.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(error: unknown, requestId: string): ToolResult {
  const appError =
    error instanceof AppError
      ? error
      : new AppError("INTERNAL_ERROR", error instanceof Error ? error.message : String(error));
  const suffix = appError.retryable ? " (safe to retry)" : "";
  return {
    content: [
      {
        type: "text",
        text: `Error [${appError.code}]${suffix}: ${appError.message}\n(requestId: ${requestId})`,
      },
    ],
    isError: true,
  };
}

/**
 * Recursively reduces a value to a log-safe shape: strings become their
 * `length`, arrays become their `count`, and nested objects are summarized
 * field-by-field. This guarantees request bodies, document text, attachment
 * bytes, and other free-form content never reach the logs (implementation
 * plan Section 7 — "no PII logged"), without needing a bespoke summarizer
 * per tool.
 */
function summarizeForLog(value: unknown): unknown {
  if (typeof value === "string") return { length: value.length };
  if (Array.isArray(value)) return { count: value.length };
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, summarizeForLog(v)]));
  }
  return value;
}

/**
 * Cross-cutting middleware applied to every tool call (implementationplan.md,
 * Section 7 & 9 — Phase 5 hardening): per-tool rate limiting, a correlation
 * ID for tracing, request/latency logging, and metrics recording, wrapping
 * the tool's own business logic and normalizing whatever it throws into a
 * structured `AppError` response.
 */
function withMiddleware<TArgs>(toolName: string, handler: (args: TArgs) => Promise<ToolResult>) {
  return async (args: TArgs): Promise<ToolResult> => {
    const { requestId, log } = createRequestLogger(toolName);
    const startedAt = Date.now();
    try {
      enforceRateLimit(toolName);
      log.info({ input: summarizeForLog(args) }, "tool call started");
      const result = await handler(args);
      const latencyMs = Date.now() - startedAt;
      recordCall(toolName, latencyMs);
      log.info({ latencyMs }, "tool call succeeded");
      return result;
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const appError =
        error instanceof AppError
          ? error
          : new AppError("INTERNAL_ERROR", error instanceof Error ? error.message : String(error), {
              cause: error,
            });
      recordCall(toolName, latencyMs, appError.code);
      log.error({ latencyMs, code: appError.code, message: appError.message }, "tool call failed");
      return errorResult(appError, requestId);
    }
  };
}

/**
 * Builds a fresh McpServer with all tools registered against the given
 * (shared) Gmail/Docs clients.
 *
 * Deliberately a factory rather than a singleton: the MCP SDK's `Protocol.connect()`
 * only allows one transport per server instance ("Already connected to a
 * transport..."). The stdio transport connects a single instance for the
 * life of the process; the stateless HTTP transport (see httpServer.ts)
 * calls this once per incoming request instead, per the SDK's documented
 * pattern for stateless/serverless hosting.
 */
export function createMcpServer(gmail: GmailClient, docs: DocsClient): McpServer {
  const server = new McpServer({
    name: MCP_SERVER_NAME,
    version: "1.0.0",
  });

  const emailShape = {
    to: z.array(z.string().email()).min(1).describe("Recipient email addresses"),
    subject: z.string().min(1).describe("Email subject line"),
    body: z.string().describe("Email body content"),
    cc: z.array(z.string().email()).optional().describe("CC recipient email addresses"),
    bcc: z.array(z.string().email()).optional().describe("BCC recipient email addresses"),
    isHtml: z.boolean().optional().describe("Whether the body is HTML (default: plain text)"),
    attachments: z
      .array(
        z.object({
          filename: z.string().min(1).describe("File name, e.g. report.pdf"),
          contentBase64: z.string().min(1).describe("Base64-encoded file contents"),
          mimeType: z.string().min(1).describe("MIME type, e.g. application/pdf"),
        })
      )
      .max(10)
      .optional()
      .describe("Optional file attachments (max 10, 20MB each)"),
  };

  server.registerTool(
    "gmail_create_draft",
    {
      title: "Create Gmail Draft",
      description:
        "Creates a draft email in the user's Gmail account. The draft is saved but NOT sent.",
      inputSchema: emailShape,
    },
    withMiddleware("gmail_create_draft", async (args) => {
      const result = await gmail.createDraft(args);
      return textResult(`Draft created successfully. Draft ID: ${result.draftId}`);
    })
  );

  server.registerTool(
    "gmail_send_email",
    {
      title: "Send Gmail Email",
      description:
        "Immediately sends an email from the user's Gmail account. Use gmail_create_draft first " +
        "if you want a human to review before sending.",
      inputSchema: emailShape,
    },
    withMiddleware("gmail_send_email", async (args) => {
      const result = await gmail.sendEmail(args);
      return textResult(`Email sent successfully. Message ID: ${result.messageId}`);
    })
  );

  server.registerTool(
    "gmail_send_draft",
    {
      title: "Send Existing Gmail Draft",
      description: "Sends a previously created draft, identified by its draft ID.",
      inputSchema: {
        draftId: z.string().min(1).describe("The ID of the draft to send"),
      },
    },
    withMiddleware("gmail_send_draft", async ({ draftId }) => {
      const result = await gmail.sendDraft(draftId);
      return textResult(`Draft sent successfully. Message ID: ${result.messageId}`);
    })
  );

  server.registerTool(
    "gmail_list_drafts",
    {
      title: "List Gmail Drafts",
      description: "Lists existing draft emails in the user's Gmail account.",
      inputSchema: {
        maxResults: z.number().int().min(1).max(50).optional().describe("Max drafts to return (default 10)"),
      },
    },
    withMiddleware("gmail_list_drafts", async ({ maxResults }) => {
      const drafts = await gmail.listDrafts(maxResults);
      if (drafts.length === 0) return textResult("No drafts found.");
      const lines = drafts.map((d) => `- ${d.id}: ${d.snippet ?? "(no preview)"}`);
      return textResult(lines.join("\n"));
    })
  );

  server.registerTool(
    "docs_create",
    {
      title: "Create Google Doc",
      description: "Creates a new Google Doc with the given title, optionally with initial text content.",
      inputSchema: {
        title: z.string().min(1).describe("Title of the new document"),
        content: z.string().optional().describe("Initial text content to write into the document"),
      },
    },
    withMiddleware("docs_create", async ({ title, content }) => {
      const result = await docs.createDocument(title, content);
      return textResult(`Document created. ID: ${result.documentId}\nURL: ${result.url}`);
    })
  );

  // Feature toggle: ENABLE_DOCS_APPEND=false omits this tool from the
  // registry entirely, rather than registering it and rejecting calls.
  if (ENABLE_DOCS_APPEND) {
    server.registerTool(
      "docs_append_text",
      {
        title: "Append Text to Google Doc",
        description:
          "Appends text content to the end of an existing Google Doc, identified by its document ID. " +
          "Safely retries on concurrent-edit conflicts.",
        inputSchema: {
          documentId: z
            .string()
            .min(1)
            .describe("The Google Doc ID (from its URL: docs.google.com/document/d/<ID>/edit)"),
          text: z.string().min(1).describe("Text to append to the end of the document"),
        },
      },
      withMiddleware("docs_append_text", async ({ documentId, text }) => {
        const result = await docs.appendText(documentId, text);
        return textResult(`Text appended successfully.\nURL: ${result.url}`);
      })
    );
  }

  server.registerTool(
    "server_metrics",
    {
      title: "MCP Server Metrics",
      description:
        "Returns in-process observability metrics for this MCP server: per-tool call counts, " +
        "error rates, and average latency, plus process uptime.",
      inputSchema: {},
    },
    withMiddleware("server_metrics", async () => textResult(JSON.stringify(snapshot(), null, 2)))
  );

  return server;
}
