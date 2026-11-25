import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type pg from "pg";

import { openTestDatabase } from "./db/test-database.ts";
import {
  getEnvelopeReport,
  listReportScopesForUser,
  type ReportPeriod,
  ReportError,
} from "./reports.ts";

// Envelope reports against a real Postgres: the numbers, and whose
// envelopes they cover. One's own; with "team", also teammates' sent ones;
// with "all", everyone's, for an administrator only; never anyone's draft.
// Run with `npm run test:db`.
//
// The envelopes are all sent in a period in 2003, which nothing else in
// the shared test database uses, so even the install-wide numbers are
// exactly these.

const DAY = 24 * 60 * 60;
const HOUR = 60 * 60;
const base = Date.UTC(2003, 4, 1) / 1000;
const now = base + 40 * DAY;
const period: ReportPeriod = {
  from: base,
  fromDate: "2003-05-01",
  kind: "custom",
  to: base + 30 * DAY,
  toDate: "2003-05-30",
};

let database: pg.Pool;
const createdUsers: string[] = [];
const createdTeams: string[] = [];

let alice: string;
let bob: string;
let carol: string;
let admin: string;
const ids: Record<string, string> = {};

async function createAccount(role: "admin" | "user"): Promise<string> {
  const id = randomUUID();

  createdUsers.push(id);
  await database.query(
    `
      insert into public."user" (id, name, email, "emailVerified", role)
      values ($1, $2, $3, true, $4)
    `,
    [id, `Person ${id.slice(0, 6)}`, `${id}@example.test`, role],
  );

  return id;
}

async function createTeam(members: string[]) {
  const id = randomUUID();

  createdTeams.push(id);
  await database.query(
    `insert into teams (id, name, created_at, updated_at) values ($1, $2, 0, 0)`,
    [id, `Reports ${id.slice(0, 8)}`],
  );

  for (const member of members) {
    await database.query(
      `insert into team_members (team_id, user_id, added_at) values ($1, $2, 0)`,
      [id, member],
    );
  }
}

async function createEnvelope(
  name: string,
  ownerId: string,
  {
    completedAfter = null,
    expiresAt = null,
    sentAt,
    status,
  }: {
    completedAfter?: number | null;
    expiresAt?: number | null;
    sentAt: number | null;
    status: "completed" | "declined" | "draft" | "sent" | "voided";
  },
) {
  const id = randomUUID();

  ids[name] = id;
  await database.query(
    `
      insert into envelopes (
        id, user_id, title, status, source_pdf_key, source_pdf_filename,
        source_pdf_size_bytes, page_count, source_pdf_hash, sent_at,
        expires_at, completed_at, declined_at, voided_at, created_at,
        updated_at
      ) values (
        $1, $2, $3, $4, 'test/report.pdf', 'contract.pdf', 4, 1, $5, $6, $7,
        $8, $9, $10, $11, $11
      )
    `,
    [
      id,
      ownerId,
      `Report ${name}`,
      status,
      "a".repeat(64),
      sentAt,
      expiresAt,
      completedAfter === null || sentAt === null
        ? null
        : sentAt + completedAfter,
      status === "declined" && sentAt !== null ? sentAt + HOUR : null,
      status === "voided" && sentAt !== null ? sentAt + HOUR : null,
      sentAt ?? base,
    ],
  );
  await database.query(
    `
      insert into signers (id, envelope_id, name, email, sign_order, status)
      values ($1, $2, 'Riley Recipient', $3, 1, $4)
    `,
    [
      randomUUID(),
      id,
      `signer-${name}@example.test`,
      status === "completed"
        ? "signed"
        : status === "sent"
          ? "notified"
          : status === "declined"
            ? "declined"
            : "pending",
    ],
  );
}

before(async () => {
  database = await openTestDatabase();
  alice = await createAccount("user");
  bob = await createAccount("user");
  carol = await createAccount("user");
  admin = await createAccount("admin");
  // Alice and Bob share a team; Carol is on a team of her own.
  await createTeam([alice, bob]);
  await createTeam([carol]);

  // Alice: three completed (2, 6 and 22 hours), one declined, one voided,
  // one past its deadline, two still waiting.
  await createEnvelope("a1", alice, {
    completedAfter: 2 * HOUR,
    sentAt: base + DAY,
    status: "completed",
  });
  await createEnvelope("a2", alice, {
    completedAfter: 6 * HOUR,
    sentAt: base + 2 * DAY,
    status: "completed",
  });
  await createEnvelope("a3", alice, {
    completedAfter: 22 * HOUR,
    sentAt: base + 3 * DAY,
    status: "completed",
  });
  await createEnvelope("a4", alice, {
    sentAt: base + 5 * DAY,
    status: "declined",
  });
  await createEnvelope("a5", alice, {
    sentAt: base + 6 * DAY,
    status: "voided",
  });
  await createEnvelope("a6", alice, {
    expiresAt: base + 35 * DAY,
    sentAt: base + 2 * HOUR,
    status: "sent",
  });
  await createEnvelope("a7", alice, {
    sentAt: base + 4 * DAY,
    status: "sent",
  });
  await createEnvelope("a8", alice, {
    expiresAt: base + 50 * DAY,
    sentAt: base + 10 * DAY,
    status: "sent",
  });
  // Not counted: a draft, one sent the day before the period, and one sent
  // the day after it.
  await createEnvelope("aDraft", alice, { sentAt: null, status: "draft" });
  await createEnvelope("aBefore", alice, {
    completedAfter: HOUR,
    sentAt: base - DAY,
    status: "completed",
  });
  await createEnvelope("aAfter", alice, {
    sentAt: base + 30 * DAY,
    status: "sent",
  });

  // Bob, Alice's teammate: one waiting (sent first of all), one completed,
  // and a draft that somehow carries a sending time, which still stays his.
  await createEnvelope("b1", bob, { sentAt: base + HOUR, status: "sent" });
  await createEnvelope("b2", bob, {
    completedAfter: 4 * HOUR,
    sentAt: base + 7 * DAY,
    status: "completed",
  });
  await createEnvelope("bDraft", bob, {
    sentAt: base + 8 * DAY,
    status: "draft",
  });

  // Carol, on nobody's team.
  await createEnvelope("c1", carol, {
    completedAfter: HOUR,
    sentAt: base + 9 * DAY,
    status: "completed",
  });
});

