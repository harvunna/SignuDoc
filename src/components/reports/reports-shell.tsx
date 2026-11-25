import { DownloadIcon } from "lucide-react";
import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { PageHeader } from "@/components/shared/page-header";
import { cn } from "@/lib/cn";
import {
  type EnvelopeReport,
  formatDuration,
  formatRate,
  type ReportCounts,
  type ReportPeriod,
  type ReportPeriodKind,
  reportPeriodKinds,
  reportPeriodLabels,
  type ReportScope,
  reportScopeLabels,
} from "@/lib/reports";

// The Reports page. Everything here is drawn on the server: the choices are
// plain links and a GET form, and the charts are HTML bars sized with
// inline widths, so nothing needs a script the site's CSP would refuse.

type ReportsShellProps = {
  /** Why the chosen custom range was not used, if it was not. */
  periodError?: string;
  /** What was in the custom range's boxes, to show them again. */
  requestedRange: { from: string; to: string };
  report: EnvelopeReport | null;
  scope: ReportScope;
  scopes: readonly ReportScope[];
};

type ReportQuery = {
  from?: string;
  period: ReportPeriodKind;
  scope: ReportScope;
  to?: string;
};

function reportQueryString({ from, period, scope, to }: ReportQuery): string {
  const params = new URLSearchParams();

  if (scope !== "mine") {
    params.set("scope", scope);
  }

  params.set("period", period);

  if (period === "custom" && from && to) {
    params.set("from", from);
    params.set("to", to);
  }

  return params.toString();
}

/** The Reports page's address for one choice of scope and period. */
export function reportHref(query: ReportQuery): string {
  return `/reports?${reportQueryString(query)}`;
}

/** Where the CSV of the same report downloads from. */
export function reportCsvHref(query: ReportQuery): string {
  return `/api/reports/envelopes?${reportQueryString(query)}`;
}

function periodQuery(period: ReportPeriod, scope: ReportScope): ReportQuery {
  return {
    from: period.fromDate,
    period: period.kind,
    scope,
    to: period.toDate,
  };
}

const outcomeSegments: {
  className: string;
  key: keyof Omit<ReportCounts, "sent">;
  label: string;
}[] = [
  { className: "bg-(--success)", key: "completed", label: "Completed" },
  { className: "bg-(--accent)", key: "waiting", label: "Waiting" },
  { className: "bg-(--danger)", key: "declined", label: "Declined" },
  { className: "bg-[#d98e04]", key: "expired", label: "Expired" },
  { className: "bg-(--border-hover)", key: "voided", label: "Voided" },
];

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
  year: "numeric",
});

function formatDay(isoDay: string): string {
  return dateFormatter.format(new Date(`${isoDay}T00:00:00Z`));
}

function percentOf(part: number, whole: number): string {
  return whole > 0 ? `${String((part / whole) * 100)}%` : "0%";
}

export function ReportsShell({
  periodError,
  requestedRange,
  report,
  scope,
  scopes,
}: ReportsShellProps) {
  const period = report?.period;

  return (
    <div className="space-y-5">
      <PageHeader
        action={
          report && period ? (
            <a
              className={cn(
                buttonVariants({ variant: "outline" }),
                "min-h-12 px-5.5 text-[0.9375rem]",
              )}
              download
              href={reportCsvHref(periodQuery(period, scope))}
            >
              <DownloadIcon aria-hidden="true" className="size-[1.125rem]" />
              Download CSV
            </a>
          ) : null
        }
        description="How your envelopes are doing: what was sent, what came back, and what is still waiting."
        title="Reports"
      />

      <section
        className="panel space-y-4 px-6 py-5 sm:px-8"
        data-animate="enter"
        data-animate-delay="1"
      >
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          {scopes.length > 1 ? (
            <nav aria-label="Whose envelopes" className="segmented self-start">
              {scopes.map((option) => (
                <Link
                  aria-current={option === scope ? "page" : undefined}
                  className="segmented-item"
                  data-active={option === scope}
                  href={reportHref({
                    ...(period ? periodQuery(period, option) : {}),
                    period: period?.kind ?? "30d",
                    scope: option,
                  })}
                  key={option}
                >
                  {reportScopeLabels[option]}
                </Link>
              ))}
            </nav>
          ) : (
            <p className="section-eyebrow">{reportScopeLabels.mine}</p>
          )}

          <nav aria-label="Period" className="segmented self-start">
            {reportPeriodKinds
              .filter((kind) => kind !== "custom")
              .map((kind) => (
                <Link
                  aria-current={period?.kind === kind ? "page" : undefined}
                  className="segmented-item"
                  data-active={period?.kind === kind}
                  href={reportHref({ period: kind, scope })}
                  key={kind}
                >
                  {reportPeriodLabels[kind]}
                </Link>
              ))}
          </nav>
        </div>

        <form
          action="/reports"
          aria-label="Custom range"
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
          method="get"
        >
          {scope !== "mine" ? (
            <input name="scope" type="hidden" value={scope} />
          ) : null}
          <input name="period" type="hidden" value="custom" />
          <label className="flex flex-col gap-1.5 text-[0.8125rem] font-semibold text-(--secondary)">
            From
            <input
              className="field-input min-h-[2.625rem] sm:w-44"
              defaultValue={requestedRange.from || period?.fromDate}
              name="from"
              required
              type="date"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-[0.8125rem] font-semibold text-(--secondary)">
            To
            <input
              className="field-input min-h-[2.625rem] sm:w-44"
              defaultValue={requestedRange.to || period?.toDate}
              name="to"
              required
              type="date"
            />
          </label>
          <button
            className="btn-quiet min-h-[2.625rem]"
            data-active={period?.kind === "custom"}
            type="submit"
          >
            Show custom range
          </button>
        </form>

        {periodError ? (
          <p
            className="rounded-xl bg-(--warning-soft) px-4 py-3 text-sm text-(--warning)"
            role="alert"
          >
            {periodError} Showing the last 30 days instead.
          </p>
        ) : null}

        {period ? (
          <p className="text-[0.8125rem] text-(--tertiary)">
            Envelopes sent from {formatDay(period.fromDate)} to{" "}
            {formatDay(period.toDate)} (UTC), and where each stands now.
          </p>
        ) : null}
      </section>

      {!report ? (
        <div
          className="rounded-2xl bg-(--danger-soft) px-5 py-4 text-sm font-semibold text-(--danger)"
          role="alert"
        >
          We couldn&apos;t load this report. Please try again.
        </div>
      ) : (
        <ReportBody report={report} />
      )}
    </div>
  );
}

