import { NextResponse } from "next/server";

import { revokeOAuthTokenForClient } from "@/lib/oauth-authorization";
import {
  authenticateClientRequest,
  OAUTH_NO_STORE,
  oauthError,
  readOAuthForm,
} from "@/lib/oauth-http";
import { logRouteError } from "@/lib/security/logging";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";

// Token revocation (RFC 7009): an app gives back a token it no longer needs,
// for example when someone signs out of it. A refresh token ends the whole
// sign-in it belongs to. A token that is unknown, or another client's, is
// ignored, and the answer is 200 either way.

export async function POST(request: Request) {
  try {
    const form = await readOAuthForm(request);

    if (form instanceof Response) {
      return form;
    }

    const authenticated = await authenticateClientRequest(request, form);

    if ("response" in authenticated) {
      return authenticated.response;
    }

    const token = form.get("token");

    if (!token) {
      return oauthError(400, "invalid_request", "token is required.");
    }

    await revokeOAuthTokenForClient(authenticated.client, token);

    return new NextResponse(null, { headers: OAUTH_NO_STORE, status: 200 });
  } catch (error) {
    logRouteError(error, {
      category: "oauth_revoke_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while revoking an OAuth token.",
      path: getRequestPathname(request),
    });

    return oauthError(
      500,
      "server_error",
      "Something went wrong on the install. Try again later.",
    );
  }
}
