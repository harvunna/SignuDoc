import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type pg from "pg";

import { getApiEnvelope } from "./api/envelope-view.ts";
import { openTestDatabase } from "./db/test-database.ts";
import { ELECTRONIC_RECORDS_DISCLOSURE_VERSION } from "./electronic-records-disclosure.ts";
import {
  correctSentEnvelopeSigner,
  EnvelopeMutationError,
  getEnvelopeDetailDataForUser,
} from "./envelopes.ts";
import { startInPersonSigning } from "./in-person-signing.ts";
import { sendManualEnvelopeNudge } from "./reminders.ts";
import { listEnvelopeStorageKeys } from "./retention.ts";
import type {
  EmailService,
  TransactionalEmailMessage,
} from "./services/email.ts";
import { issueSigningLink } from "./services/signing-links.ts";
import type { StorageService } from "./services/storage.ts";
import {
  getEnvelopeAttachmentFile,
  listEnvelopeAttachments,
  SignerAttachmentError,
  uploadSignerAttachmentForToken,
} from "./signer-attachments.ts";
import {
  recordSignerConsent,
  SigningAccessError,
  SigningMutationError,
  submitSigningForToken,
} from "./signing.ts";

// GCM eSign: signer attachments, in-person signing, and how a correction
// treats both, against a real Postgres. Run with `npm run test:db`.

process.env.APP_URL ??= "https://sign.example.test";

const DAY = 24 * 60 * 60;
const PDF_BYTES = new TextEncoder().encode("%PDF-1.4\n%test attachment\n");
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]);
const DRAWN_SIGNATURE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

let database: pg.Pool;
const createdUsers: string[] = [];

before(async () => {
  database = await openTestDatabase();
  globalThis.__signudocPgPool = database;
});

after(async () => {
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  await database.end();
});

function unixNow() {
  return Math.floor(Date.now() / 1000);
}

function recordingEmailService() {
  const sent: TransactionalEmailMessage[] = [];
  const service: EmailService = {
    async send(message) {
      sent.push(message);

      return { accepted: [message.to], messageId: "m-1", rejected: [] };
    },
    async sendBatch() {
      throw new Error("not used");
    },
  };

  return { sent, service };
}

/** Keeps what is stored in memory and notes what is deleted. */
function memoryStorage() {
  const objects = new Map<string, Uint8Array>();
  const deleted: string[] = [];
  const refuse = async (): Promise<never> => {
    throw new Error("not used");
  };
  const service: StorageService = {
    deleteObject: async (key) => {
      deleted.push(key);
      objects.delete(key);
    },
    getObject: refuse,
    getObjectStream: refuse,
    headObject: refuse,
    putObject: async ({ body, key }) => {
      objects.set(key, body);
      return { bucketName: "test", key };
    },
  };

  return { deleted, objects, service };
}

async function createOwner() {
  const userId = randomUUID();
  const email = `${userId}@example.test`;

  createdUsers.push(userId);
  await database.query(
    `insert into public."user" (id, name, email, role) values ($1, 'Sam Sender', $2, 'user')`,
    [userId, email],
  );

  return { email, userId };
}

async function createEnvelope(userId: string) {
  const envelopeId = randomUUID();

  await database.query(
    `
      insert into envelopes (
        id, user_id, title, status, source_pdf_key, source_pdf_filename,
        source_pdf_size_bytes, page_count, source_pdf_hash, sent_at,
        expires_at
      ) values (
        $1, $2, 'Lease', 'sent', $3, 'lease.pdf', 10, 1, $4, $5, $6
      )
    `,
    [
      envelopeId,
      userId,
      `users/${userId}/envelopes/${envelopeId}/original.pdf`,
      "a".repeat(64),
      unixNow() - 60,
      unixNow() + 30 * DAY,
    ],
  );

  return envelopeId;
}

async function createSigner({
  envelopeId,
  inPerson = false,
  signOrder,
  status,
}: {
  envelopeId: string;
  inPerson?: boolean;
  signOrder: number;
  status: "notified" | "pending";
}) {
  const signerId = randomUUID();
  const link =
    status === "notified"
      ? await issueSigningLink({ expiresInSeconds: 30 * DAY })
      : null;

  await database.query(
    `
      insert into signers (
        id, envelope_id, name, email, sign_order, status,
        signing_token_hash, signing_token_expires_at, last_notified_at,
        in_person
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `,
    [
      signerId,
      envelopeId,
      `Signer ${String(signOrder)}`,
      `${signerId}@example.test`,
      signOrder,
      status,
      link?.tokenHash ?? null,
      link?.exp ?? null,
      status === "notified" ? unixNow() : null,
      inPerson,
    ],
  );

  return { signerId, token: link?.token ?? null };
}

