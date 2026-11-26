import { z } from "zod";

import { getDb, type DbExecutor, type DbPool } from "../db/connection.ts";
import {
  createDraftEnvelope,
  deleteDraftEnvelope,
  EnvelopeMutationError,
  replaceDraftEnvelopeFields,
  replaceDraftEnvelopeSigners,
  sendDraftEnvelope,
} from "../envelopes.ts";
import {
  emailSchema,
  envelopeTitleSchema,
  nameSchema,
} from "../schemas/common.ts";
import {
  deadlineDaysSchema,
  reminderIntervalDaysSchema,
} from "../schemas/envelope.ts";
import { fieldTypeSchema } from "../schemas/field.ts";
import { listEnvelopeDocuments } from "../envelope-documents.ts";
import {
  placeFieldsByText,
  TextPlacementError,
  usesTextPlacement,
} from "./text-placement.ts";
import type { SourcePdfInput } from "../services/document-combine.ts";
import {
  MAX_COPY_RECIPIENTS_PER_ENVELOPE,
  MAX_DOCUMENTS_PER_ENVELOPE,
  MAX_SIGNERS_CEILING,
  signatureMeanings,
} from "../types/domain.ts";

// Envelopes as the public API sees them: one shape, ApiEnvelope, returned by
// every endpoint (and, later, carried by webhooks), and the one-call create.
// Everything that changes an envelope goes through the same functions the
// web app uses, so the same rules apply.

export const MAX_API_METADATA_BYTES = 2048;
export const MAX_API_FIELDS = 500;

export {
  apiListQuerySchema,
  decodeCursor,
  encodeCursor,
  getApiEnvelope,
  listApiEnvelopeEvents,
  listApiEnvelopes,
  toApiEnvelope,
  type ApiEnvelope,
  type ApiSigner,
} from "./envelope-view.ts";
import { getApiEnvelope, type ApiEnvelope } from "./envelope-view.ts";

const refSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(
    /^[A-Za-z0-9._:-]+$/,
    "Use letters, digits, '.', '_', ':' or '-' in a ref.",
  );

const metadataSchema = z
  .record(z.string(), z.unknown())
  .refine(
    (value) =>
      Buffer.byteLength(JSON.stringify(value), "utf8") <=
      MAX_API_METADATA_BYTES,
    {
      message: `Metadata must be at most ${String(MAX_API_METADATA_BYTES)} bytes of JSON.`,
    },
  );

export const apiSendOptionsSchema = z.object({
  delivery: z.enum(["email", "embedded"]).optional(),
  expiresInDays: deadlineDaysSchema.optional(),
  permittedUseConfirmed: z.literal(true, {
    message:
      "Set permittedUseConfirmed to true to confirm the envelope is an ordinary business agreement (see /electronic-signatures on your install).",
  }),
  reminderIntervalDays: reminderIntervalDaysSchema.optional(),
  signatureLevel: z.enum(["simple", "advanced", "qualified"]).optional(),
});

const apiSignerSchema = z.object({
  accessCode: z.string().trim().min(4).max(64).optional(),
  email: emailSchema,
  // Signly: signs on the sender's device; no invitation is emailed.
  inPerson: z.boolean().optional(),
  name: nameSchema,
  ref: refSchema,
  requireEmailCode: z.boolean().optional(),
  signatureMeaning: z.enum(signatureMeanings).optional(),
  // The step of the signing order, as in the web app: signers who share a
  // step sign at the same time. Given for every signer or for none; left
  // out, they sign one after the other in the order of the list.
  step: z.number().int().positive().max(MAX_SIGNERS_CEILING).optional(),
});

// Signly: where a field goes by the words next to it, for a document with
// no coordinates to give. See src/lib/api/text-tags.ts.
const apiAnchorSchema = z.object({
  occurrence: z.number().int().positive().max(100).optional(),
  offsetX: z.number().finite().min(-1).max(1).optional(),
  offsetY: z.number().finite().min(-1).max(1).optional(),
  position: z.enum(["right", "below", "over"]).optional(),
  text: z.string().trim().min(1).max(200),
});

