import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { AppError, mapGoogleApiError } from "./errors.js";
import { ENABLE_HTML_EMAIL, MAX_ATTACHMENT_BYTES } from "./config.js";
import { isAuthenticated } from "./auth.js";

export interface EmailAttachment {
  filename: string;
  /** Base64-encoded file content (not base64url; standard base64 with padding is fine). */
  contentBase64: string;
  mimeType: string;
}

export interface EmailInput {
  to: string[];
  subject: string;
  body: string;
  cc?: string[];
  bcc?: string[];
  isHtml?: boolean;
  attachments?: EmailAttachment[];
}

function encodeBase64Url(input: Buffer | string): string {
  const buffer = typeof input === "string" ? Buffer.from(input, "utf-8") : input;
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function validateEmailInput(email: EmailInput): void {
  if (email.isHtml && !ENABLE_HTML_EMAIL) {
    throw new AppError(
      "INVALID_INPUT",
      "HTML email is disabled on this server (ENABLE_HTML_EMAIL=false). Send plain text instead."
    );
  }

  for (const attachment of email.attachments ?? []) {
    if (!attachment.filename || !attachment.contentBase64 || !attachment.mimeType) {
      throw new AppError(
        "INVALID_INPUT",
        "Each attachment requires filename, contentBase64, and mimeType."
      );
    }
    // Rough size check on the base64 payload (actual bytes are ~3/4 of this).
    const approxBytes = (attachment.contentBase64.length * 3) / 4;
    if (approxBytes > MAX_ATTACHMENT_BYTES) {
      throw new AppError(
        "INVALID_INPUT",
        `Attachment "${attachment.filename}" exceeds the ${Math.round(
          MAX_ATTACHMENT_BYTES / (1024 * 1024)
        )}MB limit.`
      );
    }
  }
}

/**
 * Builds an RFC 2822 message and returns it base64url-encoded, as required by
 * the Gmail API. Produces a simple single-part message when there are no
 * attachments, or a multipart/mixed MIME message when there are.
 */
function buildRawMessage(email: EmailInput): string {
  const headerLines = [
    `To: ${email.to.join(", ")}`,
    email.cc?.length ? `Cc: ${email.cc.join(", ")}` : null,
    email.bcc?.length ? `Bcc: ${email.bcc.join(", ")}` : null,
    `Subject: ${email.subject}`,
    "MIME-Version: 1.0",
  ].filter((line): line is string => line !== null);

  const attachments = email.attachments ?? [];
  if (attachments.length === 0) {
    const body = [
      ...headerLines,
      `Content-Type: ${email.isHtml ? "text/html" : "text/plain"}; charset="UTF-8"`,
      "",
      email.body,
    ].join("\r\n");
    return encodeBase64Url(body);
  }

  const boundary = `----mcp-boundary-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const parts: string[] = [
    `--${boundary}`,
    `Content-Type: ${email.isHtml ? "text/html" : "text/plain"}; charset="UTF-8"`,
    "",
    email.body,
    "",
  ];

  for (const attachment of attachments) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${attachment.mimeType}; name="${attachment.filename}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${attachment.filename}"`,
      "",
      attachment.contentBase64.replace(/(.{76})/g, "$1\r\n"),
      ""
    );
  }
  parts.push(`--${boundary}--`);

  const message = [
    ...headerLines,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    ...parts,
  ].join("\r\n");

  return encodeBase64Url(message);
}

export class GmailClient {
  private gmail;
  private auth: OAuth2Client;

  constructor(auth: OAuth2Client) {
    this.auth = auth;
    this.gmail = google.gmail({ version: "v1", auth });
  }

  /**
   * Guards against calls made before the HTTP transport's /authorize flow
   * has completed (deployment-plan.md, Phase 5). In stdio mode this is
   * always true by the time a GmailClient exists — see auth.ts.
   */
  private ensureAuthenticated(): void {
    if (!isAuthenticated(this.auth)) {
      throw new AppError(
        "REAUTH_REQUIRED",
        "This server hasn't been authorized with a Google account yet. " +
          "Visit /authorize (with your MCP_AUTH_TOKEN) to connect one, then retry."
      );
    }
  }

  async createDraft(email: EmailInput): Promise<{ draftId: string; messageId: string | null | undefined }> {
    this.ensureAuthenticated();
    validateEmailInput(email);
    try {
      const raw = buildRawMessage(email);
      const res = await this.gmail.users.drafts.create({
        userId: "me",
        requestBody: { message: { raw } },
      });
      return { draftId: res.data.id ?? "", messageId: res.data.message?.id };
    } catch (error) {
      throw mapGoogleApiError(error, "gmail_create_draft");
    }
  }

  async sendEmail(email: EmailInput): Promise<{ messageId: string | null | undefined }> {
    this.ensureAuthenticated();
    validateEmailInput(email);
    try {
      const raw = buildRawMessage(email);
      const res = await this.gmail.users.messages.send({ userId: "me", requestBody: { raw } });
      return { messageId: res.data.id };
    } catch (error) {
      throw mapGoogleApiError(error, "gmail_send_email");
    }
  }

  async sendDraft(draftId: string): Promise<{ messageId: string | null | undefined }> {
    this.ensureAuthenticated();
    try {
      const res = await this.gmail.users.drafts.send({ userId: "me", requestBody: { id: draftId } });
      return { messageId: res.data.id };
    } catch (error) {
      throw mapGoogleApiError(error, "gmail_send_draft");
    }
  }

  async listDrafts(maxResults = 10): Promise<Array<{ id: string; snippet?: string | null }>> {
    this.ensureAuthenticated();
    try {
      const res = await this.gmail.users.drafts.list({ userId: "me", maxResults });
      return (res.data.drafts ?? []).map((d) => ({ id: d.id ?? "", snippet: d.message?.snippet }));
    } catch (error) {
      throw mapGoogleApiError(error, "gmail_list_drafts");
    }
  }
}