async function addField(
  envelopeId: string,
  signerId: string,
  type: "attachment" | "signature",
  required = true,
) {
  const fieldId = randomUUID();

  await database.query(
    `
      insert into fields (
        id, envelope_id, signer_id, type, page, x, y, width, height, required
      ) values ($1, $2, $3, $4, 1, 0.1, 0.1, 0.2, 0.1, $5)
    `,
    [fieldId, envelopeId, signerId, type, required],
  );

  return fieldId;
}

function consent(token: string) {
  return recordSignerConsent(
    token,
    { disclosureVersion: ELECTRONIC_RECORDS_DISCLOSURE_VERSION },
    { database },
  );
}

function upload(
  token: string,
  fieldId: string,
  body: Uint8Array,
  storageService: StorageService,
  fileName = "id-card.pdf",
) {
  return uploadSignerAttachmentForToken(
    token,
    fieldId,
    { body, fileName },
    { database, storageService },
  );
}

async function signedEventMetadata(envelopeId: string) {
  const result = await database.query<{ metadata: Record<string, unknown> }>(
    `select metadata from audit_events where envelope_id = $1 and event = 'signed'`,
    [envelopeId],
  );

  return result.rows[0]?.metadata ?? null;
}

/** An envelope out for signature: a first signer and one after them. */
async function twoSignerEnvelope(
  options: { firstInPerson?: boolean; secondInPerson?: boolean } = {},
) {
  const owner = await createOwner();
  const envelopeId = await createEnvelope(owner.userId);
  const first = await createSigner({
    envelopeId,
    inPerson: options.firstInPerson,
    signOrder: 1,
    status: "notified",
  });
  const second = await createSigner({
    envelopeId,
    inPerson: options.secondInPerson,
    signOrder: 2,
    status: "pending",
  });
  const firstSignature = await addField(
    envelopeId,
    first.signerId,
    "signature",
  );

  await addField(envelopeId, second.signerId, "signature");

  return { envelopeId, first, firstSignature, owner, second };
}

