import { NextResponse } from "next/server";

import { getDb } from "@/lib/db/connection";
import {
  MAX_SIGNER_ATTACHMENT_BYTES,
  SignerAttachmentError,
  uploadSignerAttachmentForToken,
} from "@/lib/signer-attachments";
import {
  verificationRequiredResponse,
  verifiedMethodsForRequest,
} from "@/lib/signing-route";
import {
  SigningAccessError,
  SigningMutationError,
  SigningVerificationRequiredError,
} from "@/lib/signing";
import { logRouteError } from "@/lib/security/logging";
import {
  applyPublicLinkRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import { getClientIpAddress } from "@/lib/security/request";
import { readLimitedBody } from "@/lib/utils/limited-body";

type SigningAttachmentRouteContext = {
  params: Promise<{
    token: string;
  }>;
};

const noStore = { "cache-control": "private, no-store" };

function readFileName(request: Request): string | null {
  // Sent percent-encoded, since a header value cannot hold every name.
  const header = request.headers.get("x-file-name");

  if (!header) {
    return null;
  }

  try {
    return decodeURIComponent(header).slice(0, 1000);
  } catch {
    return null;
  }
}

// Signly: a signer uploads a file for one of their attachment fields
// (?fieldId=). The body is the file itself; what it is comes from its
// bytes, not from the type the browser claims.
export async function POST(
  request: Request,
  context: SigningAttachmentRouteContext,
) {
  const { token } = await context.params;
  const rateLimitResponse = await applyPublicLinkRateLimit({
    category: "signing_attachment",
    key: buildRateLimitKey([
      "signing-attachment",
      token,
      getClientIpAddress(request.headers) ?? "unknown",
    ]),
    limit: 30,
    request,
    windowMs: 10 * 60 * 1000,
  });

  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  const fieldId = new URL(request.url).searchParams.get("fieldId")?.trim();

  if (!fieldId) {
    return NextResponse.json(
      { error: "Say which field the file is for." },
      { headers: noStore, status: 400 },
    );
  }

  const body = await readLimitedBody(request, MAX_SIGNER_ATTACHMENT_BYTES);

  if (!body) {
    return NextResponse.json(
      {
        error: `The file is too large. Attach a file of up to ${String(MAX_SIGNER_ATTACHMENT_BYTES / (1024 * 1024))} MB.`,
      },
      { headers: noStore, status: 413 },
    );
  }

  try {
    const upload = await uploadSignerAttachmentForToken(
      token,
      fieldId,
      { body, fileName: readFileName(request) },
      {
        database: getDb(),
        verifiedMethods: verifiedMethodsForRequest(token, request),
      },
    );

    return NextResponse.json(upload, { headers: noStore, status: 201 });
  } catch (error) {
    if (error instanceof SigningVerificationRequiredError) {
      return verificationRequiredResponse(error);
    }

    if (error instanceof SigningAccessError) {
      return NextResponse.json(
        { error: error.message, state: error.state },
        { headers: noStore, status: error.statusCode },
      );
    }

    if (
      error instanceof SigningMutationError ||
      error instanceof SignerAttachmentError
    ) {
      return NextResponse.json(
        { error: error.message },
        { headers: noStore, status: error.statusCode },
      );
    }

    logRouteError(error, {
      category: "signing_attachment_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while storing a signer's attachment.",
      path: new URL(request.url).pathname,
    });

    return NextResponse.json(
      { error: "Unable to attach this file." },
      { headers: noStore, status: 500 },
    );
  }
}
