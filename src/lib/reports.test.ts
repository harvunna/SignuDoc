import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildEnvelopeReportCsv,
  type EnvelopeReport,
  formatDuration,
  formatRate,
  parseReportScope,
  resolveReportPeriod,
} from "./reports.ts";

// The parts of reports that need no database: reading the period from the
// address, the wording of times and rates, and the CSV file.

const DAY = 24 * 60 * 60;
// 2026-11-24 15:30:00 UTC.
const now = Date.UTC(2026, 10, 24, 15, 30) / 1000;

test("a preset period ends now and starts that many days back", () => {
  const { error, period } = resolveReportPeriod({ period: "7d" }, now);

  assert.equal(error, undefined);
  assert.equal(period.kind, "7d");
  assert.equal(period.from, now - 7 * DAY);
  assert.equal(period.to, now + 1);
  assert.equal(period.fromDate, "2026-11-17");
  assert.equal(period.toDate, "2026-11-24");
  assert.equal(
    resolveReportPeriod({ period: "90d" }, now).period.from,
    now - 90 * DAY,
  );
});

test("no period, or one not known, is the last 30 days", () => {
  assert.equal(resolveReportPeriod({}, now).period.kind, "30d");
  assert.equal(resolveReportPeriod({ period: "1y" }, now).period.kind, "30d");
  assert.equal(resolveReportPeriod({}, now).period.from, now - 30 * DAY);
});

test("this month starts at midnight UTC on the 1st", () => {
  const { period } = resolveReportPeriod({ period: "month" }, now);

  assert.equal(period.from, Date.UTC(2026, 10, 1) / 1000);
  assert.equal(period.fromDate, "2026-11-01");
});

test("a custom range covers its first and last days whole", () => {
  const { error, period } = resolveReportPeriod(
    { from: "2026-10-01", period: "custom", to: "2026-10-31" },
    now,
  );

  assert.equal(error, undefined);
  assert.equal(period.kind, "custom");
  assert.equal(period.from, Date.UTC(2026, 9, 1) / 1000);
  assert.equal(period.to, Date.UTC(2026, 10, 1) / 1000);
  assert.equal(period.toDate, "2026-10-31");
});

test("a custom range that cannot be used falls back with a reason", () => {
  for (const input of [
    { from: "", to: "2026-10-31" },
    { from: "2026-02-31", to: "2026-03-02" },
    { from: "01/10/2026", to: "2026-10-31" },
    { from: "2026-10-31", to: "2026-10-01" },
    { from: "1990-01-01", to: "2026-10-01" },
  ]) {
    const { error, period } = resolveReportPeriod(
      { ...input, period: "custom" },
      now,
    );

    assert.ok(error, JSON.stringify(input));
    assert.equal(period.kind, "30d");
  }
});

test("only known scopes are read from the address", () => {
  assert.equal(parseReportScope("all"), "all");
  assert.equal(parseReportScope("team"), "team");
  assert.equal(parseReportScope("everyone"), "mine");
  assert.equal(parseReportScope(undefined), "mine");
});

test("times and rates read as people say them", () => {
  assert.equal(formatDuration(null), "—");
  assert.equal(formatDuration(20), "under a minute");
  assert.equal(formatDuration(60), "1 minute");
  assert.equal(formatDuration(45 * 60), "45 minutes");
  assert.equal(formatDuration(3.5 * 3600), "3.5 hours");
  assert.equal(formatDuration(3 * DAY), "3 days");
  assert.equal(formatRate(null), "—");
  assert.equal(formatRate(2 / 3), "67%");
});

test("the CSV holds the summary, each sender and the waiting envelopes", () => {
  const report: EnvelopeReport = {
    averageSecondsToComplete: 7200,
    completionRate: 0.5,
    generatedAt: now,
    medianSecondsToComplete: 3600,
    oldestOpen: [
      {
        expiresAt: null,
        id: "env-1",
        senderEmail: "ann@example.test",
        senderName: "Ann",
        sentAt: now - 2 * DAY,
        title: '=HYPERLINK("x")',
        waitingOn: "bob@example.test",
        waitingSeconds: 2 * DAY,
      },
    ],
    period: resolveReportPeriod({ period: "7d" }, now).period,
    scope: "all",
    senders: [
      {
        completed: 1,
        declined: 0,
        email: "ann@example.test",
        expired: 0,
        medianSecondsToComplete: 3600,
        name: "Ann, Sales",
        sent: 2,
        userId: "u1",
        voided: 0,
        waiting: 1,
      },
    ],
    totals: {
      completed: 1,
      declined: 0,
      expired: 0,
      sent: 2,
      voided: 0,
      waiting: 1,
    },
  };
  const { body, fileName } = buildEnvelopeReportCsv(report);
  const lines = body.split("\r\n");

  assert.equal(fileName, "envelope-report-all-2026-11-17-to-2026-11-24.csv");
  assert.ok(lines.includes("Envelopes,Everyone"));
  assert.ok(lines.includes("sent,2"));
  assert.ok(lines.includes("completion_rate_percent,50.0"));
  assert.ok(lines.includes("median_hours_to_complete,1.0"));
  assert.ok(lines.includes('"Ann, Sales",ann@example.test,2,1,0,0,0,1,1.0'));
  // A title a spreadsheet would run as a formula is defused.
  assert.ok(body.includes(`"'=HYPERLINK(""x"")"`));
  assert.ok(
    lines.some(
      (line) =>
        line.startsWith("env-1,") && line.includes(",2.0,bob@example.test,"),
    ),
  );
});
