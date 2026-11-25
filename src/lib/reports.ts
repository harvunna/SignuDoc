import { toCsv } from "./audit-export.ts";
import {
  type DbExecutor,
  getDb,
  queryMany,
  queryOne,
} from "./db/connection.ts";
import { sharesTeamCondition } from "./envelope-access.ts";

// Envelope reports: what happened to the envelopes sent in a period, like
// the agreement reports of other e-signature services. A report counts the
// envelopes whose sent_at falls in the period and says where each stands
// now (completed, declined, voided, expired or still waiting), so the
// numbers of one period never change because of another.
//
// Whose envelopes a report covers follows the dashboard's rules exactly
// (envelopes.ts, envelope-access.ts): one's own; with "team", also those
// that people on a team with one have sent; with "all", for an
// administrator only, everyone's. Drafts are never counted: they have not
// been sent, and nobody but their sender may see them.
//
// Every date is in UTC, like the rest of the app's dates.

export type ReportScope = "all" | "mine" | "team";

export const reportScopes: readonly ReportScope[] = ["mine", "team", "all"];

export const reportScopeLabels: Record<ReportScope, string> = {
  all: "Everyone",
  mine: "My envelopes",
  team: "My team",
};

export type ReportPeriodKind = "7d" | "30d" | "90d" | "month" | "custom";

export const reportPeriodKinds: readonly ReportPeriodKind[] = [
  "7d",
  "30d",
  "90d",
  "month",
  "custom",
];

export const reportPeriodLabels: Record<ReportPeriodKind, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  custom: "Custom range",
  month: "This month",
};

const DAY_SECONDS = 24 * 60 * 60;

/** Longer custom ranges are refused, to keep one report a bounded read. */
export const MAX_REPORT_RANGE_DAYS = 3660;

/** How many open envelopes the "waiting longest" list shows. */
export const OLDEST_OPEN_LIMIT = 10;

export type ReportPeriod = {
  /** Start of the period, inclusive, in Unix seconds. */
  from: number;
  /** First day of the period, YYYY-MM-DD (UTC). */
  fromDate: string;
  kind: ReportPeriodKind;
  /** End of the period, exclusive, in Unix seconds. */
  to: number;
  /** Last day of the period, YYYY-MM-DD (UTC), inclusive. */
  toDate: string;
};

export class ReportError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "ReportError";
    this.statusCode = statusCode;
  }
}

function isoDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

/** Midnight UTC at the start of a YYYY-MM-DD day, or null if not a day. */
function parseIsoDate(value: string | undefined): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }

  const milliseconds = Date.parse(`${value}T00:00:00Z`);

  // Date.parse rolls 2026-02-31 over to March; a day that does not read
  // back the same is not a real one.
  if (
    !Number.isFinite(milliseconds) ||
    isoDate(milliseconds / 1000) !== value
  ) {
    return null;
  }

  return milliseconds / 1000;
}

export function parseReportScope(value: string | undefined): ReportScope {
  return reportScopes.find((scope) => scope === value) ?? "mine";
}

/**
 * The period a report covers, read from the page's address. A preset ends
 * now; a custom range runs from the start of its first day to the end of
 * its last, both in UTC. A custom range that cannot be used falls back to
 * the last 30 days, with `error` saying why.
 */
