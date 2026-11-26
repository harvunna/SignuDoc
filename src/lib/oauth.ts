import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import type { ApiKeyPrincipal, ApiKeyScope } from "./api-keys.ts";
import {
  getDb,
  queryMany,
  queryOne,
  withTransaction,
  type DbExecutor,
  type DbPool,
} from "./db/connection.ts";
import { recordSystemAuditEvent } from "./services/system-audit.ts";

// OAuth 2.0 (RFC 6749) for the public API: the client credentials grant, for
// servers that call the API as an account. A client is registered in Settings
// and its secret is shown once. It trades id and secret at /api/oauth/token
// for an access token that lasts an hour, and sends that as a Bearer token.
// Only hashes of secrets and tokens are stored. See
// db/migrations/20261126100000_oauth_clients.sql.

export const OAUTH_CLIENT_ID_PREFIX = "gcmc_";
export const OAUTH_CLIENT_SECRET_PREFIX = "gcms_";
export const OAUTH_TOKEN_PREFIX = "sdo_";
export const OAUTH_TOKEN_TTL_SECONDS = 60 * 60;
export const MAX_OAUTH_CLIENTS_PER_USER = 10;

const LAST_USED_WRITE_INTERVAL_SECONDS = 60;

export class OAuthClientError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "OAuthClientError";
    this.statusCode = statusCode;
  }
}

export type OAuthClientSummary = {
  clientId: string;
  createdAt: number;
  id: string;
  lastUsedAt: number | null;
  name: string;
  ownerClosing: boolean;
  ownerEmail: string;
  ownerName: string;
  revokedAt: number | null;
  scope: ApiKeyScope;
  userId: string;
};

type Actor = {
  email: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  userId: string;
};

const SUMMARY_COLUMNS = `
  c.id,
  c.user_id AS "userId",
  c.name,
  c.client_id AS "clientId",
  c.scope,
  c.created_at AS "createdAt",
  c.last_used_at AS "lastUsedAt",
  c.revoked_at AS "revokedAt",
  u.email AS "ownerEmail",
  u.name AS "ownerName",
  EXISTS (
    SELECT 1 FROM account_closure_requests a WHERE a.user_id = c.user_id
  ) AS "ownerClosing"
`;

function nowInSeconds() {
  return Math.floor(Date.now() / 1000);
}

export function hashOAuthSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function generateOAuthClientId(): string {
  return `${OAUTH_CLIENT_ID_PREFIX}${randomBytes(16).toString("base64url")}`;
}

