import { getEnv } from "@/lib/utils/env";

// OAuth 2.0 Authorization Server Metadata (RFC 8414), so an app or an OAuth
// library can find the endpoints from the install's address alone. Needs no
// key.
export function GET(request: Request) {
  const origin = getEnv(process.env).appUrl ?? new URL(request.url).origin;
  const at = (path: string) => new URL(path, origin).toString();

  return Response.json(
    {
      authorization_endpoint: at("/oauth/authorize"),
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: [
        "authorization_code",
        "client_credentials",
        "refresh_token",
      ],
      issuer: new URL(origin).origin,
      response_types_supported: ["code"],
      revocation_endpoint: at("/api/oauth/revoke"),
      scopes_supported: ["read", "write"],
      token_endpoint: at("/api/oauth/token"),
      token_endpoint_auth_methods_supported: [
        "client_secret_basic",
        "client_secret_post",
        "none",
      ],
    },
    { headers: { "cache-control": "public, max-age=3600" } },
  );
}
