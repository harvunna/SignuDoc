import { NextResponse } from "next/server";

import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import { listOAuthGrantsForUser } from "@/lib/oauth-authorization";

const noStore = { "cache-control": "private, no-store" };

// The apps the signed-in person has allowed to act as them (OAuth 2.0
// authorization code flow), for Settings, Connected apps.
export async function GET(request: Request) {
  const sessionResult = await requireVerifiedSenderSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  return NextResponse.json(
    { grants: await listOAuthGrantsForUser(sessionResult.user.id) },
    { headers: noStore },
  );
}
