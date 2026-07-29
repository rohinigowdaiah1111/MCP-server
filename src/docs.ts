import { google, docs_v1 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { AppError, mapGoogleApiError } from "./errors.js";
import { MAX_CONFLICT_RETRIES } from "./config.js";
import { isAuthenticated } from "./auth.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class DocsClient {
  private docs: docs_v1.Docs;
  private auth: OAuth2Client;

  constructor(auth: OAuth2Client) {
    this.auth = auth;
    this.docs = google.docs({ version: "v1", auth });
  }

  /**
   * Guards against calls made before the HTTP transport's /authorize flow
   * has completed (deployment-plan.md, Phase 5). In stdio mode this is
   * always true by the time a DocsClient exists — see auth.ts.
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

  async createDocument(title: string, initialContent?: string): Promise<{ documentId: string; url: string }> {
    this.ensureAuthenticated();
    try {
      const res = await this.docs.documents.create({ requestBody: { title } });
      const documentId = res.data.documentId ?? "";

      if (initialContent) {
        await this.appendText(documentId, initialContent);
      }

      return { documentId, url: `https://docs.google.com/document/d/${documentId}/edit` };
    } catch (error) {
      throw mapGoogleApiError(error, "docs_create");
    }
  }

  /**
   * Appends text to the end of an existing document.
   *
   * Concurrency safety (implementationplan.md, Section 5.2): reads the
   * document's current revision, then writes with
   * `writeControl.requiredRevisionId` so the API itself rejects the write if
   * someone else changed the doc in between. On a resulting 409 conflict, we
   * re-fetch the latest revision/end-index and retry with exponential
   * backoff, up to MAX_CONFLICT_RETRIES attempts.
   */
  async appendText(documentId: string, text: string): Promise<{ url: string }> {
    this.ensureAuthenticated();
    let lastError: unknown;

    for (let attempt = 0; attempt <= MAX_CONFLICT_RETRIES; attempt++) {
      try {
        const doc = await this.docs.documents.get({ documentId });
        const content = doc.data.body?.content ?? [];
        const lastElement = content[content.length - 1];
        // endIndex points one past the final newline; inserting there appends
        // after existing content. Body always has at least a trailing
        // newline, so index 1 is the fallback for a brand-new/empty document.
        const endIndex = lastElement?.endIndex ?? 1;
        const insertIndex = Math.max(endIndex - 1, 1);
        const requiredRevisionId = doc.data.revisionId ?? undefined;

        await this.docs.documents.batchUpdate({
          documentId,
          requestBody: {
            writeControl: requiredRevisionId ? { requiredRevisionId } : undefined,
            requests: [{ insertText: { location: { index: insertIndex }, text } }],
          },
        });

        return { url: `https://docs.google.com/document/d/${documentId}/edit` };
      } catch (error) {
        lastError = error;
        const mapped = mapGoogleApiError(error, "docs_append_text");
        if (mapped.code !== "CONFLICT" || attempt === MAX_CONFLICT_RETRIES) {
          throw mapped;
        }
        // Exponential backoff before re-fetching the latest revision and retrying.
        await sleep(2 ** attempt * 150);
      }
    }

    // Unreachable, but keeps TypeScript happy about a definite return/throw.
    throw mapGoogleApiError(lastError, "docs_append_text");
  }
}
