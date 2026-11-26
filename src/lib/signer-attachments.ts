import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import {
  type DbExecutor,
  type DbPool,
  getDb,
  queryMany,
  queryOne,
  withTransaction,
} from "./db/connection.ts";
import { deletePendingFile, queueFileDeletions } from "./retention.ts";
import type { SignerCheckMethod } from "./signer-checks.ts";
import {
  resolveSignerAttachmentTarget,
  SigningMutationError,
} from "./signing.ts";
import { buildSignerAttachmentKey } from "./services/storage-keys.ts";
import {
  createStorageService,
  type StorageService,
} from "./services/storage.ts";

// GCM eSign: files a signer uploads while signing, for the "attachment" fields
// the sender placed for them (a copy of an ID, a certificate, a form).
//
// The file is uploaded on its own, before the signer finishes, because a
// signing submission is JSON and a file of a few megabytes does not belong
// in it. Each upload gets an id; finishing names, for each attachment
// field, the upload to keep. Uploads are private like every other stored
// file: only the envelope's sender (and those who may see the envelope)
// can download them, through the app.

/**
 * The largest file a signer can attach. Vercel refuses a request body over
 * 4.5 MB before the app sees it, so the limit stays under that.
 */
export const MAX_SIGNER_ATTACHMENT_BYTES = 4 * 1024 * 1024;

export const SIGNER_ATTACHMENT_CONTENT_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
] as const;

export type SignerAttachmentContentType =
  (typeof SIGNER_ATTACHMENT_CONTENT_TYPES)[number];

const EXTENSIONS: Record<SignerAttachmentContentType, "jpg" | "pdf" | "png"> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
};

const MAX_FILE_NAME_LENGTH = 200;

export class SignerAttachmentError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "SignerAttachmentError";
    this.statusCode = statusCode;
  }
}

/**
 * What the file is, from its first bytes rather than from the name or type
 * the browser claims, which the signer controls. Null for anything that is
 * not a PDF, a PNG or a JPEG.
 */