export function resolveReportPeriod(
  input: { from?: string; period?: string; to?: string },
  nowUnixSeconds: number = Math.floor(Date.now() / 1000),
): { error?: string; period: ReportPeriod } {
  const kind =
    reportPeriodKinds.find((option) => option === input.period) ?? "30d";
  // Just past now, so an envelope sent this second is in.
  const end = nowUnixSeconds + 1;

  function preset(presetKind: Exclude<ReportPeriodKind, "custom">) {
    const now = new Date(nowUnixSeconds * 1000);
    const from =
      presetKind === "month"
        ? Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000
        : nowUnixSeconds -
          { "7d": 7, "30d": 30, "90d": 90 }[presetKind] * DAY_SECONDS;

    return {
      from,
      fromDate: isoDate(from),
      kind: presetKind,
      to: end,
      toDate: isoDate(nowUnixSeconds),
    };
  }

  if (kind !== "custom") {
    return { period: preset(kind) };
  }

  const from = parseIsoDate(input.from);
  const lastDay = parseIsoDate(input.to);

  if (from === null || lastDay === null) {
    return {
      error: "Choose a start and an end date for a custom range.",
      period: preset("30d"),
    };
  }

  if (lastDay < from) {
    return {
      error: "The end date is before the start date.",
      period: preset("30d"),
    };
  }

  const to = lastDay + DAY_SECONDS;

  if ((to - from) / DAY_SECONDS > MAX_REPORT_RANGE_DAYS) {
    return {
      error: "Choose a range of ten years or less.",
      period: preset("30d"),
    };
  }

  return {
    period: {
      from,
      fromDate: isoDate(from),
      kind: "custom",
      to,
      toDate: isoDate(lastDay),
    },
  };
}

export type ReportCounts = {
  completed: number;
  declined: number;
  /** Still out for signing, but its deadline has passed. */
  expired: number;
  sent: number;
  voided: number;
  /** Still out for signing, deadline not passed (or none). */
  waiting: number;
};

export type ReportSenderRow = ReportCounts & {
  email: string;
  medianSecondsToComplete: number | null;
  name: string | null;
  userId: string;
};

export type ReportOpenEnvelope = {
  expiresAt: number | null;
  id: string;
  senderEmail: string;
  senderName: string | null;
  sentAt: number;
  title: string;
  /** Whose turn it is, comma-separated, or null when nobody's yet. */
  waitingOn: string | null;
  waitingSeconds: number;
};

export type EnvelopeReport = {
  averageSecondsToComplete: number | null;
  /** Completed out of sent, from 0 to 1; null when nothing was sent. */
  completionRate: number | null;
  generatedAt: number;
  medianSecondsToComplete: number | null;
  /** Open envelopes sent in the period, the longest-waiting first. */
  oldestOpen: ReportOpenEnvelope[];
  period: ReportPeriod;
  scope: ReportScope;
  /** Each sender's envelopes, most sent first. */
  senders: ReportSenderRow[];
  totals: ReportCounts;
};

/**
 * The report scopes this person may choose, as the dashboard's views: their
 * own; their teams' when they are on a team; everyone's for an
 * administrator.
 */
export async function listReportScopesForUser(
  userId: string,
  database: DbExecutor = getDb(),
): Promise<ReportScope[]> {
  const row = await queryOne<{ isAdmin: boolean; onTeam: boolean }>(
    database,
    `
      SELECT
        EXISTS (
          SELECT 1 FROM public."user" WHERE id = $1 AND role = 'admin'
        ) AS "isAdmin",
        EXISTS (SELECT 1 FROM team_members WHERE user_id = $1) AS "onTeam"
    `,
    [userId],
  );

  return [
    "mine",
    ...(row?.onTeam ? (["team"] as const) : []),
    ...(row?.isAdmin ? (["all"] as const) : []),
  ];
}

/**
 * Whose envelopes are counted, as SQL on the envelope row `e`, for the
 * viewer in $1. The same rules as the dashboard's lists. "all" asks the
 * database again whether the viewer is an administrator, so a report can
 * never cover the install for someone who is not, whatever the caller
 * checked.
 */
function reportScopeClause(scope: ReportScope): string {
  switch (scope) {
    case "mine":
      return "e.user_id = $1";
    case "team":
      return `(e.user_id = $1 OR ${sharesTeamCondition("$1", "e")})`;
    case "all":
      return `EXISTS (
        SELECT 1 FROM public."user" viewer WHERE viewer.id = $1 AND viewer.role = 'admin'
      )`;
  }
}