const apiFieldSchema = z
  .object({
    /** Signly: find the place by the text next to it instead of x and y. */
    anchor: apiAnchorSchema.optional(),
    /**
     * Signly: which document (1-based, in upload order) `page` counts in.
     * Left out, `page` counts across all the documents together.
     */
    document: z
      .number()
      .int()
      .positive()
      .max(MAX_DOCUMENTS_PER_ENVELOPE)
      .optional(),
    groupId: z.string().trim().min(1).max(64).optional(),
    height: z.number().finite().gt(0).max(1).optional(),
    label: z.string().trim().max(120).optional(),
    options: z.array(z.string()).optional(),
    page: z.number().int().positive().optional(),
    required: z.boolean().optional(),
    signer: refSchema,
    type: fieldTypeSchema,
    width: z.number().finite().gt(0).max(1).optional(),
    x: z.number().finite().min(0).max(1).optional(),
    y: z.number().finite().min(0).max(1).optional(),
  })
  .superRefine((field, ctx) => {
    if (field.anchor) {
      return;
    }

    for (const key of ["page", "x", "y", "width", "height"] as const) {
      if (field[key] === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Required, unless the field has an anchor.`,
          path: [key],
        });
      }
    }
  });

export const apiCreateEnvelopeSchema = z
  .object({
    copyRecipients: z
      .array(z.object({ email: emailSchema, name: nameSchema }))
      .max(MAX_COPY_RECIPIENTS_PER_ENVELOPE)
      .optional(),
    // Signly: may be empty when textTags is true and the documents carry
    // [[type:signer]] tags.
    fields: z.array(apiFieldSchema).max(MAX_API_FIELDS),
    metadata: metadataSchema.optional(),
    send: apiSendOptionsSchema.optional(),
    // The install's own limit, MAX_SIGNERS_PER_ENVELOPE, is checked when
    // the signers are saved, as in the web app.
    signers: z.array(apiSignerSchema).min(1).max(MAX_SIGNERS_CEILING),
    textTags: z.boolean().optional(),
    title: envelopeTitleSchema,
  })
  .superRefine((value, ctx) => {
    if (value.fields.length === 0 && !value.textTags) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "List at least one field, or set textTags to true.",
        path: ["fields"],
      });
    }

    const refs = new Set<string>();

    for (const [index, signer] of value.signers.entries()) {
      if (refs.has(signer.ref)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Each signer needs its own ref.",
          path: ["signers", index, "ref"],
        });
      }

      refs.add(signer.ref);
    }

    for (const [index, field] of value.fields.entries()) {
      if (!refs.has(field.signer)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `No signer has the ref "${field.signer}".`,
          path: ["fields", index, "signer"],
        });
      }
    }
  });

/** A field with its place settled, by coordinates or from text. */
type ResolvedField = {
  document?: number;
  groupId?: string;
  height: number;
  label?: string;
  options?: string[];
  page: number;
  required?: boolean;
  signer: string;
  type: z.infer<typeof fieldTypeSchema>;
  width: number;
  x: number;
  y: number;
};

export type ApiCreateEnvelopeInput = z.infer<typeof apiCreateEnvelopeSchema>;
export type ApiSendOptions = z.infer<typeof apiSendOptionsSchema>;

export type ApiActor = {
  apiKeyId: string;
  email: string;
  ipAddress: string | null;
  /**
   * Whether the key's owner is an administrator. Signly lets anyone have a
   * key, so routes that reach the whole install check this.
   */
  isAdmin?: boolean;
  name: string;
  userAgent: string | null;
  userId: string;
};

/** The first message of a zod error, with where it was. */
export function describeZodError(error: z.ZodError): string {
  const issue = error.issues[0];

  if (!issue) {
    return "The request is not valid.";
  }

  const where = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";

  return `${where}${issue.message}`;
}

export async function sendEnvelopeForApi(
  actor: ApiActor,
  envelopeId: string,
  options: ApiSendOptions,
  database: DbPool = getDb(),
) {
  await sendDraftEnvelope(
    actor.userId,
    envelopeId,
    {
      apiKeyId: actor.apiKeyId,
      delivery: options.delivery,
      expiresInDays: options.expiresInDays,
      ipAddress: actor.ipAddress,
      reminderIntervalDays: options.reminderIntervalDays,
      senderEmail: actor.email,
      senderName: actor.name.trim() ? actor.name : actor.email,
      signatureLevel: options.signatureLevel,
      userAgent: actor.userAgent,
    },
    { database },
  );
}

/**
 * Creates a draft with its signers, copy recipients and fields, and sends it
 * if asked. Either all of it happens or none of it does: a draft that cannot
 * be completed (a field off its page, a send the install refuses) is deleted
 * again before the error is returned.
 */
export async function createEnvelopeForApi(
  actor: ApiActor,
  input: ApiCreateEnvelopeInput,
  /** Signly: one PDF, or several to be joined in this order. */
  sourcePdf: SourcePdfInput | readonly SourcePdfInput[],
  database: DbPool = getDb(),
  options: {
    /** Called once the envelope is made, and sent if asked, for good. */
    onCreated?: (envelopeId: string) => Promise<void>;
  } = {},
): Promise<ApiEnvelope> {
  // Signly: tags and anchors become ordinary fields first, and the tags are
  // covered in the PDFs that are kept.
  let sourcePdfs = sourcePdf;
  let requestedFields: ReadonlyArray<ResolvedField> =
    input.fields as ResolvedField[];

  if (usesTextPlacement(input)) {
    const list = Array.isArray(sourcePdf) ? sourcePdf : [sourcePdf];

    try {
      const placed = await placeFieldsByText(
        input,
        list.map((pdf) => ({ body: pdf.body, filename: pdf.filename })),
        MAX_API_FIELDS,
      );

      requestedFields = placed.fields;
      sourcePdfs = list.map((pdf, index) => ({
        ...pdf,
        body: placed.pdfs[index]!.body,
      }));
    } catch (error) {
      if (error instanceof TextPlacementError) {
        throw new EnvelopeMutationError(error.message, 400);
      }

      throw error;
    }
  }

  const draft = await createDraftEnvelope(
    actor.userId,
    { sourcePdf: sourcePdfs, title: input.title },
    { database },
  );
  const envelopeId = draft.envelope.id;
  const documents = listEnvelopeDocuments(draft.envelope);

  try {
    // Every field's page in the joined PDF. A field that names its document
    // counts its page within that document.
    const pages = requestedFields.map((field, index) => {
      if (field.document === undefined) {
        if (field.page > draft.envelope.pageCount) {
          throw new EnvelopeMutationError(
            `fields.${String(index)}.page: the document has ${String(draft.envelope.pageCount)} page(s).`,
            400,
          );
        }

        return field.page;
      }

      const document = documents[field.document - 1];

      if (!document) {
        throw new EnvelopeMutationError(
          `fields.${String(index)}.document: the envelope has ${String(documents.length)} document(s).`,
          400,
        );
      }

      if (field.page > document.pageCount) {
        throw new EnvelopeMutationError(
          `fields.${String(index)}.page: document ${String(field.document)} has ${String(document.pageCount)} page(s).`,
          400,
        );
      }

      return document.firstPage + field.page - 1;
    });

    const signers = await replaceDraftEnvelopeSigners(
      actor.userId,
      envelopeId,
      {
        copyRecipients: input.copyRecipients ?? [],
        signers: input.signers.map((signer, index) => ({
          accessCode: signer.accessCode,
          email: signer.email,
          inPerson: signer.inPerson,
          name: signer.name,
          requireEmailCode: signer.requireEmailCode,
          signatureMeaning: signer.signatureMeaning,
          signingStep: signer.step,
          signOrder: index + 1,
        })),
      },
      database,
    );
    const idByEmail = new Map(
      signers.signers.map((signer) => [signer.email.toLowerCase(), signer.id]),
    );
    const idByRef = new Map<string, string>();

    for (const signer of input.signers) {
      const id = idByEmail.get(signer.email.toLowerCase());

      if (!id) {
        throw new Error("A signer that was just saved could not be found.");
      }

      idByRef.set(signer.ref, id);
      await database.query(
        `UPDATE signers SET api_ref = $1 WHERE id = $2 AND envelope_id = $3`,
        [signer.ref, id, envelopeId],
      );
    }

    await replaceDraftEnvelopeFields(
      actor.userId,
      envelopeId,
      {
        fields: requestedFields.map((field, index) => ({
          groupId: field.groupId,
          height: field.height,
          label: field.label,
          options: field.options,
          page: pages[index]!,
          required: field.required ?? true,
          signerId: idByRef.get(field.signer),
          type: field.type,
          width: field.width,
          x: field.x,
          y: field.y,
        })),
      },
      database,
    );
    await database.query(
      `UPDATE envelopes SET api_key_id = $1, api_metadata = $2 WHERE id = $3`,
      [actor.apiKeyId, input.metadata ?? null, envelopeId],
    );

    if (input.send) {
      await sendEnvelopeForApi(actor, envelopeId, input.send, database);
    }
  } catch (error) {
    await deleteDraftEnvelope(actor.userId, envelopeId, { database }).catch(
      (cleanupError: unknown) => {
        console.error(
          `Deleting the API draft ${envelopeId} after a failed create failed:`,
          cleanupError,
        );
      },
    );
    throw error;
  }

  await options.onCreated?.(envelopeId);

  const envelope = await getApiEnvelope(actor.userId, envelopeId, database);

  if (!envelope) {
    throw new Error(
      "An envelope that was just created could not be read back.",
    );
  }

  return envelope;
}

/** Sets what an envelope made from a template keeps for the API. */
export async function markEnvelopeAsApiMade(
  envelopeId: string,
  apiKeyId: string,
  metadata: Record<string, unknown> | null,
  database: DbExecutor = getDb(),
) {
  await database.query(
    `UPDATE envelopes SET api_key_id = $1, api_metadata = $2 WHERE id = $3`,
    [apiKeyId, metadata, envelopeId],
  );
}
