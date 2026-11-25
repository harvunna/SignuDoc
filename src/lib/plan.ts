import { createHash, timingSafeEqual } from "node:crypto";

import { type DbExecutor, getDb, queryOne } from "./db/connection.ts";
import { type EnvSource, readEnv } from "./utils/env.ts";

// Signly plans. Each customer has a site of their own, made and looked
// after by GCM's control panel, and the plan that customer pays for reaches
// the site as environment variables:
//
// - SIGNLY_PLAN_NAME: shown to administrators in Settings.
// - SIGNLY_MAX_ENVELOPES_PER_MONTH: envelopes sent in a calendar month
//   (UTC), whichever way they are sent (the web app, bulk send, templates,
//   the API). They all go through sendDraftEnvelope, which takes a place
//   in the month before the envelope goes out (claimMonthlySend).
// - SIGNLY_MAX_USERS: accounts on the site. Sign-up stops at the limit.
// - SIGNLY_SITE_STATUS: "paused" when the subscription needs attention.
//   People can still sign in, read and download, and signers can finish
//   what was already sent to them, but nothing new goes out.
// - SIGNLY_BILLING_URL: where an administrator sorts out the plan.
//
// Every one of them is optional. A site without them has no limits and is
// active, which is how GCM's own site runs.
//
// The control panel reads the site's usage from GET /api/internal/usage,
// with SIGNLY_CONTROL_SECRET as a bearer token.

export type SiteStatus = "active" | "paused";

export type PlanConfig = {
  /** Where the plan is changed or paid, or null. Only http(s) links. */
  billingUrl: string | null;
  /** Null: no limit. */
  maxEnvelopesPerMonth: number | null;
  /** Null: no limit. */
  maxUsers: number | null;
  name: string | null;
  status: SiteStatus;
};

/** Why a send is refused, in the API's terms and the sender's words. */
export type SendBlock = {
  code: "plan_limit_reached" | "site_paused";
  message: string;
  statusCode: 402;
};

export const SITE_PAUSED_MESSAGE =
  "This site's subscription needs attention, so new envelopes cannot be sent right now. Envelopes already sent can still be signed. An administrator can sort out the subscription.";

export const USER_LIMIT_MESSAGE =
  "This site has as many accounts as its plan allows, so no new account can be made. Ask an administrator.";

export function envelopeLimitMessage(limit: number): string {
  return `This site has sent ${String(limit)} ${limit === 1 ? "envelope" : "envelopes"} this month, the most its plan allows. Sending starts again on the 1st of next month (UTC), or an administrator can upgrade the plan.`;
}

/**
 * A whole number of zero or more, or null. A value that is not one is left
 * out with a warning rather than read as some other limit: a typo in the
 * control panel must not stop a customer's site from sending.
 */
function readLimit(env: EnvSource, name: string): number | null {
  const value = readEnv(env, name);

  if (value === undefined) {
    return null;
  }

  if (!/^\d{1,9}$/.test(value)) {
    console.warn(
      `[plan] ${name} is not a whole number, so it is ignored: no limit.`,
    );
    return null;
  }

  return Number(value);
}