/** The counts every part of the report shares, over the rows in `e`. */
const countColumns = `
  count(*)::bigint AS sent,
  count(*) FILTER (WHERE e.status = 'completed')::bigint AS completed,
  count(*) FILTER (WHERE e.status = 'declined')::bigint AS declined,
  count(*) FILTER (WHERE e.status = 'voided')::bigint AS voided,
  count(*) FILTER (
    WHERE e.status = 'sent' AND e.expires_at IS NOT NULL AND e.expires_at <= $4
  )::bigint AS expired,
  count(*) FILTER (
    WHERE e.status = 'sent' AND (e.expires_at IS NULL OR e.expires_at > $4)
  )::bigint AS waiting,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY e.completed_at - e.sent_at)
    FILTER (WHERE e.status = 'completed' AND e.completed_at IS NOT NULL)
    AS "medianSecondsToComplete"
`;

function zeroCounts(): ReportCounts {
  return {
    completed: 0,
    declined: 0,
    expired: 0,
    sent: 0,
    voided: 0,
    waiting: 0,
  };
}

/**
 * The report for one viewer, scope and period. Throws a 403 ReportError
 * when "all" is asked for by someone who is not an administrator.
 */
export async function getEnvelopeReport(
  viewerUserId: string,
  scope: ReportScope,
  period: ReportPeriod,
  database: DbExecutor = getDb(),
  nowUnixSeconds: number = Math.floor(Date.now() / 1000),
): Promise<EnvelopeReport> {
  if (scope === "all") {
    const scopes = await listReportScopesForUser(viewerUserId, database);

    if (!scopes.includes("all")) {
      throw new ReportError(
        "Only an administrator can see everyone's envelopes.",
        403,
      );
    }
  }

  // $1 viewer, $2 period start (inclusive), $3 period end (exclusive),
  // $4 now, which decides whether an open envelope has expired.
  const values = [viewerUserId, period.from, period.to, nowUnixSeconds];
  const where = `
    ${reportScopeClause(scope)}
    AND e.status <> 'draft'
    AND e.sent_at >= $2
    AND e.sent_at < $3
  `;

  type CountsRow = ReportCounts & {
    averageSecondsToComplete: number | null;
    medianSecondsToComplete: number | null;
  };

  const [totals, senders, oldestOpen] = await Promise.all([
    queryOne<CountsRow>(
      database,
      `
        SELECT
          ${countColumns},
          (avg(e.completed_at - e.sent_at)
            FILTER (WHERE e.status = 'completed' AND e.completed_at IS NOT NULL)
          )::double precision AS "averageSecondsToComplete"
        FROM envelopes e
        WHERE ${where}
      `,
      values,
    ),
    queryMany<ReportSenderRow>(
      database,
      `
        SELECT
          e.user_id AS "userId",
          sender.name,
          sender.email,
          ${countColumns}
        FROM envelopes e
        JOIN public."user" sender ON sender.id = e.user_id
        WHERE ${where}
        GROUP BY e.user_id, sender.name, sender.email
        ORDER BY count(*) DESC, lower(sender.email), e.user_id
      `,
      values,
    ),
    queryMany<ReportOpenEnvelope>(
      database,
      `
        SELECT
          e.id,
          e.title,
          e.sent_at AS "sentAt",
          e.expires_at AS "expiresAt",
          ($4 - e.sent_at)::bigint AS "waitingSeconds",
          sender.name AS "senderName",
          sender.email AS "senderEmail",
          (
            SELECT string_agg(s.email, ', ' ORDER BY s.sign_order)
            FROM signers s
            WHERE s.envelope_id = e.id AND s.status = 'notified'
          ) AS "waitingOn"
        FROM envelopes e
        JOIN public."user" sender ON sender.id = e.user_id
        WHERE ${where}
          AND e.status = 'sent'
          AND (e.expires_at IS NULL OR e.expires_at > $4)
        ORDER BY e.sent_at ASC, e.id
        LIMIT ${String(OLDEST_OPEN_LIMIT)}
      `,
      values,
    ),
  ]);

  const counts = totals ?? {
    ...zeroCounts(),
    averageSecondsToComplete: null,
    medianSecondsToComplete: null,
  };

  return {
    averageSecondsToComplete: counts.averageSecondsToComplete,
    completionRate: counts.sent > 0 ? counts.completed / counts.sent : null,
    generatedAt: nowUnixSeconds,
    medianSecondsToComplete: counts.medianSecondsToComplete,
    oldestOpen,
    period,
    scope,
    senders,
    totals: {
      completed: counts.completed,
      declined: counts.declined,
      expired: counts.expired,
      sent: counts.sent,
      voided: counts.voided,
      waiting: counts.waiting,
    },
  };
}

