import { NextResponse } from "next/server";

import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import { getDb } from "@/lib/db/connection";
import { resolveEnvelopeViewerAccess } from "@/lib/envelope-access";
import {
  createAttachmentDownloadResponse,
  getEnvelopeAttachmentFile,
} from "@/lib/signer-attachments";
import { logRouteError } from "@/lib/security/logging";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";
import { buildContentDisposition } from "@/lib/services/storage";
import { recordSystemAuditEvent } from "@/lib/services/system-audit";

type EnvelopeAttachmentRouteContext = {
  params: Promise<{
    fieldId: string;
    id: string;
  }>;
};

const noStore = { "cache-control": "private, no-store" };

// GCM eSign: a file a signer attached, for whoever may see the envelope (its
// sender, or once sent a teammate or an administrator, as for its other
// files).
export async function GET(
  request: Request,
  context: EnvelopeAttachmentRouteContext,
) {
  const sessionResult = await requireVerifiedSenderSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  const session = sessionResult;
  const { fieldId, id } = await context.params;

  try {
    const database = getDb();
    const access = await resolveEnvelopeViewerAccess(
      session.user.id,
      id,
      database,
    );
    const file = access
      ? await getEnvelopeAttachmentFile(id, fieldId, database)
      : null;

    if (!access || !file) {
      return NextResponse.json(
        { error: "Attachment not found." },
        { headers: noStore, status: 404 },
      );
    }

    if (!access.viewerIsOwner) {
      // As for the envelope's other files: someone else's attachment is
      // on record in the install's audit trail. No record, no file.
      await recordSystemAuditEvent({
        actorEmail: session.user.email,
        actorUserId: session.user.id,
        event: "envelope_file_downloaded",
        ipAddress: getClientIpAddress(request.headers),
        metadata: {
          envelopeId: id,
          fieldId,
          file: "attachment",
          ownerEmail: access.ownerEmail,
          ownerUserId: access.ownerUserId,
        },
        targetUserId: access.ownerUserId,
        userAgent: request.headers.get("user-agent"),
      });
    }

    return await createAttachmentDownloadResponse(file, undefined, (name) =>
      buildContentDisposition(name, "attachment"),
    );
  } catch (error) {
    logRouteError(error, {
      category: "envelope_attachment_download_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while downloading a signer's attachment.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "Unable to download this attachment." },
      { headers: noStore, status: 500 },
    );
  }
}
