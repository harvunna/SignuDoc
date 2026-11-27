import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { ApiKeyScope } from "./api-keys.ts";
import {
  getDb,
  queryMany,
  queryOne,
  withTransaction,
  type DbExecutor,
  type DbPool,
} from "./db/connection.ts";
import {
  accountMayUseApi,
  findOAuthClient,
  hashOAuthSecret,
  issueOAuthToken,
  looksLikeOAuthRefreshToken,
  looksLikeOAuthToken,
  resolveTokenScope,
  type OAuthClientInfo,
  type OAuthTokenSet,
} from "./oauth.ts";
import { recordSystemAuditEvent } from "./services/system-audit.ts";

// OAuth 2.0 authorization code flow (RFC 6749 4.1) with PKCE (RFC 7636),
// refresh tokens that rotate on every use, and revocation (RFC 7009). Only
// S256 is accepted, and every code needs a challenge, public client or not
// (the OAuth 2.1 profile). See db/migrations/20261126110000_*.sql.

export const AUTHORIZATION_CODE_TTL_SECONDS = 10 * 60;
export const MAX_REDIRECT_URIS = 5;

const MAX_REDIRECT_URI_LENGTH = 500;
const NEVER_A_REDIRECT_SCHEMES = new Set([
  "about:",
  "blob:",
  "data:",
  "file:",
  "ftp:",
  "javascript:",
  "vbscript:",
]);

function nowInSeconds() {
  return Math.floor(Date.now() / 1000);
}

function isLoopbackHost(hostname: string) {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  );
}

/**
 * The redirect URIs a client may register, or null if any is not allowed:
 * https, http only for the loopback of a developer's own machine, or a
 * private-use scheme for a phone or desktop app. No fragments, no
 * credentials, at most five.
 */
export function parseRedirectUris(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_REDIRECT_URIS) {
    return null;
  }

  const uris: string[] = [];

  for (const entry of value) {
    if (typeof entry !== "string") {
      return null;
    }

    const text = entry.trim();

    if (text.length === 0 || text.length > MAX_REDIRECT_URI_LENGTH) {
      return null;
    }

    let url: URL;

    try {
      url = new URL(text);
    } catch {
      return null;
    }

    if (
      url.hash !== "" ||
      text.includes("#") ||
      url.username !== "" ||
      url.password !== "" ||
      NEVER_A_REDIRECT_SCHEMES.has(url.protocol)
    ) {
      return null;
    }

    if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
      return null;
    }

    if (url.protocol === "https:" && url.hostname === "") {
      return null;
    }

    if (!uris.includes(text)) {
      uris.push(text);
    }
  }

  return uris;
}

/**
 * Whether `requested` is one of the registered URIs. Matching is exact,
 * except that a registered loopback http address matches on any port (RFC
 * 8252 7.3), since a desktop app picks its port when it starts.
 */
export function redirectUriMatches(
  registered: readonly string[],
  requested: string,
): boolean {
  if (registered.includes(requested)) {
    return true;
  }

  let wanted: URL;

  try {
    wanted = new URL(requested);
  } catch {
    return false;
  }

  if (
    wanted.protocol !== "http:" ||
    !isLoopbackHost(wanted.hostname) ||
    wanted.hash !== ""
  ) {
    return false;
  }

  return registered.some((entry) => {
    try {
      const url = new URL(entry);

      return (
        url.protocol === "http:" &&
        isLoopbackHost(url.hostname) &&
        url.hostname === wanted.hostname &&
        url.pathname === wanted.pathname &&
        url.search === wanted.search
      );
    } catch {
      return false;
    }
  });
}

