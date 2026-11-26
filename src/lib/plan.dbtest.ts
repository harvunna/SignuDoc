import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";

import { PDFDocument } from "pdf-lib";
import type pg from "pg";

import { createApiKey } from "./api-keys.ts";
import {
  apiCreateEnvelopeSchema,
  createEnvelopeForApi,
  sendEnvelopeForApi,
  type ApiActor,
} from "./api/envelopes.ts";
import { BulkSendError, bulkSendFromTemplate } from "./bulk-send.ts";
import { openTestDatabase } from "./db/test-database.ts";
import {
  createDraftEnvelope,
  EnvelopeMutationError,
  replaceDraftEnvelopeFields,
  replaceDraftEnvelopeSigners,
  sendDraftEnvelope,
} from "./envelopes.ts";
import {
  claimMonthlySend,
  envelopeLimitMessage,
  readEnvelopesSentInMonth,
  readUsageReport,
  SITE_PAUSED_MESSAGE,
  usageMonth,
} from "./plan.ts";
import {
  createStorageService,
  type StorageService,
} from "./services/storage.ts";
import {
  createDraftFromTemplate,
  saveEnvelopeAsTemplate,
} from "./templates.ts";

// GCM eSign plans against a real Postgres: a paused site and a month's limit
// stop every way of sending (the web app's send, the API, templates, bulk
// send), because they all end in sendDraftEnvelope. Run with
// `npm run test:db`.
//
// The month's counter is shared with every other test that sends, so the
// limits here are set from what it already holds.

const SETTINGS = [
  "APP_URL",
  "DATABASE_URL",
  "EMAIL_CAPTURE_DIR",
  "EMAIL_DRIVER",
  "SIGNLY_MAX_ENVELOPES_PER_MONTH",
  "SIGNLY_SITE_STATUS",
  "STORAGE_DRIVER",
  "STORAGE_LOCAL_DIR",
] as const;

let database: pg.Pool;
let storageService: StorageService;
let sourcePdf: Uint8Array;
let workDir: string;
const createdUsers: string[] = [];
const settingsBefore = new Map<string, string | undefined>();

before(async () => {
  database = await openTestDatabase();
  workDir = await mkdtemp(path.join(tmpdir(), "signly-plan-"));

  for (const name of SETTINGS) {
    settingsBefore.set(name, process.env[name]);
  }

  process.env.APP_URL = "http://localhost:3000";
  process.env.DATABASE_URL =
    process.env.E2E_DATABASE_URL ??
    "postgres://signudoc:signudoc@127.0.0.1:5432/signudoc_e2e";
  process.env.EMAIL_CAPTURE_DIR = path.join(workDir, "outbox");
  process.env.EMAIL_DRIVER = "capture";
  process.env.STORAGE_DRIVER = "local";
  process.env.STORAGE_LOCAL_DIR = path.join(workDir, "storage");
  storageService = createStorageService({
    env: {
      STORAGE_DRIVER: "local",
      STORAGE_LOCAL_DIR: process.env.STORAGE_LOCAL_DIR,
    },
  });

  const pdf = await PDFDocument.create();

  pdf.addPage([612, 792]);
  sourcePdf = await pdf.save();
});

afterEach(() => {
  delete process.env.SIGNLY_MAX_ENVELOPES_PER_MONTH;
  delete process.env.SIGNLY_SITE_STATUS;
  process.env.EMAIL_CAPTURE_DIR = path.join(workDir, "outbox");
});

after(async () => {
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  await database.end();

  for (const [name, value] of settingsBefore) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  await rm(workDir, { force: true, recursive: true });
});

async function createUser(): Promise<string> {
  const userId = randomUUID();

  createdUsers.push(userId);
  await database.query(
    `
      insert into public."user" (id, name, email, role, "emailVerified")
      values ($1, 'Sam Sender', $2, 'user', true)
    `,
    [userId, `${userId}@example.test`],
  );

  return userId;
}

