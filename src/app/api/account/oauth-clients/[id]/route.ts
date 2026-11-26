import { NextResponse } from "next/server";

import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import { OAuthClientError, revokeOAuthClient } from "@/lib/oauth";
import { logRouteError } from "@/lib/security/logging";
import {
  getClientIpAddress,
  getRequestPathname,
  getRequestUserAgent,
} from "@/lib/security/request";

const noStore = { "cache-control": "private, no-store" };

type OAuthClientRouteContext = {
  params: Promise<{ id: string }>;
};

// Revokes one of the signed-in account's own OAuth clients and every token
// it was given. It stops working at once and cannot be turned back on.
export async function DELETE(
  request: Request,
  context: OAuthClientRouteContext,
) {
  const sessionResult = await requireVerifiedSenderSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  const session = sessionResult;
  const { id } = await context.params;

  try {
    const client = await revokeOAuthClient(
      {
        email: session.user.email,
        ipAddress: getClientIpAddress(request.headers),
        userAgent: getRequestUserAgent(request.headers),
        userId: session.user.id,
      },
      id,
    );

    return NextResponse.json({ client }, { headers: noStore });
  } catch (error) {
    if (error instanceof OAuthClientError) {
      return NextResponse.json(
        { error: error.message },
        { headers: noStore, status: error.statusCode },
      );
    }

    logRouteError(error, {
      category: "oauth_client_revoke_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while revoking an OAuth client.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "The client could not be revoked." },
      { headers: noStore, status: 500 },
    );
  }
}