export function isValidCodeChallenge(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function isValidCodeVerifier(value: string): boolean {
  return /^[A-Za-z0-9._~-]{43,128}$/.test(value);
}

/** The S256 challenge for a verifier: base64url(SHA-256(verifier)). */
export function pkceChallengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function verifyPkce(verifier: string, challenge: string): boolean {
  if (!isValidCodeVerifier(verifier) || !isValidCodeChallenge(challenge)) {
    return false;
  }

  return timingSafeEqual(
    Buffer.from(pkceChallengeFor(verifier)),
    Buffer.from(challenge),
  );
}

export type GrantErrorCode =
  "invalid_client" | "invalid_grant" | "invalid_request" | "invalid_scope";

export type GrantResult =
  | { ok: true; tokens: OAuthTokenSet }
  | { description: string; error: GrantErrorCode; ok: false };

function refuse(error: GrantErrorCode, description: string): GrantResult {
  return { description, error, ok: false };
}

export type AuthorizeRequest = {
  client: OAuthClientInfo;
  codeChallenge: string;
  redirectUri: string;
  scope: ApiKeyScope;
  state: string | null;
};

export type AuthorizeParse =
  | { ok: true; request: AuthorizeRequest }
  // Nothing can be trusted, so nobody is sent anywhere: the page explains.
  | { kind: "fatal"; message: string; ok: false }
  // The client and redirect URI are good, so the error goes back to the app.
  | {
      description: string;
      error: string;
      kind: "redirect";
      ok: false;
      redirectUri: string;
      state: string | null;
    };

/** Checks an authorization request, as RFC 6749 4.1.2.1 asks. */
export async function parseAuthorizeRequest(
  read: (name: string) => string | null | undefined,
  database: DbExecutor = getDb(),
): Promise<AuthorizeParse> {
  const clientId = read("client_id");
  const client = clientId ? await findOAuthClient(clientId, database) : null;

  if (!client) {
    return {
      kind: "fatal",
      message: "This app is not known here, or it has been turned off.",
      ok: false,
    };
  }

  if (client.redirectUris.length === 0) {
    return {
      kind: "fatal",
      message: "This app is not set up to ask people to sign in.",
      ok: false,
    };
  }

  const requestedUri = read("redirect_uri");
  const redirectUri =
    requestedUri ??
    (client.redirectUris.length === 1 ? client.redirectUris[0] : null);

  if (!redirectUri || !redirectUriMatches(client.redirectUris, redirectUri)) {
    return {
      kind: "fatal",
      message: "The address this app asked to return to is not one it set up.",
      ok: false,
    };
  }

  const state = read("state") ?? null;
  const back = (error: string, description: string): AuthorizeParse => ({
    description,
    error,
    kind: "redirect",
    ok: false,
    redirectUri,
    state,
  });

  if (read("response_type") !== "code") {
    return back(
      "unsupported_response_type",
      "Only response_type=code is supported.",
    );
  }

  const codeChallenge = read("code_challenge") ?? "";

  if (!isValidCodeChallenge(codeChallenge)) {
    return back(
      "invalid_request",
      "A PKCE code_challenge (S256, 43 characters) is required.",
    );
  }

  if (read("code_challenge_method") !== "S256") {
    return back(
      "invalid_request",
      "Only code_challenge_method=S256 is supported.",
    );
  }

  // Asked for nothing, the app gets the safer read access.
  const requestedScope = read("scope");
  const scope = requestedScope?.trim()
    ? resolveTokenScope(requestedScope, client.scope)
    : "read";

  if (!scope) {
    return back(
      "invalid_scope",
      "Scope must be read or write, and no more than the app has.",
    );
  }

  return {
    ok: true,
    request: { client, codeChallenge, redirectUri, scope, state },
  };
}

/** Where to send the person back to: the app's address plus the answer. */
export function buildRedirect(
  redirectUri: string,
  params: Record<string, string | null>,
): string {
  const url = new URL(redirectUri);

  for (const [name, value] of Object.entries(params)) {
    if (value !== null) {
      url.searchParams.set(name, value);
    }
  }

  return url.toString();
}

/**
 * Records that `userId` allowed the app, and returns the one-time code to
 * hand back to it.
 */
export async function createAuthorizationCode(
  actor: {
    email: string;
    ipAddress?: string | null;
    userAgent?: string | null;
    userId: string;
  },
  request: AuthorizeRequest,
  database: DbPool = getDb(),
): Promise<string> {
  const code = randomBytes(32).toString("base64url");
  const now = nowInSeconds();

  await withTransaction(async (tx) => {
    await tx.query(
      `DELETE FROM oauth_authorization_codes
       WHERE oauth_client_id = $1 AND expires_at <= $2`,
      [request.client.id, now],
    );
    await tx.query(
      `
        INSERT INTO oauth_authorization_codes (
          code_hash, oauth_client_id, user_id, redirect_uri, scope,
          code_challenge, created_at, expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        hashOAuthSecret(code),
        request.client.id,
        actor.userId,
        request.redirectUri,
        request.scope,
        request.codeChallenge,
        now,
        now + AUTHORIZATION_CODE_TTL_SECONDS,
      ],
    );
    await recordSystemAuditEvent(
      {
        actorEmail: actor.email,
        actorUserId: actor.userId,
        createdAt: now,
        event: "oauth_authorization_granted",
        ipAddress: actor.ipAddress ?? null,
        metadata: {
          clientId: request.client.clientId,
          name: request.client.name,
          oauthClientId: request.client.id,
          scope: request.scope,
        },
        userAgent: actor.userAgent ?? null,
      },
      tx,
    );
  }, database);

  return code;
}

/**
 * Trades a code for tokens (RFC 6749 4.1.3). The code is burned at once, so
 * it works once whatever happens next; the checks come after.
 */
export async function exchangeAuthorizationCode(
  client: { id: string; userId: string },
  input: { code: string; codeVerifier: string; redirectUri: string },
  database: DbPool = getDb(),
  now: number = nowInSeconds(),
): Promise<GrantResult> {
  return withTransaction(async (tx): Promise<GrantResult> => {
    const row = await queryOne<{
      codeChallenge: string;
      expiresAt: number;
      oauthClientId: string;
      redirectUri: string;
      scope: ApiKeyScope;
      userId: string;
    }>(
      tx,
      `
        DELETE FROM oauth_authorization_codes
        WHERE code_hash = $1
        RETURNING
          oauth_client_id AS "oauthClientId",
          user_id AS "userId",
          redirect_uri AS "redirectUri",
          scope,
          code_challenge AS "codeChallenge",
          expires_at AS "expiresAt"
      `,
      [hashOAuthSecret(input.code)],
    );

    if (
      !row ||
      row.oauthClientId !== client.id ||
      row.expiresAt <= now ||
      row.redirectUri !== input.redirectUri ||
      !verifyPkce(input.codeVerifier, row.codeChallenge) ||
      !(await accountMayUseApi(row.userId, tx))
    ) {
      return refuse(
        "invalid_grant",
        "The code is not valid, has expired or was already used.",
      );
    }

    return {
      ok: true,
      tokens: await issueOAuthToken(client, row.scope, tx, now, {
        refresh: true,
        userId: row.userId,
      }),
    };
  }, database);
}

/**
 * Trades a refresh token for new tokens (RFC 6749 6). The refresh token is
 * rotated: each works once. One that is used a second time means a copy was
 * taken, so the whole chain it belongs to is ended.
 */
export async function refreshOAuthToken(
  client: { id: string; userId: string },
  presented: string,
  requestedScope: string | null,
  database: DbPool = getDb(),
  now: number = nowInSeconds(),
): Promise<GrantResult> {
  if (!looksLikeOAuthRefreshToken(presented)) {
    return refuse("invalid_grant", "The refresh token is not valid.");
  }

  return withTransaction(async (tx): Promise<GrantResult> => {
    const row = await queryOne<{
      expiresAt: number;
      familyId: string;
      oauthClientId: string;
      scope: ApiKeyScope;
      usedAt: number | null;
      userId: string;
    }>(
      tx,
      `
        SELECT
          oauth_client_id AS "oauthClientId",
          user_id AS "userId",
          family_id AS "familyId",
          scope,
          expires_at AS "expiresAt",
          used_at AS "usedAt"
        FROM oauth_refresh_tokens
        WHERE token_hash = $1
        FOR UPDATE
      `,
      [hashOAuthSecret(presented)],
    );

    if (!row || row.oauthClientId !== client.id || row.expiresAt <= now) {
      return refuse("invalid_grant", "The refresh token is not valid.");
    }

    if (row.usedAt !== null) {
      await endFamily(tx, row.familyId);

      return refuse(
        "invalid_grant",
        "The refresh token was already used, so the sign-in it belongs to has ended. Ask the person to sign in again.",
      );
    }

    if (!(await accountMayUseApi(row.userId, tx))) {
      return refuse("invalid_grant", "The refresh token is not valid.");
    }

    const scope = requestedScope?.trim()
      ? resolveTokenScope(requestedScope, row.scope)
      : row.scope;

    if (!scope) {
      return refuse(
        "invalid_scope",
        "Scope must be read or write, and no more than was allowed.",
      );
    }

    await tx.query(
      `UPDATE oauth_refresh_tokens SET used_at = $1 WHERE token_hash = $2`,
      [now, hashOAuthSecret(presented)],
    );

    return {
      ok: true,
      tokens: await issueOAuthToken(client, scope, tx, now, {
        familyId: row.familyId,
        refresh: true,
        userId: row.userId,
      }),
    };
  }, database);
}

async function endFamily(tx: DbExecutor, familyId: string) {
  await tx.query(`DELETE FROM oauth_tokens WHERE family_id = $1`, [familyId]);
  await tx.query(`DELETE FROM oauth_refresh_tokens WHERE family_id = $1`, [
    familyId,
  ]);
}

/**
 * Revokes a token its client presents (RFC 7009). A refresh token ends its
 * whole chain; an access token ends only itself. A token that is unknown or
 * another client's is ignored, as the RFC asks, so nothing is learned.
 */
export async function revokeOAuthTokenForClient(
  client: { id: string },
  presented: string,
  database: DbPool = getDb(),
): Promise<void> {
  const hash = hashOAuthSecret(presented);

  await withTransaction(async (tx) => {
    if (looksLikeOAuthRefreshToken(presented)) {
      const row = await queryOne<{ familyId: string }>(
        tx,
        `SELECT family_id AS "familyId" FROM oauth_refresh_tokens
         WHERE token_hash = $1 AND oauth_client_id = $2`,
        [hash, client.id],
      );

      if (row) {
        await endFamily(tx, row.familyId);
      }
    } else if (looksLikeOAuthToken(presented)) {
      await tx.query(
        `DELETE FROM oauth_tokens WHERE token_hash = $1 AND oauth_client_id = $2`,
        [hash, client.id],
      );
    }
  }, database);
}

export type OAuthGrantSummary = {
  authorizedAt: number;
  clientId: string;
  isPublic: boolean;
  name: string;
  oauthClientId: string;
  ownerName: string;
  scope: ApiKeyScope;
};

/** The apps a person has allowed to act as them, with live sign-ins. */
export async function listOAuthGrantsForUser(
  userId: string,
  database: DbExecutor = getDb(),
  now: number = nowInSeconds(),
): Promise<OAuthGrantSummary[]> {
  return queryMany<OAuthGrantSummary>(
    database,
    `
      SELECT
        c.id AS "oauthClientId",
        c.client_id AS "clientId",
        c.name,
        c.is_public AS "isPublic",
        o.name AS "ownerName",
        CASE WHEN bool_or(r.scope = 'write') THEN 'write' ELSE 'read' END
          AS scope,
        min(r.created_at) AS "authorizedAt"
      FROM oauth_refresh_tokens r
      JOIN oauth_clients c ON c.id = r.oauth_client_id
      JOIN "user" o ON o.id = c.user_id
      WHERE r.user_id = $1
        AND r.used_at IS NULL
        AND r.expires_at > $2
        AND c.revoked_at IS NULL
      GROUP BY c.id, c.client_id, c.name, c.is_public, o.name
      ORDER BY min(r.created_at) DESC
    `,
    [userId, now],
  );
}

/** Takes back what a person allowed an app: every token it holds for them. */
export async function revokeOAuthGrant(
  actor: {
    email: string;
    ipAddress?: string | null;
    userAgent?: string | null;
    userId: string;
  },
  oauthClientId: string,
  database: DbPool = getDb(),
): Promise<boolean> {
  return withTransaction(async (tx) => {
    const client = await queryOne<{ clientId: string; name: string }>(
      tx,
      `SELECT client_id AS "clientId", name FROM oauth_clients WHERE id = $1`,
      [oauthClientId],
    );
    const removed = await tx.query(
      `DELETE FROM oauth_refresh_tokens
       WHERE oauth_client_id = $1 AND user_id = $2`,
      [oauthClientId, actor.userId],
    );

    await tx.query(
      `DELETE FROM oauth_tokens
       WHERE oauth_client_id = $1 AND user_id = $2 AND family_id IS NOT NULL`,
      [oauthClientId, actor.userId],
    );

    if (!client || (removed.rowCount ?? 0) === 0) {
      return false;
    }

    await recordSystemAuditEvent(
      {
        actorEmail: actor.email,
        actorUserId: actor.userId,
        event: "oauth_grant_revoked",
        ipAddress: actor.ipAddress ?? null,
        metadata: {
          clientId: client.clientId,
          name: client.name,
          oauthClientId,
        },
        userAgent: actor.userAgent ?? null,
      },
      tx,
    );

    return true;
  }, database);
}
