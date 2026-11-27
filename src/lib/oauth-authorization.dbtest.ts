import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { after, before, test } from "node:test";

import type pg from "pg";

import { replaceDbPoolForTests } from "./db/connection.ts";
import { openTestDatabase } from "./db/test-database.ts";
import {
  authenticateOAuthToken,
  createOAuthClient,
  issueOAuthToken,
} from "./oauth.ts";
import {
  createAuthorizationCode,
  exchangeAuthorizationCode,
  listOAuthGrantsForUser,
  parseAuthorizeRequest,
  pkceChallengeFor,
  refreshOAuthToken,
  revokeOAuthGrant,
  revokeOAuthTokenForClient,
  type GrantResult,
} from "./oauth-authorization.ts";
import type { requireApiKey as RequireApiKey } from "./auth/api-key.ts";

// The authorization code flow against a real Postgres. Run with
// `npm run test:db`.

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^next\/[a-z-]+$/.test(specifier)) {
      return nextResolve(`${specifier}.js`, context);
    }

    return nextResolve(specifier, context);
  },
});

const REDIRECT = "https://app.example.test/callback";

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

async function createUser() {
  const id = randomUUID();

  createdUsers.push(id);
  await database.query(
    `
      insert into public."user" (id, name, email, role, "emailVerified")
      values ($1, $2, $3, 'user', true)
    `,
    [id, `Person ${id.slice(0, 4)}`, `${id}@example.test`],
  );

  return { email: `${id}@example.test`, userId: id };
}

async function setup(options: { isPublic?: boolean } = {}) {
  const owner = await createUser();
  const person = await createUser();
  const { summary } = await createOAuthClient(
    owner,
    {
      isPublic: options.isPublic ?? true,
      name: "Mobile app",
      redirectUris: [REDIRECT],
      scope: "write",
    },
    database,
  );

  return {
    client: { id: summary.id, userId: owner.userId },
    owner,
    person,
    summary,
  };
}

function authorizeParams(clientId: string, extra: Record<string, string> = {}) {
  const verifier = randomBytes(32).toString("base64url");
  const params: Record<string, string> = {
    client_id: clientId,
    code_challenge: pkceChallengeFor(verifier),
    code_challenge_method: "S256",
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: "write",
    state: "s1",
    ...extra,
  };

  return { params, verifier };
}

async function authorize(
  clientId: string,
  person: { email: string; userId: string },
  extra: Record<string, string> = {},
) {
  const { params, verifier } = authorizeParams(clientId, extra);
  const parsed = await parseAuthorizeRequest((name) => params[name], database);

  assert.ok(parsed.ok, JSON.stringify(parsed));

  const code = await createAuthorizationCode(person, parsed.request, database);

  return { code, request: parsed.request, verifier };
}

function granted(result: GrantResult) {
  assert.ok(result.ok, JSON.stringify(result));

  return result.tokens;
}

function apiRequest(token: string) {
  return new Request("https://sign.example.test/api/v1/me", {
    headers: { authorization: `Bearer ${token}` },
  });
}

test("a person allows an app, which then acts as that person and not as its owner", async () => {
  const { client, owner, person } = await setup();
  const { code, verifier } = await authorize(
    (
      await database.query(
        `select client_id from oauth_clients where id = $1`,
        [client.id],
      )
    ).rows[0].client_id,
    person,
  );
  const tokens = granted(
    await exchangeAuthorizationCode(
      client,
      { code, codeVerifier: verifier, redirectUri: REDIRECT },
      database,
    ),
  );

  assert.ok(tokens.refreshToken);
  assert.equal(tokens.scope, "write");

  const principal = await requireApiKey(
    apiRequest(tokens.accessToken),
    "write",
  );

  assert.ok(!(principal instanceof Response));
  assert.equal(principal.user.id, person.userId);
  assert.notEqual(principal.user.id, owner.userId);
  assert.equal(principal.oauth, true);
});