test("a signer attaches a file, and the sender can list and fetch it", async () => {
  const { envelopeId, first, firstSignature, owner } =
    await twoSignerEnvelope();
  const required = await addField(envelopeId, first.signerId, "attachment");
  const optional = await addField(
    envelopeId,
    first.signerId,
    "attachment",
    false,
  );
  const storage = memoryStorage();
  const token = first.token!;

  await consent(token);

  // A file that is not a PDF or a picture is refused, whatever its name.
  await assert.rejects(
    upload(
      token,
      required,
      new TextEncoder().encode("<html>"),
      storage.service,
      "x.pdf",
    ),
    (error: unknown) =>
      error instanceof SignerAttachmentError && error.statusCode === 415,
  );

  // Replacing a file deletes the one it replaces.
  const replaced = await upload(token, required, PNG_BYTES, storage.service);
  const kept = await upload(token, required, PDF_BYTES, storage.service);

  assert.equal(kept.contentType, "application/pdf");
  assert.equal(kept.fileName, "id-card.pdf");
  assert.equal(storage.deleted.length, 1);
  assert.match(storage.deleted[0]!, /\/attachments\//);
  assert.ok(!storage.deleted[0]!.endsWith(".pdf"));

  // Uploaded but not used: deleted once the signer has signed.
  await upload(token, optional, PNG_BYTES, storage.service, "spare");

  // A file that is someone else's upload id is refused.
  await assert.rejects(
    submitSigningForToken(
      token,
      {
        clientTimezoneOffsetMinutes: 0,
        fields: [
          {
            fieldId: firstSignature,
            inputMethod: "typed",
            type: "signature",
            value: "Signer 1",
          },
          { fieldId: required, type: "attachment", uploadId: replaced.id },
        ],
      },
      {
        database,
        emailService: recordingEmailService().service,
        storageService: storage.service,
      },
    ),
    (error: unknown) =>
      error instanceof SigningMutationError && error.statusCode === 400,
  );

  // A required attachment left out is refused.
  await assert.rejects(
    submitSigningForToken(
      token,
      {
        clientTimezoneOffsetMinutes: 0,
        fields: [
          {
            fieldId: firstSignature,
            inputMethod: "typed",
            type: "signature",
            value: "Signer 1",
          },
        ],
      },
      {
        database,
        emailService: recordingEmailService().service,
        storageService: storage.service,
      },
    ),
    /Complete all required fields/,
  );

  await submitSigningForToken(
    token,
    {
      clientTimezoneOffsetMinutes: 0,
      fields: [
        {
          fieldId: firstSignature,
          imageDataUrl: DRAWN_SIGNATURE,
          inputMethod: "drawn",
          type: "signature",
        },
        { fieldId: required, type: "attachment", uploadId: kept.id },
      ],
    },
    {
      database,
      emailService: recordingEmailService().service,
      storageService: storage.service,
    },
  );

  const field = await database.query<{
    image_key: string | null;
    submitted_at: number | null;
    value: string | null;
  }>(`select image_key, submitted_at, value from fields where id = $1`, [
    required,
  ]);

  assert.equal(field.rows[0]!.value, "id-card.pdf");
  assert.match(field.rows[0]!.image_key!, /\/attachments\/.+\.pdf$/);
  assert.ok(field.rows[0]!.submitted_at);

  const uploads = await database.query<{ id: string }>(
    `select id from signer_attachment_uploads where envelope_id = $1`,
    [envelopeId],
  );

  assert.deepEqual(
    uploads.rows.map((row) => row.id),
    [kept.id],
  );

  const metadata = await signedEventMetadata(envelopeId);

  assert.deepEqual(metadata?.attachments, [
    {
      contentType: "application/pdf",
      fieldId: required,
      fileName: "id-card.pdf",
      sha256: kept.sha256,
      sizeBytes: PDF_BYTES.byteLength,
    },
  ]);

  const listed = await listEnvelopeAttachments(envelopeId, database);

  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.fileName, "id-card.pdf");
  assert.equal(listed[0]!.signerId, first.signerId);

  const file = await getEnvelopeAttachmentFile(envelopeId, required, database);

  assert.equal(file?.storageKey, field.rows[0]!.image_key);
  assert.equal(
    await getEnvelopeAttachmentFile(envelopeId, optional, database),
    null,
  );

  const apiEnvelope = await getApiEnvelope(owner.userId, envelopeId, database);

  assert.equal(apiEnvelope?.attachments.length, 1);
  assert.equal(
    apiEnvelope?.attachments[0]?.url,
    `/api/v1/envelopes/${envelopeId}/attachments/${required}`,
  );

  const detail = await getEnvelopeDetailDataForUser(
    owner.userId,
    envelopeId,
    database,
  );

  assert.equal(detail?.attachments.length, 1);

  // Deleting the envelope finds the attached file too.
  const keys = await listEnvelopeStorageKeys(envelopeId, database);

  assert.ok(keys.includes(field.rows[0]!.image_key!));
});

test("a file cannot be attached for someone else's field", async () => {
  const { envelopeId, first, second } = await twoSignerEnvelope();
  const theirs = await addField(envelopeId, second.signerId, "attachment");
  const storage = memoryStorage();

  await consent(first.token!);
  await assert.rejects(
    upload(first.token!, theirs, PDF_BYTES, storage.service),
    (error: unknown) =>
      error instanceof SigningMutationError && error.statusCode === 404,
  );
  assert.equal(storage.objects.size, 0);
});

