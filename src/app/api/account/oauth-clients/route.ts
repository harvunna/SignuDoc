import { NextResponse } from "next/server";

import { parseApiKeyScope } from "@/lib/api-keys";
import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import {
  createOAuthClient,
  listOAuthClientsForUser,
  OAuthClientError,
  parseOAuthClientName,
} from "@/lib/oauth";
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
import { getSettings } from "@/lib/settings";

const noStore = { "cache-control": "private, no-store" };

// The signed-in account's own OAuth clients for the public API. The client
// secret is in the response to the request that registers it, and nowhere
// else, ever.

export async function GET(request: Request) {
  const sessionResult = await requireVerifiedSenderSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  return NextResponse.json(
    { clients: await listOAuthClientsForUser(sessionResult.user.id) },
    { headers: noStore },
  );
}

export async function POST(request: Request) {
  const sessionResult = await requireVerifiedSenderSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  const session = sessionResult;
  const rateLimitResponse = await applyRateLimit({
    category: "oauth_client_create",
    key: buildRateLimitKey(["oauth-client-create", session.user.id]),
    limit: 10,
    request,
    userId: session.user.id,
    windowMs: 10 * 60 * 1000,
  });

  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  if ((await getSettings()).hosted) {
    return NextResponse.json(
      { error: "OAuth clients are for self-hosted installs." },
      { headers: noStore, status: 400 },
    );
  }

  const parsed: unknown = await request.json().catch(() => null);
  const body =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as { name?: unknown; scope?: unknown })
      : {};
  const name = parseOAuthClientName(body.name);
  const scope = parseApiKeyScope(body.scope);

  if (!name || !scope) {
    return NextResponse.json(
      {
        error:
          "Give the client a name of up to 80 characters and read or write access.",
      },
      { headers: noStore, status: 400 },
    );
  }

  try {
    const created = await createOAuthClient(
      {
        email: session.user.email,
        ipAddress: getClientIpAddress(request.headers),
        userAgent: getRequestUserAgent(request.headers),
        userId: session.user.id,
      },
      { name, scope },
    );

    return NextResponse.json(created, { headers: noStore, status: 201 });
  } catch (error) {
    if (error instanceof OAuthClientError) {
      return NextResponse.json(
        { error: error.message },
        { headers: noStore, status: error.statusCode },
      );
    }

    logRouteError(error, {
      category: "oauth_client_create_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while creating an OAuth client.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "The client could not be created." },
      { headers: noStore, status: 500 },
    );
  }
}