/** A length of time as people say it: "45 minutes", "3.5 hours", "2 days". */
export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) {
    return "—";
  }

  const minutes = seconds / 60;

  if (minutes < 1) {
    return "under a minute";
  }

  if (minutes < 60) {
    const rounded = Math.round(minutes);
    return `${String(rounded)} minute${rounded === 1 ? "" : "s"}`;
  }

  const hours = minutes / 60;

  if (hours < 48) {
    const rounded = Math.round(hours * 10) / 10;
    return `${String(rounded)} hour${rounded === 1 ? "" : "s"}`;
  }

  const days = Math.round((hours / 24) * 10) / 10;

  return `${String(days)} days`;
}

/** A share from 0 to 1 as a whole percentage, or a dash for none. */
export function formatRate(rate: number | null): string {
  return rate === null ? "—" : `${String(Math.round(rate * 100))}%`;
}

function hours(seconds: number | null): string {
  return seconds === null ? "" : (seconds / 3600).toFixed(1);
}

function isoTime(unixSeconds: number | null): string {
  return unixSeconds === null ? "" : new Date(unixSeconds * 1000).toISOString();
}

/** The report as one CSV file: summary, then senders, then open envelopes. */
export function buildEnvelopeReportCsv(report: EnvelopeReport): {
  body: string;
  fileName: string;
} {
  const { period, totals } = report;
  const body = toCsv([
    ["Envelope report"],
    ["Envelopes", reportScopeLabels[report.scope]],
    ["Period", reportPeriodLabels[period.kind]],
    ["From (UTC)", period.fromDate, "To (UTC)", period.toDate],
    ["Generated at (UTC)", isoTime(report.generatedAt)],
    [],
    ["metric", "value"],
    ["sent", totals.sent],
    ["completed", totals.completed],
    ["declined", totals.declined],
    ["voided", totals.voided],
    ["expired", totals.expired],
    ["waiting", totals.waiting],
    [
      "completion_rate_percent",
      report.completionRate === null
        ? ""
        : (report.completionRate * 100).toFixed(1),
    ],
    ["median_hours_to_complete", hours(report.medianSecondsToComplete)],
    ["average_hours_to_complete", hours(report.averageSecondsToComplete)],
    [],
    [
      "sender_name",
      "sender_email",
      "sent",
      "completed",
      "declined",
      "voided",
      "expired",
      "waiting",
      "median_hours_to_complete",
    ],
    ...report.senders.map((sender) => [
      sender.name,
      sender.email,
      sender.sent,
      sender.completed,
      sender.declined,
      sender.voided,
      sender.expired,
      sender.waiting,
      hours(sender.medianSecondsToComplete),
    ]),
    [],
    [
      "waiting_longest_envelope_id",
      "title",
      "sender_email",
      "sent_at_utc",
      "days_waiting",
      "waiting_on",
      "deadline_utc",
    ],
    ...report.oldestOpen.map((envelope) => [
      envelope.id,
      envelope.title,
      envelope.senderEmail,
      isoTime(envelope.sentAt),
      (envelope.waitingSeconds / DAY_SECONDS).toFixed(1),
      envelope.waitingOn,
      isoTime(envelope.expiresAt),
    ]),
  ]);

  return {
    body,
    fileName: `envelope-report-${report.scope}-${period.fromDate}-to-${period.toDate}.csv`,
  };
}