async function createActor(): Promise<ApiActor> {
  const userId = await createUser();
  const email = `${userId}@example.test`;
  const { summary } = await createApiKey(
    { email, userId },
    { expiresInDays: null, name: "Billing app", scope: "write" },
    database,
  );

  return {
    apiKeyId: summary.id,
    email,
    ipAddress: "203.0.113.7",
    name: "Sam Sender",
    userAgent: "billing-app/1.0",
    userId,
  };
}

/** A draft with one signer and one signature field, ready to send. */
async function createSendableDraft(userId: string): Promise<string> {
  const draft = await createDraftEnvelope(
    userId,
    {
      sourcePdf: { body: sourcePdf, filename: "nda.pdf" },
      title: "Company NDA",
    },
    { database, storageService },
  );
  const saved = await replaceDraftEnvelopeSigners(
    userId,
    draft.envelope.id,
    {
      signers: [
        { email: `riley-${randomUUID()}@example.test`, name: "Riley Signer" },
      ],
    },
    database,
  );

  await replaceDraftEnvelopeFields(
    userId,
    draft.envelope.id,
    {
      fields: [
        {
          height: 0.03,
          page: 1,
          required: true,
          signerId: saved.signers[0]!.id,
          type: "signature",
          width: 0.2,
          x: 0.1,
          y: 0.1,
        },
      ],
    },
    database,
  );

  return draft.envelope.id;
}

function sendFromWeb(userId: string, envelopeId: string) {
  return sendDraftEnvelope(
    userId,
    envelopeId,
    { senderEmail: `${userId}@example.test`, senderName: "Sam Sender" },
    { database },
  );
}

async function statusOf(envelopeId: string): Promise<string | undefined> {
  const result = await database.query<{ status: string }>(
    `select status from envelopes where id = $1`,
    [envelopeId],
  );

  return result.rows[0]?.status;
}

function sentThisMonth(): Promise<number> {
  return readEnvelopesSentInMonth(
    usageMonth(Math.floor(Date.now() / 1000)),
    database,
  );
}

/** Leaves room for `room` more sends this month. */
async function allowOnly(room: number): Promise<number> {
  const limit = (await sentThisMonth()) + room;

  process.env.SIGNLY_MAX_ENVELOPES_PER_MONTH = String(limit);
  return limit;
}

function isPlanRefusal(code: "plan_limit_reached" | "site_paused") {
  return (error: unknown) =>
    error instanceof EnvelopeMutationError &&
    error.statusCode === 402 &&
    error.code === code;
}

test("without plan settings, sends are counted but never refused", async () => {
  const userId = await createUser();
  const before = await sentThisMonth();

  for (let index = 0; index < 2; index += 1) {
    await sendFromWeb(userId, await createSendableDraft(userId));
  }

  assert.equal(await sentThisMonth(), before + 2);
});

test("a paused site sends nothing from the web app, and the draft stays a draft", async () => {
  const userId = await createUser();
  const envelopeId = await createSendableDraft(userId);
  const before = await sentThisMonth();

  process.env.SIGNLY_SITE_STATUS = "paused";

  await assert.rejects(
    sendFromWeb(userId, envelopeId),
    isPlanRefusal("site_paused"),
  );
  assert.equal(await statusOf(envelopeId), "draft");
  assert.equal(await sentThisMonth(), before);

  // Active again: the same draft goes out.
  delete process.env.SIGNLY_SITE_STATUS;
  await sendFromWeb(userId, envelopeId);
  assert.equal(await statusOf(envelopeId), "sent");
});

test("the web app's sends stop at the month's limit", async () => {
  const userId = await createUser();
  const limit = await allowOnly(1);
  const first = await createSendableDraft(userId);
  const second = await createSendableDraft(userId);

  await sendFromWeb(userId, first);
  await assert.rejects(sendFromWeb(userId, second), (error: unknown) => {
    assert.ok(isPlanRefusal("plan_limit_reached")(error));
    assert.equal((error as Error).message, envelopeLimitMessage(limit));
    return true;
  });

  assert.equal(await statusOf(first), "sent");
  assert.equal(await statusOf(second), "draft");
  assert.equal(await sentThisMonth(), limit);
});

