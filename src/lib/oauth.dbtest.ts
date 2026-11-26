import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { after, before, test } from "node:test";

import type pg from "pg";

import { replaceDbPoolForTests } from "./db/connection.ts";
import { openTestDatabase } from "./db/test-database.ts";
import {
  authenticateOAuthClient,
  authenticateOAuthToken,
  createOAuthClient,
  issueOAuthToken,
  listOAuthClientsForUser,
  revokeOAuthClient,
  revokeOAuthClientsForUser,
} from "./oauth.ts";
import type { requireApiKey as RequireApiKey } from "./auth/api-key.ts";

// OAuth clients and access tokens against a real Postgres. Run with
// `npm run test:db`.

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^next\/[a-z-]+$/.test(specifier)) {
      return nextResolve(`${specifier}.js`, context);
    }

    return nextResolve(specifier, context);
  },
});

let database: pg.Pool;
let replaced: pg.Pool | null = null;
let requireApiKey: typeof RequireApiKey;
const createdUsers: string[] = [];

before(async () => {
  database = await openTestDatabase();
  replaced = replaceDbPoolForTests(database);
  ({ requireApiKey } = await import("./auth/api-key.ts"));
});

after(async () => {
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  replaceDbPoolForTests(replaced ?? database);
  await database.end();
});

async function createUser(verified = true) {
  const id = randomUUID();

  createdUsers.push(id);
  await database.query(
    `
      insert into public."user" (id, name, email, role, "emailVerified")
      values ($1, $2, $3, 'user', $4)
    `,
    [id, `Person ${id.slice(0, 4)}`, `${id}@example.test`, verified],
  );

  return { email: `${id}@example.test`, userId: id };
}

function apiRequest(token: string) {
  return new Request("https://sign.example.test/api/v1/me", {
    headers: { authorization: `Bearer ${token}` },
  });
}

test("a client trades its secret for a token that reaches the API as its owner", async () => {
  const owner = await createUser();
  const { clientSecret, summary } = await createOAuthClient(
    owner,
    { name: "Billing app", scope: "write" },
    database,
  );

  assert.ok(clientSecret);
  assert.equal(summary.userId, owner.userId);

  const client = await authenticateOAuthClient(
    summary.clientId,
    clientSecret,
    database,
  );

  assert.ok(client);

  const token = await issueOAuthToken(client, "read", database);

  assert.equal(token.expiresIn, 3600);

  const stored = await database.query(
    `select token_hash from oauth_tokens where oauth_client_id = $1`,
    [summary.id],
  );

  assert.equal(stored.rowCount, 1);
  assert.notEqual(stored.rows[0].token_hash, token.accessToken);

  const reading = await requireApiKey(apiRequest(token.accessToken), "read");

  assert.ok(!(reading instanceof Response));
  assert.equal(reading.user.id, owner.userId);
  assert.equal(reading.apiKey.name, "Billing app");
  assert.equal(reading.apiKey.scope, "read");

  const writing = await requireApiKey(apiRequest(token.accessToken), "write");

  assert.ok(writing instanceof Response);
  assert.equal(writing.status, 403);
});

test("a wrong secret, an unknown id and an unverified owner are all turned away", async () => {
  const owner = await createUser();
  const { clientSecret, summary } = await createOAuthClient(
    owner,
    { name: "Reports", scope: "read" },
    database,
  );
  assert.ok(clientSecret);

  assert.equal(
    await authenticateOAuthClient(summary.clientId, "gcms_wrong", database),
    null,
  );
  assert.equal(
    await authenticateOAuthClient("gcmc_unknown", clientSecret, database),
    null,
  );

  await database.query(
    `update "user" set "emailVerified" = false where id = $1`,
    [owner.userId],
  );

  assert.equal(
    await authenticateOAuthClient(summary.clientId, clientSecret, database),
    null,
  );
});

test("an expired token is turned away", async () => {
  const owner = await createUser();
  const { clientSecret, summary } = await createOAuthClient(
    owner,
    { name: "Nightly job", scope: "read" },
    database,
  );
  assert.ok(clientSecret);
  const client = await authenticateOAuthClient(
    summary.clientId,
    clientSecret,
    database,
  );

  assert.ok(client);

  const now = Math.floor(Date.now() / 1000);
  const token = await issueOAuthToken(client, "read", database, now);

  assert.ok(
    await authenticateOAuthToken(token.accessToken, database, now + 3599),
  );
  assert.equal(
    await authenticateOAuthToken(token.accessToken, database, now + 3600),
    null,
  );
});

test("revoking a client ends its tokens at once, and only its owner may", async () => {
  const owner = await createUser();
  const stranger = await createUser();
  const { clientSecret, summary } = await createOAuthClient(
    owner,
    { name: "Old app", scope: "write" },
    database,
  );
  assert.ok(clientSecret);
  const client = await authenticateOAuthClient(
    summary.clientId,
    clientSecret,
    database,
  );

  assert.ok(client);

  const token = await issueOAuthToken(client, "write", database);

  await assert.rejects(
    revokeOAuthClient(stranger, summary.id, database),
    /no longer exists/,
  );
  assert.ok(await authenticateOAuthToken(token.accessToken, database));

  const revoked = await revokeOAuthClient(owner, summary.id, database);

  assert.notEqual(revoked.revokedAt, null);
  assert.equal(await authenticateOAuthToken(token.accessToken, database), null);
  assert.equal(
    await authenticateOAuthClient(summary.clientId, clientSecret, database),
    null,
  );

  const events = await database.query(
    `select event from system_audit_events where target_user_id = $1 or actor_user_id = $1`,
    [owner.userId],
  );

  assert.deepEqual(
    events.rows.map((row: { event: string }) => row.event).sort(),
    ["oauth_client_created", "oauth_client_revoked"],
  );
});

test("clients are listed for their owner and revoked in bulk with a lost role", async () => {
  const owner = await createUser();
  const other = await createUser();

  await createOAuthClient(owner, { name: "One", scope: "read" }, database);
  await createOAuthClient(owner, { name: "Two", scope: "write" }, database);
  await createOAuthClient(other, { name: "Theirs", scope: "read" }, database);

  assert.deepEqual(
    (await listOAuthClientsForUser(owner.userId, database))
      .map((client) => client.name)
      .sort(),
    ["One", "Two"],
  );

  const client = await database.connect();

  try {
    assert.equal(
      await revokeOAuthClientsForUser(owner.userId, "role_removed", client),
      2,
    );
  } finally {
    client.release();
  }

  assert.equal(
    (await listOAuthClientsForUser(other.userId, database))[0]?.revokedAt,
    null,
  );
});