test("a code works once, and not with the wrong verifier, address or client", async () => {
  const { client, person, summary } = await setup();
  const other = await setup();

  const first = await authorize(summary.clientId, person);
  const used = {
    code: first.code,
    codeVerifier: first.verifier,
    redirectUri: REDIRECT,
  };

  granted(await exchangeAuthorizationCode(client, used, database));
  assert.deepEqual(await exchangeAuthorizationCode(client, used, database), {
    description: "The code is not valid, has expired or was already used.",
    error: "invalid_grant",
    ok: false,
  });

  // A wrong verifier burns the code too.
  const second = await authorize(summary.clientId, person);

  assert.equal(
    (
      await exchangeAuthorizationCode(
        client,
        {
          code: second.code,
          codeVerifier: randomBytes(32).toString("base64url"),
          redirectUri: REDIRECT,
        },
        database,
      )
    ).ok,
    false,
  );
  assert.equal(
    (
      await exchangeAuthorizationCode(
        client,
        {
          code: second.code,
          codeVerifier: second.verifier,
          redirectUri: REDIRECT,
        },
        database,
      )
    ).ok,
    false,
  );

  const third = await authorize(summary.clientId, person);

  assert.equal(
    (
      await exchangeAuthorizationCode(
        client,
        {
          code: third.code,
          codeVerifier: third.verifier,
          redirectUri: "https://evil.example.test/callback",
        },
        database,
      )
    ).ok,
    false,
  );

  // Another client cannot trade this client's code.
  const fourth = await authorize(summary.clientId, person);

  assert.equal(
    (
      await exchangeAuthorizationCode(
        other.client,
        {
          code: fourth.code,
          codeVerifier: fourth.verifier,
          redirectUri: REDIRECT,
        },
        database,
      )
    ).ok,
    false,
  );
});

test("an expired code is refused", async () => {
  const { client, person, summary } = await setup();
  const { code, verifier } = await authorize(summary.clientId, person);
  const later = Math.floor(Date.now() / 1000) + 601;

  assert.equal(
    (
      await exchangeAuthorizationCode(
        client,
        { code, codeVerifier: verifier, redirectUri: REDIRECT },
        database,
        later,
      )
    ).ok,
    false,
  );
});

test("refresh tokens rotate, and using an old one ends the whole sign-in", async () => {
  const { client, person, summary } = await setup();
  const { code, verifier } = await authorize(summary.clientId, person);
  const first = granted(
    await exchangeAuthorizationCode(
      client,
      { code, codeVerifier: verifier, redirectUri: REDIRECT },
      database,
    ),
  );

  assert.ok(first.refreshToken);

  const second = granted(
    await refreshOAuthToken(client, first.refreshToken, null, database),
  );

  assert.ok(second.refreshToken);
  assert.notEqual(second.refreshToken, first.refreshToken);
  assert.ok(await authenticateOAuthToken(second.accessToken, database));

  // The first refresh token is spent. Presenting it again is a theft.
  const replay = await refreshOAuthToken(
    client,
    first.refreshToken,
    null,
    database,
  );

  assert.equal(replay.ok, false);
  assert.equal(
    await authenticateOAuthToken(second.accessToken, database),
    null,
  );
  assert.equal(
    (await refreshOAuthToken(client, second.refreshToken, null, database)).ok,
    false,
  );
});

test("a refresh can ask for less access but not more", async () => {
  const { client, person, summary } = await setup();
  const { code, verifier } = await authorize(summary.clientId, person, {
    scope: "read",
  });
  const first = granted(
    await exchangeAuthorizationCode(
      client,
      { code, codeVerifier: verifier, redirectUri: REDIRECT },
      database,
    ),
  );

  assert.equal(first.scope, "read");
  assert.ok(first.refreshToken);

  const asked = await refreshOAuthToken(
    client,
    first.refreshToken,
    "write",
    database,
  );

  assert.ok(!asked.ok);
  assert.equal(asked.error, "invalid_scope");
});

test("the consent request is checked: client, address, challenge and scope", async () => {
  const { summary } = await setup();
  const ask = (extra: Record<string, string>, drop: string[] = []) => {
    const { params } = authorizeParams(summary.clientId, extra);

    for (const name of drop) {
      delete params[name];
    }

    return parseAuthorizeRequest((name) => params[name], database);
  };

  assert.equal((await ask({ client_id: "gcmc_unknown" })).ok, false);
  assert.deepEqual(
    await ask({ redirect_uri: "https://evil.example.test/callback" }),
    {
      kind: "fatal",
      message: "The address this app asked to return to is not one it set up.",
      ok: false,
    },
  );

  // With one address registered, leaving it out uses that one.
  const omitted = await ask({}, ["redirect_uri"]);

  assert.ok(omitted.ok);
  assert.equal(omitted.request.redirectUri, REDIRECT);

  for (const [extra, drop, error] of [
    [{ response_type: "token" }, [], "unsupported_response_type"],
    [{}, ["code_challenge"], "invalid_request"],
    [{ code_challenge_method: "plain" }, [], "invalid_request"],
    [{ scope: "admin" }, [], "invalid_scope"],
  ] as const) {
    const refused = await ask({ ...extra }, [...drop]);

    assert.ok(!refused.ok && refused.kind === "redirect", error);
    assert.equal(refused.error, error);
    assert.equal(refused.state, "s1");
  }

  // Asking for no scope gets the safer read.
  const quiet = await ask({}, ["scope"]);

  assert.ok(quiet.ok);
  assert.equal(quiet.request.scope, "read");
});