function readBillingUrl(env: EnvSource): string | null {
  const value = readEnv(env, "SIGNLY_BILLING_URL");

  if (!value) {
    return null;
  }

  // Shown as a link, so only web addresses: never javascript: or data:.
  try {
    const url = new URL(value);

    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function readPlanConfig(env: EnvSource = process.env): PlanConfig {
  const status = readEnv(env, "SIGNLY_SITE_STATUS")?.toLowerCase();

  if (status && status !== "active" && status !== "paused") {
    console.warn(
      `[plan] SIGNLY_SITE_STATUS is "${status}", which is neither active nor paused, so the site stays active.`,
    );
  }

  return {
    billingUrl: readBillingUrl(env),
    maxEnvelopesPerMonth: readLimit(env, "SIGNLY_MAX_ENVELOPES_PER_MONTH"),
    maxUsers: readLimit(env, "SIGNLY_MAX_USERS"),
    name: readEnv(env, "SIGNLY_PLAN_NAME") ?? null,
    status: status === "paused" ? "paused" : "active",
  };
}

/** True when any part of a plan is set, so Settings has something to show. */
export function hasPlan(plan: PlanConfig): boolean {
  return (
    plan.name !== null ||
    plan.maxEnvelopesPerMonth !== null ||
    plan.maxUsers !== null ||
    plan.billingUrl !== null ||
    plan.status !== "active"
  );
}

/** The month a moment falls in, 'YYYY-MM' in UTC. */
export function usageMonth(atSeconds: number): string {
  return new Date(atSeconds * 1000).toISOString().slice(0, 7);
}

/** "23 of 100 envelopes this month", or without "of" when there is no limit. */
export function describeEnvelopeUsage(
  sent: number,
  limit: number | null,
): string {
  const noun = (count: number) => (count === 1 ? "envelope" : "envelopes");

  return limit === null
    ? `${String(sent)} ${noun(sent)} this month`
    : `${String(sent)} of ${String(limit)} ${noun(limit)} this month`;
}

export async function readEnvelopesSentInMonth(
  month: string,
  database: DbExecutor = getDb(),
): Promise<number> {
  const row = await queryOne<{ envelopesSent: number }>(
    database,
    `
      SELECT envelopes_sent AS "envelopesSent"
      FROM monthly_send_usage
      WHERE month = $1
    `,
    [month],
  );

  return row?.envelopesSent ?? 0;
}

/**
 * Why a new envelope cannot go out now, or null. Asked before a send does
 * any work, so the sender hears it at once; claimMonthlySend makes the
 * final decision under the send's own lock.
 */
export async function describeSendBlock(
  database: DbExecutor = getDb(),
  {
    env = process.env,
    now = Math.floor(Date.now() / 1000),
  }: { env?: EnvSource; now?: number } = {},
): Promise<SendBlock | null> {
  const plan = readPlanConfig(env);

  if (plan.status === "paused") {
    return {
      code: "site_paused",
      message: SITE_PAUSED_MESSAGE,
      statusCode: 402,
    };
  }

  if (plan.maxEnvelopesPerMonth === null) {
    return null;
  }

  const sent = await readEnvelopesSentInMonth(usageMonth(now), database);

  return sent >= plan.maxEnvelopesPerMonth
    ? limitBlock(plan.maxEnvelopesPerMonth)
    : null;
}

function limitBlock(limit: number): SendBlock {
  return {
    code: "plan_limit_reached",
    message: envelopeLimitMessage(limit),
    statusCode: 402,
  };
}

/**
 * Takes a place in the month for one send, inside the send's transaction.
 * Returns why the send must not go out, or null when it took its place.
 *
 * The row is updated only while it is under the limit, and the update
 * waits for any other send holding the row, then looks again at what that
 * send left. So when two sends race for the last place, one of them gets
 * it and the other is refused.
 */
export async function claimMonthlySend(
  tx: DbExecutor,
  sentAt: number,
  env: EnvSource = process.env,
): Promise<SendBlock | null> {
  const plan = readPlanConfig(env);

  // Checked again here: the site may have been paused while this send was
  // being checked.
  if (plan.status === "paused") {
    return {
      code: "site_paused",
      message: SITE_PAUSED_MESSAGE,
      statusCode: 402,
    };
  }

  const limit = plan.maxEnvelopesPerMonth;

  if (limit === 0) {
    return limitBlock(limit);
  }

  const claimed = await tx.query(
    `
      INSERT INTO monthly_send_usage (month, envelopes_sent, updated_at)
      VALUES ($1, 1, $2)
      ON CONFLICT (month) DO UPDATE
      SET
        envelopes_sent = monthly_send_usage.envelopes_sent + 1,
        updated_at = EXCLUDED.updated_at
      WHERE $3::integer IS NULL
        OR monthly_send_usage.envelopes_sent < $3::integer
      RETURNING envelopes_sent
    `,
    [usageMonth(sentAt), sentAt, limit],
  );

  return claimed.rowCount === 1 || limit === null ? null : limitBlock(limit);
}

/**
 * Gives back the place a send took, when that send went back to being a
 * draft (its first invitation could not be sent).
 */
export async function releaseMonthlySend(
  tx: DbExecutor,
  sentAt: number,
  now: number = Math.floor(Date.now() / 1000),
): Promise<void> {
  await tx.query(
    `
      UPDATE monthly_send_usage
      SET envelopes_sent = greatest(envelopes_sent - 1, 0), updated_at = $2
      WHERE month = $1
    `,
    [usageMonth(sentAt), now],
  );
}

export async function countUsers(
  database: DbExecutor = getDb(),
): Promise<number> {
  const row = await queryOne<{ total: number }>(
    database,
    `SELECT count(*)::integer AS total FROM public."user"`,
  );

  return row?.total ?? 0;
}

/**
 * Whether one more account fits the plan. Asked by the sign-up rule
 * (evaluateSignupRequest), which every new account passes, whether it
 * signs up with a password or comes from single sign-on.
 */
export async function userLimitReached(
  database: DbExecutor = getDb(),
  env: EnvSource = process.env,
): Promise<boolean> {
  const { maxUsers } = readPlanConfig(env);

  return maxUsers !== null && (await countUsers(database)) >= maxUsers;
}

export type PlanUsage = {
  envelopesSentThisMonth: number;
  month: string;
  plan: PlanConfig;
  users: number;
};

/** What Settings shows an administrator. */
export async function readPlanUsage(
  database: DbExecutor = getDb(),
  {
    env = process.env,
    now = Math.floor(Date.now() / 1000),
  }: { env?: EnvSource; now?: number } = {},
): Promise<PlanUsage> {
  const month = usageMonth(now);
  const [envelopesSentThisMonth, users] = await Promise.all([
    readEnvelopesSentInMonth(month, database),
    countUsers(database),
  ]);

  return {
    envelopesSentThisMonth,
    month,
    plan: readPlanConfig(env),
    users,
  };
}

export type UsageReport = {
  activeApiKeys: number;
  administrators: number;
  envelopes: {
    completed: number;
    declined: number;
    draft: number;
    sent: number;
    total: number;
    voided: number;
  };
  envelopesSentThisMonth: number;
  generatedAt: string;
  month: string;
  plan: {
    maxEnvelopesPerMonth: number | null;
    maxUsers: number | null;
    name: string | null;
  };
  status: SiteStatus;
  templates: number;
  users: number;
};

/**
 * The control panel's view of the site: the plan, and counts that come
 * from a few indexed queries. Nothing about files in storage, which would
 * mean listing the store, and nothing that names a person or a document.
 */
export async function readUsageReport(
  database: DbExecutor = getDb(),
  {
    env = process.env,
    now = Math.floor(Date.now() / 1000),
  }: { env?: EnvSource; now?: number } = {},
): Promise<UsageReport> {
  const usage = await readPlanUsage(database, { env, now });
  const people = await queryOne<{ administrators: number }>(
    database,
    `
      SELECT count(*) FILTER (WHERE role = 'admin')::integer AS administrators
      FROM public."user"
    `,
  );
  const statuses = await database.query<{ status: string; total: number }>(
    `SELECT status, count(*)::integer AS total FROM envelopes GROUP BY status`,
  );
  const others = await queryOne<{ activeApiKeys: number; templates: number }>(
    database,
    `
      SELECT
        (SELECT count(*)::integer FROM templates) AS templates,
        (
          SELECT count(*)::integer FROM api_keys
          WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $1)
        ) AS "activeApiKeys"
    `,
    [now],
  );
  const envelopes = {
    completed: 0,
    declined: 0,
    draft: 0,
    sent: 0,
    total: 0,
    voided: 0,
  };

  for (const row of statuses.rows) {
    if (row.status in envelopes && row.status !== "total") {
      envelopes[row.status as Exclude<keyof typeof envelopes, "total">] =
        row.total;
    }

    envelopes.total += row.total;
  }

  return {
    activeApiKeys: others?.activeApiKeys ?? 0,
    administrators: people?.administrators ?? 0,
    envelopes,
    envelopesSentThisMonth: usage.envelopesSentThisMonth,
    generatedAt: new Date(now * 1000).toISOString(),
    month: usage.month,
    plan: {
      maxEnvelopesPerMonth: usage.plan.maxEnvelopesPerMonth,
      maxUsers: usage.plan.maxUsers,
      name: usage.plan.name,
    },
    status: usage.plan.status,
    templates: others?.templates ?? 0,
    users: usage.users,
  };
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/**
 * Whether a request carries SIGNLY_CONTROL_SECRET as its bearer token.
 * Without the secret set, nobody gets in: unlike the daily jobs, the usage
 * report tells the caller something, so it is never left open.
 */
export function isControlPanelRequest(
  authorizationHeader: string | null,
  env: EnvSource = process.env,
): boolean {
  const secret = readEnv(env, "SIGNLY_CONTROL_SECRET");
  const presented = /^Bearer (.+)$/.exec(authorizationHeader ?? "")?.[1];

  if (!secret || !presented) {
    return false;
  }

  // Hashed first so both sides are the same length for timingSafeEqual.
  return timingSafeEqual(digest(presented), digest(secret));
}
