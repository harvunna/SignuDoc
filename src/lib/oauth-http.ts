import { NextResponse } from "next/server";

import { readBodyWithin } from "./api/body.ts";
import type { ApiKeyScope } from "./api-keys.ts";
import { authenticateOAuthClient, findOAuthClient } from "./oauth.ts";
import { logSecurityEvent } from "./security/logging.ts";
import { consumeRateLimit, peekRateLimit } from "./security/rate-limit.ts";
import { getClientIpAddress, getRequestPathname } from "./security/request.ts";

// What the OAuth endpoints under /api/oauth share: answers in the shape of
// RFC 6749 5.2, reading a form body, and checking who the client is.

export const OAUTH_NO_STORE = {
  "cache-control": "no-store",
  pragma: "no-cache",
};

const MAX_BODY_BYTES = 8 * 1024;
const FAILED_ATTEMPT_LIMIT = 30;
const FAILED_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;

export function oauthError(
  status: number,
  error: string,
  description: string,
  headers: Record<string, string> = {},
) {
  return NextResponse.json(
    { error, error_description: description },
    { headers: { ...OAUTH_NO_STORE, ...headers }, status },
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

export type RequestClient = {
  id: string;
  isPublic: boolean;
  scope: ApiKeyScope;
  userId: string;
};

/** Reads a form-encoded body of an OAuth request, or the answer to send. */
export async function readOAuthForm(
  request: Request,
): Promise<URLSearchParams | Response> {
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

  return new URLSearchParams(new TextDecoder().decode(bytes));
}

/**
 * The client making a request: a confidential one with its secret (HTTP
 * Basic or in the form), or a public one with only its id. Bad attempts
 * are counted per address, and past the limit get 429.
 */
export async function authenticateClientRequest(
  request: Request,
  form: URLSearchParams,
): Promise<{ client: RequestClient } | { response: Response }> {
  const ipAddress = getClientIpAddress(request.headers);
  const failureKey = `oauth-failures:${ipAddress ?? "unknown"}`;
  const failures = await peekRateLimit({
    key: failureKey,
    limit: FAILED_ATTEMPT_LIMIT,
  });

  if (!failures.allowed) {
    return {
      response: oauthError(
        429,
        "invalid_request",
        "Too many failed attempts. Try again later.",
        { "retry-after": String(failures.retryAfterSeconds) },
      ),
    };
  }

  const basic = readBasicCredentials(request.headers);
  const bodyId = form.get("client_id");
  const bodySecret = form.get("client_secret");

  if (basic && (bodyId || bodySecret)) {
    return {
      response: oauthError(
        400,
        "invalid_request",
        "Send the client credentials one way only: HTTP Basic or the form body.",
      ),
    };
  }

  const clientId = basic?.id ?? bodyId;
  const clientSecret = basic?.secret ?? bodySecret;
  const challenge: Record<string, string> = basic
    ? { "www-authenticate": 'Basic realm="oauth"' }
    : {};

  if (!clientId) {
    return {
      response: oauthError(
        401,
        "invalid_client",
        "Send client_id, with client_secret for a confidential client, or HTTP Basic credentials.",
        challenge,
      ),
    };
  }

  let client: RequestClient | null = null;

  if (clientSecret) {
    const confidential = await authenticateOAuthClient(clientId, clientSecret);

    client = confidential
      ? {
          id: confidential.id,
          isPublic: false,
          scope: confidential.scope,
          userId: confidential.userId,
        }
      : null;
  } else {
    // No secret: only a public client may do without one.
    const found = await findOAuthClient(clientId);

    client = found?.isPublic
      ? {
          id: found.id,
          isPublic: true,
          scope: found.scope,
          userId: found.userId,
        }
      : null;
  }

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
        message: "Refused an OAuth request with bad client credentials.",
        path: getRequestPathname(request),
      });
    }

    return {
      response: oauthError(
        counted.allowed ? 401 : 429,
        "invalid_client",
        "The client id or secret is not valid.",
        counted.allowed
          ? challenge
          : { "retry-after": String(counted.retryAfterSeconds) },
      ),
    };
  }

  return { client };
}
