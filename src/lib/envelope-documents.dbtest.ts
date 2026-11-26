import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { PDFDocument } from "pdf-lib";
import type pg from "pg";

import { createApiKey } from "./api-keys.ts";
import {
  apiCreateEnvelopeSchema,
  createEnvelopeForApi,
  getApiEnvelope,
  type ApiActor,
} from "./api/envelopes.ts";
import { openTestDatabase } from "./db/test-database.ts";
import {
  copyEnvelopeToDraft,
  createDraftEnvelope,
  EnvelopeMutationError,
  getPrepareEnvelopeDataForUser,
} from "./envelopes.ts";
import { DocumentImportError } from "./services/document-import.ts";
import { createStorageService } from "./services/storage.ts";
import {
  createDraftFromTemplate,
  saveEnvelopeAsTemplate,
} from "./templates.ts";

// GCM eSign: envelopes of several documents against a real Postgres and real
// files. Run with `npm run test:db`.

const SETTINGS = [
  "APP_URL",
  "DATABASE_URL",
  "EMAIL_CAPTURE_DIR",
  "EMAIL_DRIVER",
  "STORAGE_DRIVER",
  "STORAGE_LOCAL_DIR",
] as const;

let database: pg.Pool;
let workDir: string;
const createdUsers: string[] = [];
const settingsBefore = new Map<string, string | undefined>();