function ReportBody({ report }: { report: EnvelopeReport }) {
  const { totals } = report;

  if (totals.sent === 0) {
    return (
      <section
        className="panel px-6 py-14 text-center sm:py-20"
        data-animate="enter"
        data-animate-delay="2"
      >
        <h2 className="text-2xl font-extrabold tracking-[-0.03em] text-(--fg)">
          Nothing sent in this period
        </h2>
        <p className="mt-2 text-[0.9375rem] leading-6 text-(--secondary)">
          Choose a longer period, or send an envelope to see it here.
        </p>
      </section>
    );
  }

  const maxSent = Math.max(...report.senders.map((sender) => sender.sent), 1);

  return (
    <>
      <section
        aria-label="Summary"
        className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6"
        data-animate="enter"
        data-animate-delay="2"
      >
        <StatTile label="Sent" value={String(totals.sent)} />
        <StatTile label="Completed" value={String(totals.completed)} />
        <StatTile label="Waiting" value={String(totals.waiting)} />
        <StatTile label="Declined" value={String(totals.declined)} />
        <StatTile label="Voided" value={String(totals.voided)} />
        <StatTile label="Expired" value={String(totals.expired)} />
      </section>

      <section
        aria-label="Completion"
        className="grid gap-3 sm:grid-cols-3"
        data-animate="enter"
        data-animate-delay="2"
      >
        <StatTile
          hint="of envelopes sent in the period"
          label="Completion rate"
          value={formatRate(report.completionRate)}
        />
        <StatTile
          hint="from sending to the last signature"
          label="Median time to complete"
          value={formatDuration(report.medianSecondsToComplete)}
        />
        <StatTile
          hint="from sending to the last signature"
          label="Average time to complete"
          value={formatDuration(report.averageSecondsToComplete)}
        />
      </section>

      <section
        className="panel space-y-4 px-6 py-6 sm:px-8"
        data-animate="enter"
        data-animate-delay="3"
      >
        <h2 className="text-lg font-extrabold tracking-[-0.02em] text-(--fg)">
          Where they stand
        </h2>
        <div
          aria-hidden="true"
          className="flex h-4 w-full overflow-hidden rounded-full bg-(--surface-strong)"
        >
          {outcomeSegments.map((segment) =>
            totals[segment.key] > 0 ? (
              <span
                className={segment.className}
                key={segment.key}
                style={{ width: percentOf(totals[segment.key], totals.sent) }}
              />
            ) : null,
          )}
        </div>
        <ul className="flex flex-wrap gap-x-5 gap-y-2 text-[0.8125rem] text-(--secondary)">
          {outcomeSegments.map((segment) => (
            <li className="flex items-center gap-2" key={segment.key}>
              <span
                aria-hidden="true"
                className={cn("size-2.5 rounded-full", segment.className)}
              />
              {segment.label}: {totals[segment.key]} (
              {formatRate(totals[segment.key] / totals.sent)})
            </li>
          ))}
        </ul>
      </section>

      <section
        className="panel overflow-hidden"
        data-animate="enter"
        data-animate-delay="3"
      >
        <h2 className="px-6 pt-6 text-lg font-extrabold tracking-[-0.02em] text-(--fg) sm:px-8">
          By sender
        </h2>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-left text-sm">
            <caption className="sr-only">Envelopes per sender</caption>
            <thead>
              <tr className="border-y border-(--border) bg-(--surface) text-xs text-(--tertiary)">
                <th className="px-6 py-3 font-semibold sm:px-8" scope="col">
                  Sender
                </th>
                <th className="px-3 py-3 font-semibold" scope="col">
                  Sent
                </th>
                <th className="px-3 py-3 text-right font-semibold" scope="col">
                  Completed
                </th>
                <th className="px-3 py-3 text-right font-semibold" scope="col">
                  Waiting
                </th>
                <th className="px-3 py-3 text-right font-semibold" scope="col">
                  Declined
                </th>
                <th className="px-3 py-3 text-right font-semibold" scope="col">
                  Voided
                </th>
                <th className="px-3 py-3 text-right font-semibold" scope="col">
                  Expired
                </th>
                <th
                  className="px-6 py-3 text-right font-semibold sm:px-8"
                  scope="col"
                >
                  Median time
                </th>
              </tr>
            </thead>
            <tbody>
              {report.senders.map((sender) => (
                <tr
                  className="border-b border-(--border) last:border-b-0"
                  key={sender.userId}
                >
                  <th
                    className="max-w-[16rem] px-6 py-3 text-left font-normal sm:px-8"
                    scope="row"
                  >
                    <span className="block truncate font-semibold text-(--fg)">
                      {sender.name?.trim() || sender.email}
                    </span>
                    {sender.name?.trim() ? (
                      <span className="block truncate text-xs text-(--tertiary)">
                        {sender.email}
                      </span>
                    ) : null}
                  </th>
                  <td className="px-3 py-3">
                    <span className="flex items-center gap-2">
                      <span className="w-8 tabular-nums font-semibold text-(--fg)">
                        {sender.sent}
                      </span>
                      <span
                        aria-hidden="true"
                        className="flex h-2 w-28 overflow-hidden rounded-full bg-(--surface-strong)"
                      >
                        <span
                          className="flex h-full overflow-hidden rounded-full"
                          style={{ width: percentOf(sender.sent, maxSent) }}
                        >
                          {outcomeSegments.map((segment) =>
                            sender[segment.key] > 0 ? (
                              <span
                                className={segment.className}
                                key={segment.key}
                                style={{
                                  width: percentOf(
                                    sender[segment.key],
                                    sender.sent,
                                  ),
                                }}
                              />
                            ) : null,
                          )}
                        </span>
                      </span>
                    </span>
                  </td>
                  <NumberCell value={sender.completed} />
                  <NumberCell value={sender.waiting} />
                  <NumberCell value={sender.declined} />
                  <NumberCell value={sender.voided} />
                  <NumberCell value={sender.expired} />
                  <td className="px-6 py-3 text-right text-(--secondary) sm:px-8">
                    {formatDuration(sender.medianSecondsToComplete)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section
        className="panel overflow-hidden"
        data-animate="enter"
        data-animate-delay="4"
      >
        <div className="space-y-1 px-6 pt-6 sm:px-8">
          <h2 className="text-lg font-extrabold tracking-[-0.02em] text-(--fg)">
            Waiting longest
          </h2>
          <p className="text-[0.8125rem] text-(--tertiary)">
            Envelopes sent in this period that are still out for signing, oldest
            first.
          </p>
        </div>
        {report.oldestOpen.length === 0 ? (
          <p className="px-6 pb-6 pt-4 text-sm text-(--secondary) sm:px-8">
            Nothing is waiting. Every envelope sent in this period has an
            outcome.
          </p>
        ) : (
          <ol className="mt-4 border-t border-(--border)">
            {report.oldestOpen.map((envelope) => (
              <li
                className="border-b border-(--border) last:border-b-0"
                key={envelope.id}
              >
                <Link
                  className="flex flex-col gap-1 px-6 py-3.5 transition hover:bg-(--surface) sm:flex-row sm:items-center sm:justify-between sm:px-8"
                  href={`/envelopes/${encodeURIComponent(envelope.id)}`}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-semibold text-(--fg)">
                      {envelope.title}
                    </span>
                    <span className="block truncate text-xs text-(--tertiary)">
                      {report.scope === "mine"
                        ? ""
                        : `${envelope.senderName?.trim() || envelope.senderEmail} · `}
                      Waiting on: {envelope.waitingOn ?? "—"}
                    </span>
                  </span>
                  <span className="pill pill-accent self-start sm:self-center">
                    {formatDuration(envelope.waitingSeconds)}
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}

function StatTile({
  hint,
  label,
  value,
}: {
  hint?: string;
  label: string;
  value: string;
}) {
  return (
    <div className="panel space-y-1 px-5 py-4">
      <p className="section-eyebrow">{label}</p>
      <p className="text-[1.75rem] font-extrabold leading-tight tracking-[-0.03em] text-(--fg) tabular-nums">
        {value}
      </p>
      {hint ? <p className="text-xs text-(--tertiary)">{hint}</p> : null}
    </div>
  );
}

function NumberCell({ value }: { value: number }) {
  return (
    <td className="px-3 py-3 text-right tabular-nums text-(--secondary)">
      {value}
    </td>
  );
}