export function detectSignerAttachmentType(
  bytes: Uint8Array,
): SignerAttachmentContentType | null {
  const startsWith = (signature: readonly number[]) =>
    bytes.length >= signature.length &&
    signature.every((byte, index) => bytes[index] === byte);

  // "%PDF-"
  if (startsWith([0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return "application/pdf";
  }

  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }

  if (startsWith([0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }

  return null;
}

/**
 * The file's name as shown to the sender and printed on the certificate:
 * no folders, no control characters, not too long, and ending in the
 * extension of what the file really is.
 */
export function cleanSignerAttachmentFileName(
  rawName: string | null | undefined,
  contentType: SignerAttachmentContentType,
): string {
  const extension = EXTENSIONS[contentType];
  let name = (rawName ?? "").toWellFormed();

  // Browsers send the bare name, but nothing stops a client from sending
  // a path.
  name = path.posix.basename(name.replaceAll("\\", "/"));
  name = name.replace(/[\u0000-\u001f\u007f]+/g, "").trim();

  const lowerName = name.toLowerCase();
  const hasExtension =
    extension === "jpg"
      ? lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg")
      : lowerName.endsWith(`.${extension}`);

  if (!hasExtension) {
    name = name ? `${name}.${extension}` : "";
  }

  if (!name || name.startsWith(".")) {
    name = `attachment${name.startsWith(".") ? name : `.${extension}`}`;
  }

  if (name.length > MAX_FILE_NAME_LENGTH) {
    const suffix = name.slice(name.lastIndexOf("."));
    name = `${name.slice(0, MAX_FILE_NAME_LENGTH - suffix.length)}${suffix}`;
  }

  return name;
}

export type SignerAttachmentUpload = {
  contentType: SignerAttachmentContentType;
  createdAt: number;
  fieldId: string;
  fileName: string;
  id: string;
  sha256: string;
  signerId: string;
  sizeBytes: number;
  storageKey: string;
};

const UPLOAD_COLUMNS = `
  id,
  field_id AS "fieldId",
  signer_id AS "signerId",
  storage_key AS "storageKey",
  file_name AS "fileName",
  content_type AS "contentType",
  size_bytes AS "sizeBytes",
  sha256,
  created_at AS "createdAt"
`;

/**
 * Stores a file a signer uploads for one of their attachment fields, and
 * replaces the file they uploaded for it before, if any. The signer's row
 * is locked while the upload is recorded, the same lock finishing takes,
 * so a file is never replaced under a signature that is using it.
 */
export async function uploadSignerAttachmentForToken(
  token: string,
  fieldId: string,
  input: { body: Uint8Array; fileName: string | null },
  {
    database = getDb(),
    storageService = createStorageService(),
    verifiedMethods = [],
  }: {
    database?: DbPool;
    storageService?: StorageService;
    verifiedMethods?: readonly SignerCheckMethod[];
  } = {},
): Promise<
  Pick<
    SignerAttachmentUpload,
    "contentType" | "fileName" | "id" | "sha256" | "sizeBytes"
  >
> {
  const target = await resolveSignerAttachmentTarget(token, fieldId, {
    database,
    verifiedMethods,
  });

  if (input.body.byteLength === 0) {
    throw new SignerAttachmentError("The file is empty.");
  }

  if (input.body.byteLength > MAX_SIGNER_ATTACHMENT_BYTES) {
    throw new SignerAttachmentError(
      `The file is too large. Attach a file of up to ${String(MAX_SIGNER_ATTACHMENT_BYTES / (1024 * 1024))} MB.`,
      413,
    );
  }

  const contentType = detectSignerAttachmentType(input.body);

  if (!contentType) {
    throw new SignerAttachmentError("Attach a PDF, a PNG or a JPEG file.", 415);
  }

  const uploadId = randomUUID();
  const fileName = cleanSignerAttachmentFileName(input.fileName, contentType);
  const sha256 = createHash("sha256").update(input.body).digest("hex");
  const storageKey = buildSignerAttachmentKey({
    envelopeId: target.envelopeId,
    extension: EXTENSIONS[contentType],
    fieldId: target.fieldId,
    sourcePdfKey: target.sourcePdfKey,
    uploadId,
    userId: target.envelopeUserId,
  });
  const now = Math.floor(Date.now() / 1000);

  await storageService.putObject({
    body: input.body,
    contentType,
    key: storageKey,
  });

  let replacedKeys: string[];

  try {
    replacedKeys = await withTransaction(async (tx) => {
      const locked = await tx.query(
        `
          SELECT 1
          FROM signers
          WHERE id = $1
            AND envelope_id = $2
            AND status = 'notified'
            AND signing_token_hash = $3
          FOR NO KEY UPDATE
        `,
        [target.signerId, target.envelopeId, target.tokenHash],
      );

      if (locked.rowCount !== 1) {
        throw new SigningMutationError(
          "This signing link is no longer active.",
          409,
        );
      }

      const replaced = await tx.query<{ storageKey: string }>(
        `
          DELETE FROM signer_attachment_uploads
          WHERE signer_id = $1 AND field_id = $2
          RETURNING storage_key AS "storageKey"
        `,
        [target.signerId, target.fieldId],
      );
      const keys = replaced.rows.map((row) => row.storageKey);

      await queueFileDeletions(target.envelopeId, keys, now, tx);
      await tx.query(
        `
          INSERT INTO signer_attachment_uploads (
            id, envelope_id, signer_id, field_id, storage_key, file_name,
            content_type, size_bytes, sha256, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `,
        [
          uploadId,
          target.envelopeId,
          target.signerId,
          target.fieldId,
          storageKey,
          fileName,
          contentType,
          input.body.byteLength,
          sha256,
          now,
        ],
      );

      return keys;
    }, database);
  } catch (error) {
    await storageService.deleteObject(storageKey).catch(() => undefined);
    throw error;
  }

  // Queued above, so the daily cleanup deletes any that fail here.
  for (const key of replacedKeys) {
    await deletePendingFile(key, database, storageService);
  }

  return {
    contentType,
    fileName,
    id: uploadId,
    sha256,
    sizeBytes: input.body.byteLength,
  };
}

/** The files a signer has uploaded and not replaced, by upload id. */
export async function listSignerAttachmentUploads(
  envelopeId: string,
  signerId: string,
  database: DbExecutor = getDb(),
): Promise<Map<string, SignerAttachmentUpload>> {
  const rows = await queryMany<SignerAttachmentUpload>(
    database,
    `
      SELECT ${UPLOAD_COLUMNS}
      FROM signer_attachment_uploads
      WHERE envelope_id = $1 AND signer_id = $2
    `,
    [envelopeId, signerId],
  );

  return new Map(rows.map((row) => [row.id, row] as const));
}

/**
 * Inside a signature's transaction, once the signer's row is locked: the
 * uploads the signature uses must still be there. One replaced since the
 * submission was read would leave the field naming a deleted file.
 */
export async function assertSignerAttachmentUploadsKept(
  tx: DbExecutor,
  signerId: string,
  uploadIds: readonly string[],
): Promise<void> {
  if (uploadIds.length === 0) {
    return;
  }

  const kept = await tx.query(
    `
      SELECT 1 FROM signer_attachment_uploads
      WHERE signer_id = $1 AND id = ANY($2::text[])
    `,
    [signerId, [...uploadIds]],
  );

  if (kept.rowCount !== uploadIds.length) {
    throw new SigningMutationError(
      "An attached file was replaced while you were finishing. Check your attachments and finish again.",
      409,
    );
  }
}

/**
 * Deletes a signer's uploads other than the ones kept: once they have
 * signed, the files they replaced or did not use; when the sender corrects
 * who the signer is, all of them. Pass a transaction to delete with it;
 * the files are queued, and deleted at once only when `storageService` is
 * given (after the transaction, by the caller) or by the daily cleanup.
 */
export async function discardSignerAttachmentUploads(
  envelopeId: string,
  signerId: string,
  keepUploadIds: readonly string[],
  database: DbExecutor,
): Promise<string[]> {
  const removed = await database.query<{ storageKey: string }>(
    `
      DELETE FROM signer_attachment_uploads
      WHERE envelope_id = $1
        AND signer_id = $2
        AND NOT (id = ANY($3::text[]))
      RETURNING storage_key AS "storageKey"
    `,
    [envelopeId, signerId, [...keepUploadIds]],
  );
  const keys = removed.rows.map((row) => row.storageKey);

  await queueFileDeletions(
    envelopeId,
    keys,
    Math.floor(Date.now() / 1000),
    database,
  );

  return keys;
}

/** Deletes queued files now; a failure stays queued for the daily cleanup. */
export async function deleteDiscardedSignerAttachments(
  keys: readonly string[],
  database: DbExecutor,
  storageService: StorageService,
): Promise<void> {
  for (const key of keys) {
    await deletePendingFile(key, database, storageService);
  }
}

export type EnvelopeAttachment = {
  contentType: SignerAttachmentContentType;
  fieldId: string;
  fileName: string;
  label: string | null;
  page: number;
  sha256: string;
  signerEmail: string;
  signerId: string;
  signerName: string;
  sizeBytes: number;
  submittedAt: number;
};

/**
 * The files signers attached to an envelope, once they signed. Callers
 * check that the person asking may see the envelope.
 */
export async function listEnvelopeAttachments(
  envelopeId: string,
  database: DbExecutor = getDb(),
): Promise<EnvelopeAttachment[]> {
  return queryMany<EnvelopeAttachment>(
    database,
    `
      SELECT
        f.id AS "fieldId",
        f.label,
        f.page,
        f.submitted_at AS "submittedAt",
        s.id AS "signerId",
        s.name AS "signerName",
        s.email AS "signerEmail",
        u.file_name AS "fileName",
        u.content_type AS "contentType",
        u.size_bytes AS "sizeBytes",
        u.sha256
      FROM fields f
      JOIN signers s ON s.id = f.signer_id
      JOIN signer_attachment_uploads u
        ON u.field_id = f.id AND u.storage_key = f.image_key
      WHERE f.envelope_id = $1
        AND f.type = 'attachment'
        AND f.submitted_at IS NOT NULL
      ORDER BY s.sign_order ASC, f.page ASC, f.y ASC, f.x ASC, f.id ASC
    `,
    [envelopeId],
  );
}

/** One attached file, to download. Null when there is none. */
export async function getEnvelopeAttachmentFile(
  envelopeId: string,
  fieldId: string,
  database: DbExecutor = getDb(),
): Promise<{
  contentType: SignerAttachmentContentType;
  fileName: string;
  sizeBytes: number;
  storageKey: string;
} | null> {
  return queryOne(
    database,
    `
      SELECT
        u.storage_key AS "storageKey",
        u.file_name AS "fileName",
        u.content_type AS "contentType",
        u.size_bytes AS "sizeBytes"
      FROM fields f
      JOIN signer_attachment_uploads u
        ON u.field_id = f.id AND u.storage_key = f.image_key
      WHERE f.envelope_id = $1
        AND f.id = $2
        AND f.type = 'attachment'
        AND f.submitted_at IS NOT NULL
    `,
    [envelopeId, fieldId],
  );
}

/**
 * The attached file as a download response. Served as an attachment with
 * its own type and nosniff, so a file a signer made is never shown as a
 * page of this site.
 */
export async function createAttachmentDownloadResponse(
  file: NonNullable<Awaited<ReturnType<typeof getEnvelopeAttachmentFile>>>,
  storageService: StorageService = createStorageService(),
  buildContentDisposition: (name: string) => string,
): Promise<Response> {
  const object = await storageService.getObjectStream(file.storageKey);

  return new Response(object.stream, {
    headers: {
      "cache-control": "private, no-store",
      "content-disposition": buildContentDisposition(file.fileName),
      ...(object.contentLength !== undefined
        ? { "content-length": String(object.contentLength) }
        : {}),
      "content-security-policy": "sandbox",
      "content-type": file.contentType,
      "x-content-type-options": "nosniff",
    },
    status: 200,
  });
}
