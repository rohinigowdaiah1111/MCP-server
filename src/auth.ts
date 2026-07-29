import fs from "node:fs";
import { OAuth2Client, type Credentials } from "google-auth-library";
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI, GOOGLE_TOKEN_STORAGE_PATH } from "./config.js";
import { decryptJson, encryptJson, isEncryptedFormat } from "./tokenCrypto.js";
import { AppError } from "./errors.js";
import { logger } from "./logging.js";

/**
 * Builds an OAuth2Client from GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET (Google
 * Cloud Console > APIs & Services > Credentials > OAuth client ID). Does not
 * attach any tokens yet.
 */
export function createOAuth2Client(): OAuth2Client {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    throw new Error(
      "Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.\n" +
        "Create an OAuth client in Google Cloud Console (APIs & Services > Credentials > " +
        "OAuth client ID) and set both values — plus a matching GOOGLE_REDIRECT_URI — in your .env file."
    );
  }

  // NOTE: GOOGLE_APPLICATION_CREDENTIALS (a service-account key file path) is
  // read into config but not used here — this server always authenticates as
  // a single Google user via the client credentials above. If service-account
  // (domain-wide delegation) auth is added later, branch here: when
  // GOOGLE_APPLICATION_CREDENTIALS is set, build the client via
  // `new google.auth.GoogleAuth({ keyFile: GOOGLE_APPLICATION_CREDENTIALS, scopes: SCOPES })`
  // instead of the per-user OAuth2Client below.

  return new OAuth2Client({
    clientId: GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
    redirectUri: GOOGLE_REDIRECT_URI,
  });
}

/** Persists tokens encrypted at rest (AES-256-GCM); see tokenCrypto.ts. */
export function saveToken(tokens: Credentials): void {
  fs.writeFileSync(GOOGLE_TOKEN_STORAGE_PATH, encryptJson(tokens), "utf-8");
}

export function loadToken(): Credentials | null {
  if (!fs.existsSync(GOOGLE_TOKEN_STORAGE_PATH)) return null;
  const raw = fs.readFileSync(GOOGLE_TOKEN_STORAGE_PATH, "utf-8");
  const token = decryptJson<Credentials>(raw);

  // Transparently migrate legacy plaintext token files to the
  // encrypted-at-rest format the first time they're loaded.
  if (!isEncryptedFormat(raw)) {
    try {
      saveToken(token);
      logger.info("Migrated token storage file to encrypted-at-rest format.");
    } catch (err) {
      logger.warn({ err }, "Could not migrate token storage file to encrypted format; will retry next run.");
    }
  }

  return token;
}

/**
 * Wires up automatic token persistence: whenever `client` obtains new tokens
 * (initial exchange, or a background refresh), the merged credentials are
 * saved back to the token storage file. Shared by both `getAuthenticatedClient`
 * (stdio) and `createClientWithStoredCredentials` (HTTP) below.
 */
function attachTokenPersistence(client: OAuth2Client, initialToken: Credentials | null): void {
  let latestToken = initialToken;
  client.on("tokens", (newTokens) => {
    latestToken = { ...latestToken, ...newTokens };
    saveToken(latestToken);
    logger.debug("Refreshed and persisted Google OAuth tokens.");
  });

  // NOTE: ALLOWED_GOOGLE_ACCOUNTS is read into config but not enforced here.
  // To wire it up: request the 'openid' and 'https://www.googleapis.com/auth/userinfo.email'
  // scopes in config.ts's SCOPES, decode the resulting `token.id_token` (JWT) or call
  // `google.oauth2('v2').userinfo.get({ auth: client })` to get the signed-in email, then
  // throw an AppError("REAUTH_REQUIRED", ...) here if it's not in ALLOWED_GOOGLE_ACCOUNTS.
}

/**
 * Returns a ready-to-use, authenticated OAuth2Client for API calls. Requires
 * that `npm run authorize` has already been run once to produce the token
 * storage file. Refreshed tokens are persisted back to disk automatically.
 *
 * Used by the stdio transport, where failing fast with a clear message if
 * unauthenticated is the right UX (there's no way to complete a remote
 * /authorize flow from a locally-spawned stdio process).
 */
export function getAuthenticatedClient(): OAuth2Client {
  const client = createOAuth2Client();
  let token: Credentials | null;
  try {
    token = loadToken();
  } catch (err) {
    throw new AppError(
      "REAUTH_REQUIRED",
      `Stored Google credentials at ${GOOGLE_TOKEN_STORAGE_PATH} could not be read or decrypted. ` +
        "Run `npm run authorize` again to re-authenticate.",
      { cause: err }
    );
  }

  if (!token) {
    throw new AppError(
      "REAUTH_REQUIRED",
      `No stored Google credentials found at ${GOOGLE_TOKEN_STORAGE_PATH}. ` +
        "Run `npm run authorize` once to sign in and grant access, then restart the MCP server."
    );
  }

  client.setCredentials(token);
  attachTokenPersistence(client, token);
  return client;
}

/**
 * Returns an OAuth2Client that attaches stored credentials if a token file
 * already exists, but — unlike `getAuthenticatedClient` — does NOT throw if
 * one doesn't exist yet (deployment-plan.md, Phase 5). Used by the HTTP
 * transport so the server (and its /authorize + /oauth2callback routes) can
 * start up even before the very first authorization has happened.
 *
 * Tool calls made before authorization completes fail with a clean
 * REAUTH_REQUIRED AppError (see `isAuthenticated` below and its use in
 * gmail.ts/docs.ts) instead of a confusing raw google-auth-library error.
 */
export function createClientWithStoredCredentials(): OAuth2Client {
  const client = createOAuth2Client();
  let token: Credentials | null = null;
  try {
    token = loadToken();
  } catch (err) {
    logger.warn({ err }, "Could not read/decrypt stored token; starting unauthenticated (visit /authorize).");
  }

  if (token) {
    client.setCredentials(token);
  }
  attachTokenPersistence(client, token);
  return client;
}

/** True once `client` has credentials usable for API calls (set initially, or via the /oauth2callback flow). */
export function isAuthenticated(client: OAuth2Client): boolean {
  return Boolean(client.credentials?.access_token || client.credentials?.refresh_token);
}
