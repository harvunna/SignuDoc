import { NextResponse } from "next/server";

import { isControlPanelRequest, readUsageReport } from "@/lib/plan";
import { logRouteError } from "@/lib/security/logging";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";

// GCM eSign plans: the usage report GCM's control panel reads for each
// customer site (src/lib/plan.ts): the plan, whether the site is paused,
// envelopes sent this month, accounts, and a few other counts.
//
// The control panel sends GCMESIGN_CONTROL_SECRET as a bearer token, the way
// Vercel sends CRON_SECRET to the daily jobs. Unlike those jobs, this route
// is never open: with no secret set, every caller is refused.

const NO_STORE = { "cache-control": "private, no-store" };

export async function GET(request: Request) {
  if (!isControlPanelRequest(request.headers.get("authorization"))) {
    return NextResponse.json(
      { error: "Unauthorized." },
      { headers: NO_STORE, status: 401 },
    );
  }

  try {
    return NextResponse.json(await readUsageReport(), { headers: NO_STORE });
  } catch (error) {
    logRouteError(error, {
      category: "usage_report_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "The usage report could not be read.",
      path: getRequestPathname(request),
    });

    return NextResponse.json(
      { error: "The usage report could not be read." },
      { headers: NO_STORE, status: 500 },
    );
  }
}
