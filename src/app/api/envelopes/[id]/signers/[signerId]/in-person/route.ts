import { NextResponse } from "next/server";

import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import { getDb } from "@/lib/db/connection";
import { EnvelopeMutationError } from "@/lib/envelopes";
import { startInPersonSigning } from "@/lib/in-person-signing";
import { logRouteError } from "@/lib/security/logging";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";

type InPersonSigningRouteContext = {
  params: Promise<{
    id: string;
    signerId: string;
  }>;
};

const noStore = { "cache-control": "private, no-store" };

// Signly: the sender opens an in-person signing session for a signer whose
// turn it is, to hand their device to that signer. Answers with the signing
// page to open.
export async function POST(
  request: Request,
  context: InPersonSigningRouteContext,
) {
  const sessionResult = await requireVerifiedSenderSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  const session = sessionResult;
  const { id, signerId } = await context.params;
  const rateLimitResponse = await applyRateLimit({
    category: "in_person_signing_start",
    key: buildRateLimitKey(["in-person-signing", session.user.id, id]),
    limit: 30,
    request,
    userId: session.user.id,
    windowMs: 60 * 60 * 1000,
  });

  if (rateLimitResponse) {
    rateLimitResponse.headers.set("cache-control", "private, no-store");
    return rateLimitResponse;
  }

  try {
    const result = await startInPersonSigning(
      session.user.id,
      id,
      signerId,
      { senderEmail: session.user.email },
      { database: getDb() },
    );

    return NextResponse.json(result, { headers: noStore, status: 200 });
  } catch (error) {
    if (error instanceof EnvelopeMutationError) {
      return NextResponse.json(
        { error: error.message },
        { headers: noStore, status: error.statusCode },
      );
    }

    logRouteError(error, {
      category: "in_person_signing_start_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while starting in-person signing.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "Unable to start signing in person." },
      { headers: noStore, status: 500 },
    );
  }
}