export function generateOAuthClientSecret(): string {
  return `${OAUTH_CLIENT_SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function generateOAuthToken(): string {
  return `${OAUTH_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function looksLikeOAuthToken(value: string): boolean {
  return /^sdo_[A-Za-z0-9_-]{43}$/.test(value);
}

/**
 * The scope a token request asks for. `requested` is the space-separated
 * `scope` parameter (RFC 6749 3.3). Absent, it is the client's own scope.
 * "write" includes "read". Null means a scope the API does not know or
 * more than the client may have.
 */
export function resolveTokenScope(
  requested: string | null | undefined,
  clientScope: ApiKeyScope,
): ApiKeyScope | null {
  const words = (requested ?? "").split(/[ ]+/).filter(Boolean);

  if (words.length === 0) {
    return clientScope;
  }

  if (!words.every((word) => word === "read" || word === "write")) {
    return null;
  }

  const wanted: ApiKeyScope = words.includes("write") ? "write" : "read";

  return wanted === "write" && clientScope === "read" ? null : wanted;
}

export function parseOAuthClientName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const name = value.trim().replace(/\s+/g, " ");

  return name.length >= 1 && name.length <= 80 ? name : null;
}

async function getClientSummary(
  id: string,
  database: DbExecutor,
): Promise<OAuthClientSummary | null> {
  return queryOne<OAuthClientSummary>(
    database,
    `
      SELECT ${SUMMARY_COLUMNS}
      FROM oauth_clients c
      JOIN "user" u ON u.id = c.user_id
      WHERE c.id = $1
    `,
    [id],
  );
}

/** Registers a client for `actor`. The secret is returned once, never stored. */
export async function createOAuthClient(
  actor: Actor,
  input: { name: string; scope: ApiKeyScope },
  database: DbPool = getDb(),
): Promise<{ clientSecret: string; summary: OAuthClientSummary }> {
  const clientId = generateOAuthClientId();
  const clientSecret = generateOAuthClientSecret();
  const createdAt = nowInSeconds();
  const id = randomUUID();

  const summary = await withTransaction(async (tx) => {
    // Held while counting, so two requests at once cannot both slip under
    // the limit.
    const owner = await queryOne<{ id: string }>(
      tx,
      `SELECT id FROM "user" WHERE id = $1 FOR UPDATE`,
      [actor.userId],
    );

    if (!owner) {
      throw new OAuthClientError("That account no longer exists.", 404);
    }

    const active = await queryOne<{ count: number }>(
      tx,
      `
        SELECT count(*)::int AS count
        FROM oauth_clients
        WHERE user_id = $1 AND revoked_at IS NULL
      `,
      [actor.userId],
    );

    if ((active?.count ?? 0) >= MAX_OAUTH_CLIENTS_PER_USER) {
      throw new OAuthClientError(
        `You can have up to ${String(MAX_OAUTH_CLIENTS_PER_USER)} OAuth clients. Revoke one you no longer use first.`,
        409,
      );
    }

    await tx.query(
      `
        INSERT INTO oauth_clients (
          id, user_id, name, client_id, secret_hash, scope, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        id,
        actor.userId,
        input.name,
        clientId,
        hashOAuthSecret(clientSecret),
        input.scope,
        createdAt,
      ],
    );
    await recordSystemAuditEvent(
      {
        actorEmail: actor.email,
        actorUserId: actor.userId,
        createdAt,
        event: "oauth_client_created",
        ipAddress: actor.ipAddress ?? null,
        metadata: {
          clientId,
          name: input.name,
          oauthClientId: id,
          scope: input.scope,
        },
        userAgent: actor.userAgent ?? null,
      },
      tx,
    );

    const created = await getClientSummary(id, tx);

    if (!created) {
      throw new Error("A client that was just created could not be read back.");
    }

    return created;
  }, database);

  return { clientSecret, summary };
}

export const LISTED_REVOKED_OAUTH_CLIENTS = 50;

/** One account's clients: live ones newest first, then recently revoked. */
export async function listOAuthClientsForUser(
  userId: string,
  database: DbExecutor = getDb(),
): Promise<OAuthClientSummary[]> {
  return queryMany<OAuthClientSummary>(
    database,
    `
      WITH listed AS (
        SELECT id, 0 AS list_group, created_at AS sorted_by
        FROM oauth_clients
        WHERE user_id = $1 AND revoked_at IS NULL
        UNION ALL
        (
          SELECT id, 1 AS list_group, revoked_at AS sorted_by
          FROM oauth_clients
          WHERE user_id = $1 AND revoked_at IS NOT NULL
          ORDER BY revoked_at DESC, id
          LIMIT $2
        )
      )
      SELECT ${SUMMARY_COLUMNS}
      FROM listed l
      JOIN oauth_clients c ON c.id = l.id
      JOIN "user" u ON u.id = c.user_id
      ORDER BY l.list_group, l.sorted_by DESC, c.id
    `,
    [userId, LISTED_REVOKED_OAUTH_CLIENTS],
  );
}

/**
 * Revokes a client and every token it was given. Only the owner (or an
 * administrator) may; anyone else sees it as not found. Twice is fine.
 */
export async function revokeOAuthClient(
  actor: Actor,
  oauthClientId: string,
  database: DbPool = getDb(),
): Promise<OAuthClientSummary> {
  const revokedAt = nowInSeconds();

  await withTransaction(async (tx) => {
    const owner = await queryOne<{ role: string }>(
      tx,
      `SELECT role FROM "user" WHERE id = $1 FOR UPDATE`,
      [actor.userId],
    );
    const client = await queryOne<{
      clientId: string;
      name: string;
      revokedAt: number | null;
      userId: string;
    }>(
      tx,
      `
        SELECT client_id AS "clientId", name, user_id AS "userId",
               revoked_at AS "revokedAt"
        FROM oauth_clients
        WHERE id = $1
        FOR UPDATE
      `,
      [oauthClientId],
    );

    if (
      !owner ||
      !client ||
      (owner.role !== "admin" && client.userId !== actor.userId)
    ) {
      throw new OAuthClientError("That client no longer exists.", 404);
    }

    if (client.revokedAt !== null) {
      return;
    }

    await tx.query(`UPDATE oauth_clients SET revoked_at = $1 WHERE id = $2`, [
      revokedAt,
      oauthClientId,
    ]);
    await tx.query(`DELETE FROM oauth_tokens WHERE oauth_client_id = $1`, [
      oauthClientId,
    ]);
    await recordSystemAuditEvent(
      {
        actorEmail: actor.email,
        actorUserId: actor.userId,
        createdAt: revokedAt,
        event: "oauth_client_revoked",
        ipAddress: actor.ipAddress ?? null,
        metadata: {
          clientId: client.clientId,
          name: client.name,
          oauthClientId,
          reason: "revoked",
        },
        targetUserId: client.userId,
        userAgent: actor.userAgent ?? null,
      },
      tx,
    );
  }, database);

  const summary = await getClientSummary(oauthClientId, database);

  if (!summary) {
    throw new OAuthClientError("That client no longer exists.", 404);
  }

  return summary;
}

/** Revokes every client an account has, in the caller's transaction. */
export async function revokeOAuthClientsForUser(
  userId: string,
  reason: string,
  tx: DbExecutor,
  actor: { email: string | null; userId: string | null } = {
    email: null,
    userId: null,
  },
): Promise<number> {
  const revokedAt = nowInSeconds();
  const revoked = await tx.query<{
    clientId: string;
    id: string;
    name: string;
  }>(
    `
      UPDATE oauth_clients
      SET revoked_at = $1
      WHERE user_id = $2 AND revoked_at IS NULL
      RETURNING id, name, client_id AS "clientId"
    `,
    [revokedAt, userId],
  );

  await tx.query(
    `
      DELETE FROM oauth_tokens
      WHERE oauth_client_id IN (SELECT id FROM oauth_clients WHERE user_id = $1)
    `,
    [userId],
  );

  for (const client of revoked.rows) {
    await recordSystemAuditEvent(
      {
        actorEmail: actor.email,
        actorUserId: actor.userId,
        createdAt: revokedAt,
        event: "oauth_client_revoked",
        metadata: {
          clientId: client.clientId,
          name: client.name,
          oauthClientId: client.id,
          reason,
        },
        targetUserId: userId,
      },
      tx,
    );
  }

  return revoked.rowCount ?? 0;
}

export type OAuthClientIdentity = {
  clientId: string;
  id: string;
  name: string;
  scope: ApiKeyScope;
  userId: string;
};

/**
 * The client behind an id and secret, or null: unknown id, wrong secret,
 * revoked client, or an owner whose email is not verified or who is closing
 * their account. All look the same to the caller.
 */
export async function authenticateOAuthClient(
  clientId: string,
  clientSecret: string,
  database: DbExecutor = getDb(),
): Promise<OAuthClientIdentity | null> {
  const row = await queryOne<
    OAuthClientIdentity & { emailVerified: boolean; secretHash: string }
  >(
    database,
    `
      SELECT
        c.id,
        c.client_id AS "clientId",
        c.name,
        c.scope,
        c.user_id AS "userId",
        c.secret_hash AS "secretHash",
        u."emailVerified" AS "emailVerified"
      FROM oauth_clients c
      JOIN "user" u ON u.id = c.user_id
      WHERE c.client_id = $1
        AND c.revoked_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM account_closure_requests a WHERE a.user_id = u.id
        )
    `,
    [clientId],
  );

  // Hashed either way, so an unknown id costs the same as a wrong secret.
  const presentedHash = hashOAuthSecret(clientSecret);
  const storedHash = row?.secretHash ?? "0".repeat(64);
  const matches = timingSafeEqual(
    Buffer.from(storedHash),
    Buffer.from(presentedHash),
  );

  if (!row || !matches || row.emailVerified !== true) {
    return null;
  }

  return {
    clientId: row.clientId,
    id: row.id,
    name: row.name,
    scope: row.scope,
    userId: row.userId,
  };
}

/** Makes a token for an authenticated client. The token is never stored. */
export async function issueOAuthToken(
  client: OAuthClientIdentity,
  scope: ApiKeyScope,
  database: DbExecutor = getDb(),
  now: number = nowInSeconds(),
): Promise<{ accessToken: string; expiresIn: number; scope: ApiKeyScope }> {
  const accessToken = generateOAuthToken();

  // Expired tokens of this client are cleared as new ones are made.
  await database.query(
    `DELETE FROM oauth_tokens WHERE oauth_client_id = $1 AND expires_at <= $2`,
    [client.id, now],
  );
  await database.query(
    `
      INSERT INTO oauth_tokens (
        token_hash, oauth_client_id, scope, created_at, expires_at
      ) VALUES ($1, $2, $3, $4, $5)
    `,
    [
      hashOAuthSecret(accessToken),
      client.id,
      scope,
      now,
      now + OAUTH_TOKEN_TTL_SECONDS,
    ],
  );
  await database
    .query(`UPDATE oauth_clients SET last_used_at = $1 WHERE id = $2`, [
      now,
      client.id,
    ])
    .catch((error: unknown) => {
      console.error("Recording when an OAuth client was used failed:", error);
    });

  return { accessToken, expiresIn: OAUTH_TOKEN_TTL_SECONDS, scope };
}

/**
 * The account a presented access token acts as, or null if the token is
 * unknown, expired, or its client is revoked or its owner no longer allowed.
 * Shaped like an API key's principal so routes treat both alike.
 */
export async function authenticateOAuthToken(
  presented: string,
  database: DbExecutor = getDb(),
  now: number = nowInSeconds(),
): Promise<ApiKeyPrincipal | null> {
  if (!looksLikeOAuthToken(presented)) {
    return null;
  }

  const row = await queryOne<{
    clientLastUsedAt: number | null;
    email: string;
    emailVerified: boolean;
    id: string;
    name: string;
    role: string;
    scope: ApiKeyScope;
    userId: string;
    userName: string;
  }>(
    database,
    `
      SELECT
        c.id,
        c.name,
        c.last_used_at AS "clientLastUsedAt",
        t.scope,
        u.id AS "userId",
        u.email,
        u.name AS "userName",
        u.role,
        u."emailVerified" AS "emailVerified"
      FROM oauth_tokens t
      JOIN oauth_clients c ON c.id = t.oauth_client_id
      JOIN "user" u ON u.id = c.user_id
      WHERE t.token_hash = $1
        AND t.expires_at > $2
        AND c.revoked_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM account_closure_requests a WHERE a.user_id = u.id
        )
    `,
    [hashOAuthSecret(presented), now],
  );

  if (!row || row.emailVerified !== true) {
    return null;
  }

  if (
    row.clientLastUsedAt === null ||
    now - row.clientLastUsedAt >= LAST_USED_WRITE_INTERVAL_SECONDS
  ) {
    await database
      .query(
        `
          UPDATE oauth_clients SET last_used_at = $1::bigint
          WHERE id = $2
            AND (last_used_at IS NULL OR last_used_at <= $1::bigint - $3::bigint)
        `,
        [now, row.id, LAST_USED_WRITE_INTERVAL_SECONDS],
      )
      .catch((error: unknown) => {
        console.error("Recording when an OAuth client was used failed:", error);
      });
  }

  return {
    apiKey: { id: row.id, name: row.name, scope: row.scope },
    user: {
      email: row.email,
      id: row.userId,
      isAdmin: row.role === "admin",
      name: row.userName,
    },
  };
}
