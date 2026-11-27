import { NextResponse } from "next/server";

import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import { revokeOAuthGrant } from "@/lib/oauth-authorization";
import { logRouteError } from "@/lib/security/logging";
import {
  getClientIpAddress,
  getRequestPathname,
  getRequestUserAgent,
} from "@/lib/security/request";

const noStore = { "cache-control": "private, no-store" };

type GrantRouteContext = {
  params: Promise<{ id: string }>;
};

// Takes back what the signed-in person allowed one app: every token it
// holds for them stops working at once.
export async function DELETE(request: Request, context: GrantRouteContext) {
  const sessionResult = await requireVerifiedSenderSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  const session = sessionResult;
  const { id } = await context.params;

  try {
    const revoked = await revokeOAuthGrant(
      {
        email: session.user.email,
        ipAddress: getClientIpAddress(request.headers),
        userAgent: getRequestUserAgent(request.headers),
        userId: session.user.id,
      },
      id,
    );

    if (!revoked) {
      return NextResponse.json(
        { error: "That app no longer has access." },
        { headers: noStore, status: 404 },
      );
    }

    return NextResponse.json({ ok: true }, { headers: noStore });
  } catch (error) {
    logRouteError(error, {
      category: "oauth_grant_revoke_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while taking back an app's access.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "The access could not be taken back." },
      { headers: noStore, status: 500 },
    );
  }
}