before(async () => {
  database = await openTestDatabase();
  workDir = await mkdtemp(path.join(tmpdir(), "esign-documents-"));

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

async function pdfOf(pages: number): Promise<Uint8Array> {
  const document = await PDFDocument.create();

  for (let page = 0; page < pages; page += 1) {
    document.addPage([612, 792]);
  }

  return document.save();
}

async function createActor(): Promise<ApiActor> {
  const userId = randomUUID();
  const email = `${userId}@example.test`;

  createdUsers.push(userId);
  await database.query(
    `
      insert into public."user" (id, name, email, role, "emailVerified")
      values ($1, 'Docs App', $2, 'admin', true)
    `,
    [userId, email],
  );

  const { summary } = await createApiKey(
    { email, userId },
    { expiresInDays: null, name: "Docs app", scope: "write" },
    database,
  );

  return {
    apiKeyId: summary.id,
    email,
    ipAddress: null,
    name: "Docs App",
    userAgent: null,
    userId,
  };
}

function field(overrides: Record<string, unknown>) {
  return {
    height: 0.05,
    page: 1,
    signer: "client",
    type: "signature",
    width: 0.3,
    x: 0.1,
    y: 0.8,
    ...overrides,
  };
}

function request(fields: Array<Record<string, unknown>>) {
  return apiCreateEnvelopeSchema.parse({
    fields,
    signers: [
      { email: "client@example.test", name: "Casey Client", ref: "client" },
    ],
    title: "Offer pack",
  });
}

async function twoDocuments() {
  return [
    {
      body: await pdfOf(2),
      contentType: "application/pdf",
      filename: "Offer.pdf",
    },
    {
      body: await pdfOf(1),
      contentType: "application/pdf",
      filename: "Handbook.pdf",
    },
  ];
}

async function storedDocuments(envelopeId: string): Promise<unknown> {
  const result = await database.query<{ documents: unknown }>(
    `select documents from envelopes where id = $1`,
    [envelopeId],
  );

  return result.rows[0]?.documents;
}

test("several PDFs make one envelope, and fields can name their document", async () => {
  const actor = await createActor();
  const envelope = await createEnvelopeForApi(
    actor,
    request([
      field({ document: 1, page: 2 }),
      field({ document: 2, page: 1, type: "date" }),
      field({ page: 1, type: "text" }),
    ]),
    await twoDocuments(),
    database,
  );

  assert.equal(envelope.pageCount, 3);
  assert.deepEqual(
    envelope.documents.map((document) => [
      document.name,
      document.firstPage,
      document.pageCount,
    ]),
    [
      ["Offer.pdf", 1, 2],
      ["Handbook.pdf", 3, 1],
    ],
  );

  const pages = await database.query<{ page: number; type: string }>(
    `select page, type from fields where envelope_id = $1 order by page`,
    [envelope.id],
  );

  assert.deepEqual(
    pages.rows.map((row) => [row.type, row.page]),
    [
      ["text", 1],
      ["signature", 2],
      ["date", 3],
    ],
  );

  const pageRows = await database.query(
    `select 1 from envelope_pages where envelope_id = $1`,
    [envelope.id],
  );

  assert.equal(pageRows.rowCount, 3);
  assert.ok(Array.isArray(await storedDocuments(envelope.id)));

  const prepared = await getPrepareEnvelopeDataForUser(
    actor.userId,
    envelope.id,
    { database },
  );

  assert.deepEqual(
    prepared?.documents.map((document) => document.name),
    ["Offer.pdf", "Handbook.pdf"],
  );
});

test("a field off its document's pages, or naming no document, is refused", async () => {
  const actor = await createActor();

  await assert.rejects(
    createEnvelopeForApi(
      actor,
      request([field({ document: 2, page: 2 })]),
      await twoDocuments(),
      database,
    ),
    (error: unknown) =>
      error instanceof EnvelopeMutationError &&
      error.message === "fields.0.page: document 2 has 1 page(s).",
  );
  await assert.rejects(
    createEnvelopeForApi(
      actor,
      request([field({ document: 3, page: 1 })]),
      await twoDocuments(),
      database,
    ),
    (error: unknown) =>
      error instanceof EnvelopeMutationError &&
      /envelope has 2 document/.test(error.message),
  );

  const left = await database.query(
    `select 1 from envelopes where user_id = $1`,
    [actor.userId],
  );

  assert.equal(left.rowCount, 0);
});

test("one PDF is stored as before, with no document list", async () => {
  const actor = await createActor();
  const envelope = await createEnvelopeForApi(
    actor,
    request([field({ page: 1 })]),
    { body: await pdfOf(1), contentType: "application/pdf", filename: "a.pdf" },
    database,
  );

  assert.equal(await storedDocuments(envelope.id), null);
  assert.deepEqual(
    envelope.documents.map((document) => document.name),
    ["a.pdf"],
  );
});

test("a bad file among several is named and nothing is made", async () => {
  const actor = await createActor();

  await assert.rejects(
    createDraftEnvelope(
      actor.userId,
      {
        sourcePdf: [
          ...(await twoDocuments()),
          {
            body: new TextEncoder().encode("plain text"),
            contentType: "application/pdf",
            filename: "notes.pdf",
          },
        ],
        title: "Pack",
      },
      { database },
    ),
    (error: unknown) =>
      error instanceof DocumentImportError &&
      error.message.startsWith("notes.pdf: "),
  );
});

test("templates and copies keep the documents of the envelope", async () => {
  const actor = await createActor();
  const storageService = createStorageService();
  const envelope = await createEnvelopeForApi(
    actor,
    {
      ...request([field({ document: 2, page: 1 })]),
      send: { permittedUseConfirmed: true },
    },
    await twoDocuments(),
    database,
  );
  const template = await saveEnvelopeAsTemplate(
    actor.userId,
    envelope.id,
    { name: "Offer pack" },
    { database, storageService },
  );
  const made = await createDraftFromTemplate(
    actor.userId,
    template.id,
    {
      signers: [{ email: "new@example.test", name: "New Person" }],
      title: "Offer pack for New",
    },
    { database, storageService },
  );
  const fromTemplate = await getApiEnvelope(actor.userId, made.envelopeId);

  assert.deepEqual(
    fromTemplate?.documents.map((document) => [
      document.name,
      document.firstPage,
    ]),
    [
      ["Offer.pdf", 1],
      ["Handbook.pdf", 3],
    ],
  );

  const copy = await copyEnvelopeToDraft(actor.userId, envelope.id, {
    database,
    storageService,
  });

  assert.deepEqual(
    await storedDocuments(copy.id),
    await storedDocuments(envelope.id),
  );
});