test("the API's sends stop too, with 402 and a code of their own", async () => {
  const actor = await createActor();
  const draft = await createSendableDraft(actor.userId);

  process.env.SIGNLY_SITE_STATUS = "paused";

  const paused = await sendEnvelopeForApi(
    actor,
    draft,
    { permittedUseConfirmed: true },
    database,
  ).then(
    () => null,
    (error: unknown) => error,
  );
  // The API answers with this error's status and code (apiErrorFor in
  // api/route.ts, tested in route.dbtest.ts).
  assert.ok(isPlanRefusal("site_paused")(paused));
  assert.equal((paused as Error).message, SITE_PAUSED_MESSAGE);

  delete process.env.SIGNLY_SITE_STATUS;
  await allowOnly(0);

  // The one-call create with send: refused, and its draft removed again.
  const before = await database.query<{ total: number }>(
    `select count(*)::int as total from envelopes where user_id = $1`,
    [actor.userId],
  );
  const refused = await createEnvelopeForApi(
    actor,
    apiCreateEnvelopeSchema.parse({
      fields: [
        {
          height: 0.05,
          page: 1,
          signer: "client",
          type: "signature",
          width: 0.3,
          x: 0.1,
          y: 0.8,
        },
      ],
      send: { permittedUseConfirmed: true },
      signers: [
        {
          email: `client-${randomUUID()}@example.test`,
          name: "Cleo Client",
          ref: "client",
        },
      ],
      title: "Invoice 1042",
    }),
    { body: sourcePdf, contentType: "application/pdf", filename: "a.pdf" },
    database,
  ).then(
    () => null,
    (error: unknown) => error,
  );
  assert.ok(isPlanRefusal("plan_limit_reached")(refused));

  const afterwards = await database.query<{ total: number }>(
    `select count(*)::int as total from envelopes where user_id = $1`,
    [actor.userId],
  );

  assert.equal(afterwards.rows[0]?.total, before.rows[0]?.total);
});

test("an envelope made from a template is limited when it is sent", async () => {
  const actor = await createActor();
  const source = await createSendableDraft(actor.userId);
  const template = await saveEnvelopeAsTemplate(
    actor.userId,
    source,
    { name: "NDA", roleNames: ["Signer"] },
    { database, storageService },
  );
  const draft = await createDraftFromTemplate(
    actor.userId,
    template.id,
    {
      signers: [
        { email: `tpl-${randomUUID()}@example.test`, name: "Tia Template" },
      ],
      title: "NDA for Tia",
    },
    { database, storageService },
  );

  await allowOnly(0);
  await assert.rejects(
    sendEnvelopeForApi(
      actor,
      draft.envelopeId,
      { permittedUseConfirmed: true },
      database,
    ),
    isPlanRefusal("plan_limit_reached"),
  );
  assert.equal(await statusOf(draft.envelopeId), "draft");
});

async function createTemplate(userId: string) {
  return saveEnvelopeAsTemplate(
    userId,
    await createSendableDraft(userId),
    { name: "Company NDA", roleNames: ["Signer"] },
    { database, storageService },
  );
}

function bulkCsv(count: number): string {
  return [
    "Signer name,Signer email",
    ...Array.from(
      { length: count },
      (_, index) =>
        `Person ${String(index + 1)},bulk-${randomUUID()}@example.test`,
    ),
  ].join("\n");
}

function bulkConfirm(csv: string) {
  return {
    batchKey: randomUUID(),
    confirm: true,
    csv,
    permittedUseConfirmed: true,
  };
}

test("bulk send stops at the month's limit, and the rest of the list waits", async () => {
  const userId = await createUser();
  const template = await createTemplate(userId);
  const limit = await allowOnly(2);
  const body = bulkConfirm(bulkCsv(4));
  const sender = { email: `${userId}@example.test`, name: "Sam Sender" };

  const result = await bulkSendFromTemplate(userId, template.id, body, {
    database,
    sender,
    storageService,
  });

  assert.equal(result.summary.sent, 2);
  assert.equal(result.summary.failed, 2);
  assert.deepEqual(
    result.rows.map((row) => row.status),
    ["sent", "sent", "failed", "failed"],
  );

  for (const row of result.rows.slice(2)) {
    assert.equal(row.reason, envelopeLimitMessage(limit));
  }

  // Only the row that hit the limit made a draft; the one after it was not
  // tried at all.
  assert.ok(result.rows[2]?.envelopeId);
  assert.equal(result.rows[3]?.envelopeId, null);
  assert.equal(await sentThisMonth(), limit);

  // With room again, confirming the same batch sends the row that was
  // never tried, and keeps the ones already done.
  await allowOnly(5);

  const retried = await bulkSendFromTemplate(userId, template.id, body, {
    database,
    sender,
    storageService,
  });

  assert.deepEqual(
    retried.rows.map((row) => row.status),
    ["sent", "sent", "failed", "sent"],
  );
});

