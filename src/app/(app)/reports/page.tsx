import { ReportsShell } from "@/components/reports/reports-shell";
import { getAuthSession } from "@/lib/auth/server";
import { getDb } from "@/lib/db/connection";
import {
  type EnvelopeReport,
  getEnvelopeReport,
  listReportScopesForUser,
  parseReportScope,
  type ReportScope,
  resolveReportPeriod,
} from "@/lib/reports";

type ReportsPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function firstValue(value: string | string[] | undefined): string {
  return ((Array.isArray(value) ? value[0] : value) ?? "").slice(0, 32);
}

export default async function ReportsPage({ searchParams }: ReportsPageProps) {
  const session = await getAuthSession();
  const database = getDb();
  const params = await searchParams;
  const requestedRange = {
    from: firstValue(params.from),
    to: firstValue(params.to),
  };
  const { error: periodError, period } = resolveReportPeriod({
    ...requestedRange,
    period: firstValue(params.period),
  });
  let scopes: ReportScope[] = ["mine"];
  let scope: ReportScope = "mine";
  let report: EnvelopeReport | null = null;

  try {
    if (session) {
      // A scope one may not choose quietly becomes one's own envelopes, as
      // the dashboard's views do.
      scopes = await listReportScopesForUser(session.user.id, database);

      const requestedScope = parseReportScope(firstValue(params.scope));

      scope = scopes.includes(requestedScope) ? requestedScope : "mine";
      report = await getEnvelopeReport(
        session.user.id,
        scope,
        period,
        database,
      );
    }
  } catch {
    report = null;
  }

  return (
    <ReportsShell
      periodError={periodError}
      requestedRange={requestedRange}
      report={report}
      scope={scope}
      scopes={scopes}
    />
  );
}