test("an in-person signer is hosted by the sender and never emailed", async () => {
  const { envelopeId, first, firstSignature, owner, second } =
    await twoSignerEnvelope({ firstInPerson: true, secondInPerson: true });

  // The email link issued at send no longer opens once a session starts.
  const before = first.token!;
  const session = await startInPersonSigning(
    owner.userId,
    envelopeId,
    first.signerId,
    { senderEmail: owner.email },
    { database },
  );
  const token = decodeURIComponent(session.signingPath.slice("/sign/".length));

  assert.notEqual(token, before);
  assert.ok(session.expiresAt <= unixNow() + 2 * 60 * 60);
  await assert.rejects(consent(before), SigningAccessError);

  // No reminder goes to someone who signs in person.
  await assert.rejects(
    sendManualEnvelopeNudge(
      owner.userId,
      envelopeId,
      { senderEmail: owner.email, senderName: "Sam Sender" },
      { database, emailService: recordingEmailService().service },
    ),
    /no longer waiting on a signer/,
  );

  // Only the envelope's own sender can host.
  const stranger = await createOwner();

  await assert.rejects(
    startInPersonSigning(
      stranger.userId,
      envelopeId,
      first.signerId,
      { senderEmail: stranger.email },
      { database },
    ),
    (error: unknown) =>
      error instanceof EnvelopeMutationError && error.statusCode === 404,
  );

  // Not their turn yet.
  await assert.rejects(
    startInPersonSigning(
      owner.userId,
      envelopeId,
      second.signerId,
      { senderEmail: owner.email },
      { database },
    ),
    /not this person's turn/,
  );

  await consent(token);

  const email = recordingEmailService();

  await submitSigningForToken(
    token,
    {
      clientTimezoneOffsetMinutes: 0,
      fields: [
        {
          fieldId: firstSignature,
          inputMethod: "typed",
          type: "signature",
          value: "Signer 1",
        },
      ],
    },
    {
      database,
      emailService: email.service,
      storageService: memoryStorage().service,
    },
  );

  const metadata = await signedEventMetadata(envelopeId);

  assert.deepEqual(
    (metadata?.inPerson as { hostEmail: string }).hostEmail,
    owner.email,
  );
  // The next signer also signs in person, so nobody was invited.
  assert.equal(
    email.sent.filter(
      (message) => message.to === `${second.signerId}@example.test`,
    ).length,
    0,
  );

  const detail = await getEnvelopeDetailDataForUser(
    owner.userId,
    envelopeId,
    database,
  );

  assert.equal(
    detail?.signers.find((signer) => signer.id === second.signerId)?.inPerson,
    true,
  );
  assert.equal(detail?.manualReminder, null);
});

test("an email signer cannot be hosted in person", async () => {
  const { envelopeId, first, owner } = await twoSignerEnvelope();

  await assert.rejects(
    startInPersonSigning(
      owner.userId,
      envelopeId,
      first.signerId,
      { senderEmail: owner.email },
      { database },
    ),
    /emailed to them, not in person/,
  );
});

test("correcting an in-person signer replaces their link without email and drops their files", async () => {
  const { envelopeId, first, owner } = await twoSignerEnvelope({
    firstInPerson: true,
  });
  const attachment = await addField(envelopeId, first.signerId, "attachment");
  const session = await startInPersonSigning(
    owner.userId,
    envelopeId,
    first.signerId,
    { senderEmail: owner.email },
    { database },
  );
  const token = decodeURIComponent(session.signingPath.slice("/sign/".length));
  const storage = memoryStorage();

  await consent(token);

  const uploaded = await upload(token, attachment, PDF_BYTES, storage.service);
  const email = recordingEmailService();
  const result = await correctSentEnvelopeSigner(
    owner.userId,
    envelopeId,
    first.signerId,
    { email: "corrected@example.test", name: "Corrected Person" },
    {
      senderEmail: owner.email,
      senderName: "Sam Sender",
    },
    { database, emailService: email.service },
  );

  assert.equal(result.invitationSent, false);
  assert.equal(email.sent.length, 0);
  await assert.rejects(consent(token), SigningAccessError);

  const signer = await database.query<{
    in_person_host_email: string | null;
    signing_token_hash: string | null;
  }>(
    `select in_person_host_email, signing_token_hash from signers where id = $1`,
    [first.signerId],
  );

  assert.equal(signer.rows[0]!.in_person_host_email, null);
  assert.ok(signer.rows[0]!.signing_token_hash);

  const uploads = await database.query(
    `select 1 from signer_attachment_uploads where id = $1`,
    [uploaded.id],
  );
  const queued = await database.query<{ storage_key: string }>(
    `select storage_key from pending_file_deletions where envelope_id = $1`,
    [envelopeId],
  );

  assert.equal(uploads.rowCount, 0);
  assert.equal(queued.rowCount, 1);
  assert.match(queued.rows[0]!.storage_key, /\/attachments\//);
});