test("bulk send on a paused site or a used-up month sends none of the list", async () => {
  const userId = await createUser();
  const template = await createTemplate(userId);
  const sender = { email: `${userId}@example.test`, name: "Sam Sender" };
  const before = await sentThisMonth();

  for (const setUp of [
    () => {
      process.env.SIGNLY_SITE_STATUS = "paused";
    },
    async () => {
      delete process.env.SIGNLY_SITE_STATUS;
      await allowOnly(0);
    },
  ]) {
    await setUp();
    await assert.rejects(
      bulkSendFromTemplate(userId, template.id, bulkConfirm(bulkCsv(2)), {
        database,
        sender,
        storageService,
      }),
      (error: unknown) =>
        error instanceof BulkSendError && error.statusCode === 402,
    );
  }

  assert.equal(await sentThisMonth(), before);

  // Previewing the list still works.
  const preview = await bulkSendFromTemplate(
    userId,
    template.id,
    { csv: bulkCsv(2) },
    { database, sender, storageService },
  );

  assert.equal(preview.rows.length, 2);
});

test("a send whose invitation fails gives its place in the month back", async () => {
  const userId = await createUser();
  const envelopeId = await createSendableDraft(userId);
  const before = await sentThisMonth();
  const notADirectory = path.join(workDir, "not-a-directory");

  // The captured email cannot be written, so the first invitation fails
  // and the envelope goes back to being a draft.
  await writeFile(notADirectory, "");
  process.env.EMAIL_CAPTURE_DIR = path.join(notADirectory, "outbox");

  await assert.rejects(sendFromWeb(userId, envelopeId));
  assert.equal(await statusOf(envelopeId), "draft");
  assert.equal(await sentThisMonth(), before);
});

test("two sends racing for the last place: one gets it", async () => {
  const sentAt = Math.floor(Date.now() / 1000);

  await allowOnly(1);

  const first = await database.connect();
  const second = await database.connect();

  try {
    await first.query("begin");
    await second.query("begin");

    assert.equal(await claimMonthlySend(first, sentAt), null);

    // The second waits for the first's row, then sees it full.
    const racing = claimMonthlySend(second, sentAt);

    await first.query("commit");

    const refused = await racing;

    assert.equal(refused?.code, "plan_limit_reached");
    await second.query("rollback");
  } finally {
    first.release();
    second.release();
  }
});

test("the usage report counts without naming anyone", async () => {
  const userId = await createUser();

  await createSendableDraft(userId);

  const report = await readUsageReport(database, {
    env: {
      SIGNLY_MAX_ENVELOPES_PER_MONTH: "100",
      SIGNLY_MAX_USERS: "10",
      SIGNLY_PLAN_NAME: "Starter",
      SIGNLY_SITE_STATUS: "paused",
    },
  });

  assert.deepEqual(report.plan, {
    maxEnvelopesPerMonth: 100,
    maxUsers: 10,
    name: "Starter",
  });
  assert.equal(report.status, "paused");
  assert.equal(report.envelopesSentThisMonth, await sentThisMonth());
  assert.ok(report.users >= 1);
  assert.ok(report.envelopes.draft >= 1);
  assert.equal(
    report.envelopes.total,
    report.envelopes.draft +
      report.envelopes.sent +
      report.envelopes.completed +
      report.envelopes.declined +
      report.envelopes.voided,
  );
  assert.equal(report.month, usageMonth(Math.floor(Date.now() / 1000)));
  assert.doesNotMatch(JSON.stringify(report), /@/);
});
