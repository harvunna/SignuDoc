import {
  type DbExecutor,
  type DbPool,
  getDb,
  queryOne,
  withTransaction,
} from "./db/connection.ts";
import { EnvelopeMutationError } from "./envelopes.ts";
import { issueSigningLink } from "./services/signing-links.ts";

// GCM eSign: in-person signing. A sender marks a signer "in person" before
// sending; that signer is never emailed a link. When it is their turn the
// sender opens a session on their own device and hands it to the signer,
// who signs on the ordinary signing page, with every check it makes
// (access code, emailed code, consent). The signed audit event and the
// certificate say the signature was made in person and who hosted it.

/**
 * How long a link opened for an in-person session lasts: long enough to
 * read and sign, short enough that a page left open on the sender's device
 * does not stay signable. Never past the envelope's own deadline.
 */
export const IN_PERSON_SESSION_SECONDS = 2 * 60 * 60;

export type StartInPersonSigningContext = {
  senderEmail: string;
};

/**
 * Opens an in-person signing session for a signer whose turn it is, and
 * returns the signing page to open on this device. Each session replaces
 * the signer's link, so a page opened before stops working.
 */
export async function startInPersonSigning(
  userId: string,
  envelopeId: string,
  signerId: string,
  context: StartInPersonSigningContext,
  {
    database = getDb(),
    nowUnixTimestamp = Math.floor(Date.now() / 1000),
  }: { database?: DbPool; nowUnixTimestamp?: number } = {},
): Promise<{ signingPath: string; expiresAt: number }> {
  return withTransaction(async (tx: DbExecutor) => {
    // Per-user: only the envelope's own sender hosts a session, never a
    // teammate or an administrator who can only view it.
    const envelope = await queryOne<{
      delivery: string;
      expiresAt: number | null;
      status: string;
    }>(
      tx,
      `
        SELECT delivery, expires_at AS "expiresAt", status
        FROM envelopes
        WHERE id = $1 AND user_id = $2
        FOR NO KEY UPDATE
      `,
      [envelopeId, userId],
    );

    if (!envelope) {
      throw new EnvelopeMutationError("Envelope not found.", 404);
    }

    if (envelope.status !== "sent") {
      throw new EnvelopeMutationError(
        "Only an envelope that is out for signature can be signed in person.",
        409,
      );
    }

    if (envelope.delivery === "embedded") {
      throw new EnvelopeMutationError(
        "This envelope is signed in another app.",
        409,
      );
    }

    if (
      typeof envelope.expiresAt === "number" &&
      envelope.expiresAt <= nowUnixTimestamp
    ) {
      throw new EnvelopeMutationError(
        "This envelope's deadline has passed.",
        409,
      );
    }

    const signer = await queryOne<{
      inPerson: boolean;
      role: string;
      status: string;
    }>(
      tx,
      `
        SELECT in_person AS "inPerson", role, status
        FROM signers
        WHERE id = $1 AND envelope_id = $2
        FOR NO KEY UPDATE
      `,
      [signerId, envelopeId],
    );

    if (!signer || (signer.role !== "signer" && signer.role !== "approver")) {
      throw new EnvelopeMutationError("Envelope not found.", 404);
    }

    if (!signer.inPerson) {
      throw new EnvelopeMutationError(
        "This person signs from the link emailed to them, not in person.",
        409,
      );
    }

    if (signer.status === "signed" || signer.status === "declined") {
      throw new EnvelopeMutationError("This person has already finished.", 409);
    }

    if (signer.status !== "notified") {
      throw new EnvelopeMutationError(
        "It is not this person's turn to sign yet.",
        409,
      );
    }

    const expiresAt =
      typeof envelope.expiresAt === "number"
        ? Math.min(
            envelope.expiresAt,
            nowUnixTimestamp + IN_PERSON_SESSION_SECONDS,
          )
        : nowUnixTimestamp + IN_PERSON_SESSION_SECONDS;
    const link = await issueSigningLink({
      expiresInSeconds: expiresAt - nowUnixTimestamp,
      issuedAt: nowUnixTimestamp,
    });

    await tx.query(
      `
        UPDATE signers
        SET
          signing_token_hash = $1,
          signing_token_expires_at = $2,
          in_person_host_email = $3,
          in_person_hosted_at = $4,
          updated_at = $4
        WHERE id = $5 AND envelope_id = $6
      `,
      [
        link.tokenHash,
        expiresAt,
        context.senderEmail,
        nowUnixTimestamp,
        signerId,
        envelopeId,
      ],
    );

    return {
      expiresAt,
      signingPath: `/sign/${encodeURIComponent(link.token)}`,
    };
  }, database);
}