after(async () => {
  await database.query(`delete from teams where id = any($1)`, [createdTeams]);
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  await database.end();
});

function report(viewer: string, scope: "all" | "mine" | "team") {
  return getEnvelopeReport(viewer, scope, period, database, now);
}

test("one's own report counts each outcome of the period's envelopes", async () => {
  const result = await report(alice, "mine");

  assert.deepEqual(result.totals, {
    completed: 3,
    declined: 1,
    expired: 1,
    sent: 8,
    voided: 1,
    waiting: 2,
  });
  assert.equal(result.completionRate, 3 / 8);
  assert.equal(result.medianSecondsToComplete, 6 * HOUR);
  assert.equal(result.averageSecondsToComplete, 10 * HOUR);
  assert.equal(result.senders.length, 1);
  assert.equal(result.senders[0]?.userId, alice);
  assert.equal(result.senders[0]?.sent, 8);
  assert.equal(result.senders[0]?.medianSecondsToComplete, 6 * HOUR);
  // Still waiting, oldest first; the expired one is not waiting.
  assert.deepEqual(
    result.oldestOpen.map((envelope) => envelope.id),
    [ids.a7, ids.a8],
  );
  assert.equal(result.oldestOpen[0]?.waitingSeconds, now - (base + 4 * DAY));
  assert.equal(result.oldestOpen[0]?.waitingOn, "signer-a7@example.test");
});

test("one's own report never includes anyone else's envelopes", async () => {
  for (const [viewer, sent, own] of [
    [bob, 2, ["b1", "b2"]],
    [carol, 1, ["c1"]],
    [admin, 0, []],
  ] as const) {
    const result = await report(viewer, "mine");

    assert.equal(result.totals.sent, sent);
    assert.deepEqual(
      result.senders.map((sender) => sender.userId),
      sent > 0 ? [viewer] : [],
    );
    for (const envelope of result.oldestOpen) {
      assert.ok(
        own.some((name) => ids[name] === envelope.id),
        "an open envelope of someone else's",
      );
    }
  }
});

test("a team report adds teammates' sent envelopes, never their drafts", async () => {
  for (const viewer of [alice, bob]) {
    const result = await report(viewer, "team");

    assert.equal(result.totals.sent, 10);
    assert.equal(result.totals.completed, 4);
    assert.equal(result.totals.waiting, 3);
    assert.deepEqual(
      result.senders.map((sender) => [sender.userId, sender.sent]),
      [
        [alice, 8],
        [bob, 2],
      ],
    );
    assert.equal(result.oldestOpen[0]?.id, ids.b1);
    assert.ok(!result.oldestOpen.some((envelope) => envelope.id === ids.c1));
  }
});

test("a team report for someone whose team sent nothing is their own", async () => {
  const result = await report(carol, "team");

  assert.equal(result.totals.sent, 1);
  assert.deepEqual(
    result.senders.map((sender) => sender.userId),
    [carol],
  );
});

test("an administrator's report of everyone covers every sender", async () => {
  const result = await report(admin, "all");

  assert.equal(result.totals.sent, 11);
  assert.equal(result.totals.completed, 5);
  assert.deepEqual(
    result.senders.map((sender) => [sender.userId, sender.sent]),
    [
      [alice, 8],
      [bob, 2],
      [carol, 1],
    ],
  );
  // 1, 2, 4, 6 and 22 hours.
  assert.equal(result.medianSecondsToComplete, 4 * HOUR);
  assert.equal(result.oldestOpen.length, 3);
});

test("nobody but an administrator gets a report of everyone", async () => {
  for (const viewer of [alice, bob, carol]) {
    await assert.rejects(
      report(viewer, "all"),
      (error) => error instanceof ReportError && error.statusCode === 403,
    );
  }
});

test("the scopes on offer follow role and teams", async () => {
  assert.deepEqual(await listReportScopesForUser(alice, database), [
    "mine",
    "team",
  ]);
  assert.deepEqual(await listReportScopesForUser(admin, database), [
    "mine",
    "all",
  ]);

  const loner = await createAccount("user");

  assert.deepEqual(await listReportScopesForUser(loner, database), ["mine"]);
});

test("a period with nothing sent reports zeros and no rate", async () => {
  const empty = await getEnvelopeReport(
    alice,
    "mine",
    { ...period, from: base - 400 * DAY, to: base - 300 * DAY },
    database,
    now,
  );

  assert.equal(empty.totals.sent, 0);
  assert.equal(empty.completionRate, null);
  assert.equal(empty.medianSecondsToComplete, null);
  assert.equal(empty.averageSecondsToComplete, null);
  assert.deepEqual(empty.senders, []);
  assert.deepEqual(empty.oldestOpen, []);
});
