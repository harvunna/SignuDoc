import { NextResponse } from "next/server";

import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import {
  buildEnvelopeReportCsv,
  getEnvelopeReport,
  listReportScopesForUser,
  parseReportScope,
  ReportError,
  resolveReportPeriod,
} from "@/lib/reports";
import { logRouteError } from "@/lib/security/logging";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";
import { buildContentDisposition } from "@/lib/services/storage";
import { recordSystemAuditEvent } from "@/lib/services/system-audit";

const noStore = { "cache-control": "private, no-store" };

// The Reports page's report as a CSV file: ?scope=mine|team|all
// &period=7d|30d|90d|month|custom (&from=&to= as YYYY-MM-DD for custom).
// The same rules as the page decide whose envelopes it covers, except that
// a scope one may not choose is refused rather than narrowed, so a file
// never says it covers more than it does.
export async function GET(request: Request) {
  const sessionResult = await requireVerifiedSenderSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  const userId = sessionResult.user.id;
  const rateLimitResponse = await applyRateLimit({
    category: "report_export",
    key: buildRateLimitKey(["report-export", userId]),
    limit: 60,
    request,
    userId,
    windowMs: 10 * 60 * 1000,
  });

  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  const url = new URL(request.url);
  const { error: periodError, period } = resolveReportPeriod({
    from: url.searchParams.get("from") ?? undefined,
    period: url.searchParams.get("period") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
  });

  if (periodError) {
    return NextResponse.json(
      { error: periodError },
      { headers: noStore, status: 400 },
    );
  }

  const scope = parseReportScope(url.searchParams.get("scope") ?? undefined);

  try {
    const scopes = await listReportScopesForUser(userId);

    if (!scopes.includes(scope)) {
      return NextResponse.json(
        { error: "You can't see those envelopes." },
        { headers: noStore, status: 403 },
      );
    }

    const report = await getEnvelopeReport(userId, scope, period);
    const file = buildEnvelopeReportCsv(report);

    if (scope !== "mine") {
      // A file with other members' envelopes in it is a copy of their
      // records, so it goes on the install's audit trail like any other
      // file of theirs taken by an administrator or a teammate.
      await recordSystemAuditEvent({
        actorEmail: sessionResult.user.email,
        actorUserId: userId,
        event: "envelope_file_downloaded",
        ipAddress: getClientIpAddress(request.headers),
        metadata: {
          envelopes: report.totals.sent,
          file: "envelope_report",
          from: period.fromDate,
          scope,
          to: period.toDate,
        },
        userAgent: request.headers.get("user-agent"),
      });
    }

    return new Response(file.body, {
      headers: {
        ...noStore,
        "content-disposition": buildContentDisposition(file.fileName),
        "content-type": "text/csv; charset=utf-8",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof ReportError) {
      return NextResponse.json(
        { error: error.message },
        { headers: noStore, status: error.statusCode },
      );
    }

    logRouteError(error, {
      category: "report_export_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while exporting an envelope report.",
      path: getRequestPathname(request),
      userId,
    });

    return NextResponse.json(
      { error: "The report could not be exported." },
      { headers: noStore, status: 500 },
    );
  }
}
