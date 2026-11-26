import { NextResponse } from "next/server";

import {
  exchangeAuthorizationCode,
  refreshOAuthToken,
} from "@/lib/oauth-authorization";
import {
  authenticateClientRequest,
  OAUTH_NO_STORE,
  oauthError,
  readOAuthForm,
} from "@/lib/oauth-http";
import { issueOAuthToken, resolveTokenScope } from "@/lib/oauth";
import { logRouteError } from "@/lib/security/logging";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";

// The OAuth 2.0 token endpoint (RFC 6749 3.2). Three grants:
// client_credentials (4.4), for an app acting as the account that made it;
// authorization_code (4.1.3, with PKCE), for an app acting as a person who
// allowed it; and refresh_token (6), to renew that without asking again.
// Answers follow RFC 6749 5: JSON with "error" and "error_description", and
// never cached. See docs/api.md.

const GRANTS = ["authorization_code", "client_credentials", "refresh_token"];
const TOKEN_WINDOW_MS = 10 * 60 * 1000;
// An app acting for many people asks for far more than one acting as its
// owner, and each of those requests needs a code or a refresh token.
const CREDENTIALS_LIMIT = 120;
const PEOPLE_LIMIT = 1200;

export async function POST(request: Request) {
  try {
    return await issue(request);
  } catch (error) {
    logRouteError(error, {
      category: "oauth_token_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while issuing an OAuth access token.",
      path: getRequestPathname(request),
    });

    return oauthError(
      500,
      "server_error",
      "Something went wrong on the install. Try again later.",
    );
  }
}

async function issue(request: Request) {
  const form = await readOAuthForm(request);

  if (form instanceof Response) {
    return form;
  }

  const grantType = form.get("grant_type");

  if (!grantType || !GRANTS.includes(grantType)) {
    return oauthError(
      400,
      "unsupported_grant_type",
      "grant_type must be client_credentials, authorization_code or refresh_token.",
    );
  }

  const authenticated = await authenticateClientRequest(request, form);

  if ("response" in authenticated) {
    return authenticated.response;
  }

  const { client } = authenticated;

  if (grantType === "client_credentials" && client.isPublic) {
    return oauthError(
      400,
      "unauthorized_client",
      "A public client has no secret, so it cannot use client_credentials.",
    );
  }

  const allowance = await consumeRateLimit({
    key: `oauth-token:${grantType}:${client.id}`,
    limit:
      grantType === "client_credentials" ? CREDENTIALS_LIMIT : PEOPLE_LIMIT,
    windowMs: TOKEN_WINDOW_MS,
  });

  if (!allowance.allowed) {
    return oauthError(
      429,
      "invalid_request",
      "This client has asked for too many tokens. Reuse the one you have until it expires.",
      { "retry-after": String(allowance.retryAfterSeconds) },
    );
  }

  if (grantType === "client_credentials") {
    const scope = resolveTokenScope(form.get("scope"), client.scope);

    if (!scope) {
      return oauthError(
        400,
        "invalid_scope",
        "Scope must be read or write, and no more than the client has.",
      );
    }

    return tokenResponse(await issueOAuthToken(client, scope));
  }

  if (grantType === "authorization_code") {
    const code = form.get("code");
    const redirectUri = form.get("redirect_uri");
    const codeVerifier = form.get("code_verifier");

    if (!code || !redirectUri || !codeVerifier) {
      return oauthError(
        400,
        "invalid_request",
        "code, redirect_uri and code_verifier are required.",
      );
    }

    const result = await exchangeAuthorizationCode(client, {
      code,
      codeVerifier,
      redirectUri,
    });

    return result.ok
      ? tokenResponse(result.tokens)
      : oauthError(400, result.error, result.description);
  }

  const refreshToken = form.get("refresh_token");

  if (!refreshToken) {
    return oauthError(400, "invalid_request", "refresh_token is required.");
  }

  const result = await refreshOAuthToken(
    client,
    refreshToken,
    form.get("scope"),
  );

  return result.ok
    ? tokenResponse(result.tokens)
    : oauthError(400, result.error, result.description);
}

function tokenResponse(tokens: {
  accessToken: string;
  expiresIn: number;
  refreshToken?: string;
  scope: string;
}) {
  return NextResponse.json(
    {
      access_token: tokens.accessToken,
      expires_in: tokens.expiresIn,
      ...(tokens.refreshToken ? { refresh_token: tokens.refreshToken } : {}),
      scope: tokens.scope,
      token_type: "Bearer",
    },
    { headers: OAUTH_NO_STORE },
  );
}
