import { NextResponse } from "next/server";

import { readBodyWithin } from "@/lib/api/body";
import {
  authenticateOAuthClient,
  issueOAuthToken,
  resolveTokenScope,
} from "@/lib/oauth";
import { logRouteError, logSecurityEvent } from "@/lib/security/logging";
import { consumeRateLimit, peekRateLimit } from "@/lib/security/rate-limit";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";

// The OAuth 2.0 token endpoint (RFC 6749 4.4): the client credentials grant.
// A client sends its id and secret and gets an access token for /api/v1.
// Answers follow RFC 6749 5: JSON with "error" and "error_description", and
// never cached. See docs/api.md.

const MAX_BODY_BYTES = 8 * 1024;
const FAILED_ATTEMPT_LIMIT = 30;
const FAILED_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const TOKEN_LIMIT = 120;
const TOKEN_WINDOW_MS = 10 * 60 * 1000;

const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" };

function oauthError(
  status: number,
  error: string,
  description: string,
  headers: Record<string, string> = {},
) {
  return NextResponse.json(
    { error, error_description: description },
    { headers: { ...NO_STORE, ...headers }, status },
  );
}

/** The id and secret from HTTP Basic (RFC 6749 2.3.1), or null. */
function readBasicCredentials(headers: Headers) {
  const match = /^Basic\s+(\S+)\s*$/i.exec(headers.get("authorization") ?? "");

  if (!match?.[1]) {
    return null;
  }

  try {
    const decoded = Buffer.from(match[1], "base64").toString("utf8");
    const colon = decoded.indexOf(":");

    if (colon < 0) {
      return null;
    }

    // Both parts are form-urlencoded before they are joined.
    return {
      id: decodeURIComponent(decoded.slice(0, colon).replace(/\+/g, " ")),
      secret: decodeURIComponent(decoded.slice(colon + 1).replace(/\+/g, " ")),
    };
  } catch {
    return null;
  }
}

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
  const ipAddress = getClientIpAddress(request.headers);
  const failureKey = `oauth-failures:${ipAddress ?? "unknown"}`;
  const failures = await peekRateLimit({
    key: failureKey,
    limit: FAILED_ATTEMPT_LIMIT,
  });

  if (!failures.allowed) {
    return oauthError(
      429,
      "invalid_request",
      "Too many failed attempts. Try again later.",
      { "retry-after": String(failures.retryAfterSeconds) },
    );
  }

  const contentType = request.headers.get("content-type") ?? "";

  if (!/^application\/x-www-form-urlencoded\b/i.test(contentType)) {
    return oauthError(
      400,
      "invalid_request",
      "Send the request as application/x-www-form-urlencoded.",
    );
  }

  const bytes = await readBodyWithin(request, MAX_BODY_BYTES);

  if (!bytes) {
    return oauthError(400, "invalid_request", "The request is too large.");
  }

  const form = new URLSearchParams(new TextDecoder().decode(bytes));
  const basic = readBasicCredentials(request.headers);
  const bodyId = form.get("client_id");
  const bodySecret = form.get("client_secret");

  if (basic && (bodyId || bodySecret)) {
    return oauthError(
      400,
      "invalid_request",
      "Send the client credentials one way only: HTTP Basic or the form body.",
    );
  }

  if (form.get("grant_type") !== "client_credentials") {
    return oauthError(
      400,
      "unsupported_grant_type",
      "Only grant_type=client_credentials is supported.",
    );
  }

  const clientId = basic?.id ?? bodyId;
  const clientSecret = basic?.secret ?? bodySecret;
  const challenge: Record<string, string> = basic
    ? { "www-authenticate": 'Basic realm="oauth"' }
    : {};

  if (!clientId || !clientSecret) {
    return oauthError(
      401,
      "invalid_client",
      "Send client_id and client_secret, or HTTP Basic credentials.",
      challenge,
    );
  }

  const client = await authenticateOAuthClient(clientId, clientSecret);

  if (!client) {
    const counted = await consumeRateLimit({
      key: failureKey,
      limit: FAILED_ATTEMPT_LIMIT,
      windowMs: FAILED_ATTEMPT_WINDOW_MS,
    });

    if (counted.allowed) {
      logSecurityEvent("warn", {
        category: "oauth_client_rejected",
        ipAddress,
        message: "Refused an OAuth token request with bad client credentials.",
        path: getRequestPathname(request),
      });
    }

    return oauthError(
      counted.allowed ? 401 : 429,
      "invalid_client",
      "The client id or secret is not valid.",
      counted.allowed
        ? challenge
        : { "retry-after": String(counted.retryAfterSeconds) },
    );
  }

  const issued = await consumeRateLimit({
    key: `oauth-token:${client.id}`,
    limit: TOKEN_LIMIT,
    windowMs: TOKEN_WINDOW_MS,
  });

  if (!issued.allowed) {
    return oauthError(
      429,
      "invalid_request",
      "This client has asked for too many tokens. Reuse the one you have until it expires.",
      { "retry-after": String(issued.retryAfterSeconds) },
    );
  }

  const scope = resolveTokenScope(form.get("scope"), client.scope);

  if (!scope) {
    return oauthError(
      400,
      "invalid_scope",
      "Scope must be read or write, and no more than the client has.",
    );
  }

  const token = await issueOAuthToken(client, scope);

  return NextResponse.json(
    {
      access_token: token.accessToken,
      expires_in: token.expiresIn,
      scope: token.scope,
      token_type: "Bearer",
    },
    { headers: NO_STORE },
  );
}
