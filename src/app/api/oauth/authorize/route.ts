import { NextResponse } from "next/server";

import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import {
  buildRedirect,
  createAuthorizationCode,
  parseAuthorizeRequest,
} from "@/lib/oauth-authorization";
import { logRouteError } from "@/lib/security/logging";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import {
  getClientIpAddress,
  getRequestPathname,
  getRequestUserAgent,
} from "@/lib/security/request";

const noStore = { "cache-control": "private, no-store" };

// The answer from the consent screen. It takes the signed-in person's
// session (a cookie, so another site cannot make this call for them) and
// checks the whole request again before handing the app a one-time code.
// The reply says where to send the browser, back to the app.

export async function POST(request: Request) {
  const sessionResult = await requireVerifiedSenderSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  const session = sessionResult;
  const rateLimitResponse = await applyRateLimit({
    category: "oauth_authorize",
    key: buildRateLimitKey(["oauth-authorize", session.user.id]),
    limit: 30,
    request,
    userId: session.user.id,
    windowMs: 10 * 60 * 1000,
  });

  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  const parsedBody: unknown = await request.json().catch(() => null);
  const body =
    typeof parsedBody === "object" &&
    parsedBody !== null &&
    !Array.isArray(parsedBody)
      ? (parsedBody as Record<string, unknown>)
      : {};
  const read = (name: string) => {
    const value = body[name];

    return typeof value === "string" ? value : null;
  };

  try {
    const parsed = await parseAuthorizeRequest(read);

    if (!parsed.ok && parsed.kind === "fatal") {
      return NextResponse.json(
        { error: parsed.message },
        { headers: noStore, status: 400 },
      );
    }

    if (!parsed.ok) {
      return NextResponse.json(
        {
          redirectTo: buildRedirect(parsed.redirectUri, {
            error: parsed.error,
            error_description: parsed.description,
            state: parsed.state,
          }),
        },
        { headers: noStore },
      );
    }

    const { request: authorize } = parsed;

    if (body.decision !== "allow") {
      return NextResponse.json(
        {
          redirectTo: buildRedirect(authorize.redirectUri, {
            error: "access_denied",
            error_description: "The person did not allow access.",
            state: authorize.state,
          }),
        },
        { headers: noStore },
      );
    }

    const code = await createAuthorizationCode(
      {
        email: session.user.email,
        ipAddress: getClientIpAddress(request.headers),
        userAgent: getRequestUserAgent(request.headers),
        userId: session.user.id,
      },
      authorize,
    );

    return NextResponse.json(
      {
        redirectTo: buildRedirect(authorize.redirectUri, {
          code,
          state: authorize.state,
        }),
      },
      { headers: noStore },
    );
  } catch (error) {
    logRouteError(error, {
      category: "oauth_authorize_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while answering an OAuth authorization.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "The request could not be answered." },
      { headers: noStore, status: 500 },
    );
  }
}