test("an app cannot ask for more than its client has", async () => {
  const owner = await createUser();
  const { summary } = await createOAuthClient(
    owner,
    { isPublic: true, name: "Reader", redirectUris: [REDIRECT], scope: "read" },
    database,
  );
  const { params } = authorizeParams(summary.clientId, { scope: "write" });
  const parsed = await parseAuthorizeRequest((name) => params[name], database);

  assert.ok(!parsed.ok && parsed.kind === "redirect");
  assert.equal(parsed.error, "invalid_scope");
});

test("a person sees the apps they allowed and can take access back", async () => {
  const { client, person, summary } = await setup();
  const { code, verifier } = await authorize(summary.clientId, person);
  const tokens = granted(
    await exchangeAuthorizationCode(
      client,
      { code, codeVerifier: verifier, redirectUri: REDIRECT },
      database,
    ),
  );
  const grants = await listOAuthGrantsForUser(person.userId, database);

  assert.deepEqual(
    grants.map((grant) => [grant.name, grant.scope]),
    [["Mobile app", "write"]],
  );
  assert.deepEqual(await listOAuthGrantsForUser(client.userId, database), []);

  assert.equal(await revokeOAuthGrant(person, summary.id, database), true);
  assert.equal(
    await authenticateOAuthToken(tokens.accessToken, database),
    null,
  );
  assert.equal(
    (await refreshOAuthToken(client, tokens.refreshToken ?? "", null, database))
      .ok,
    false,
  );
  assert.deepEqual(await listOAuthGrantsForUser(person.userId, database), []);
  assert.equal(await revokeOAuthGrant(person, summary.id, database), false);
});

test("an app can give a refresh token back, and only its own", async () => {
  const { client, person, summary } = await setup();
  const other = await setup();
  const { code, verifier } = await authorize(summary.clientId, person);
  const tokens = granted(
    await exchangeAuthorizationCode(
      client,
      { code, codeVerifier: verifier, redirectUri: REDIRECT },
      database,
    ),
  );

  assert.ok(tokens.refreshToken);

  // Another client's attempt is ignored.
  await revokeOAuthTokenForClient(other.client, tokens.refreshToken, database);
  assert.ok(await authenticateOAuthToken(tokens.accessToken, database));

  await revokeOAuthTokenForClient(client, tokens.refreshToken, database);
  assert.equal(
    await authenticateOAuthToken(tokens.accessToken, database),
    null,
  );
});

test("a revoked client and a closing account stop the tokens made for people", async () => {
  const { client, owner, person, summary } = await setup();
  const { code, verifier } = await authorize(summary.clientId, person);
  const tokens = granted(
    await exchangeAuthorizationCode(
      client,
      { code, codeVerifier: verifier, redirectUri: REDIRECT },
      database,
    ),
  );

  await database.query(
    `insert into account_closure_requests
       (user_id, requested_at, export_expires_at, purge_after_at, updated_at)
     values ($1, 1, 2, 3, 1)`,
    [person.userId],
  );
  assert.equal(
    await authenticateOAuthToken(tokens.accessToken, database),
    null,
  );
  await database.query(
    `delete from account_closure_requests where user_id = $1`,
    [person.userId],
  );

  assert.ok(await authenticateOAuthToken(tokens.accessToken, database));

  await database.query(
    `update oauth_clients set revoked_at = 1 where id = $1`,
    [summary.id],
  );
  assert.equal(
    await authenticateOAuthToken(tokens.accessToken, database),
    null,
  );
  assert.ok(owner);
});

test("client credentials tokens still act as the owner", async () => {
  const { client, owner } = await setup({ isPublic: false });
  const token = await issueOAuthToken(client, "read", database);
  const principal = await authenticateOAuthToken(token.accessToken, database);

  assert.equal(principal?.user.id, owner.userId);
  assert.equal(token.refreshToken, undefined);
});
