import { describeEnvelopeUsage, type PlanUsage } from "@/lib/plan";

// Signly plans: the Plan section of Settings, for administrators. Shows the
// plan this site is on, how much of it this month has used, and where to
// change it. The plan itself is set by GCM's control panel (src/lib/plan.ts),
// so there is nothing to edit here.

const linkClassName =
  "font-semibold text-(--accent-ink) underline decoration-[rgb(var(--accent-rgb)/0.35)] underline-offset-4";

export function PlanPanel({ usage }: { usage: PlanUsage }) {
  const { plan } = usage;
  const envelopesUsedUp =
    plan.maxEnvelopesPerMonth !== null &&
    usage.envelopesSentThisMonth >= plan.maxEnvelopesPerMonth;
  const usersUsedUp = plan.maxUsers !== null && usage.users >= plan.maxUsers;

  return (
    <section
      className="panel scroll-mt-6 p-6 sm:p-8"
      data-animate="enter"
      data-animate-delay="2"
      id="plan"
    >
      <div className="space-y-6">
        <div className="space-y-2">
          <p className="section-eyebrow">Administrator</p>
          <h2 className="text-2xl font-extrabold tracking-[-0.03em] text-(--fg)">
            Plan
          </h2>
          <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
            {plan.name ? (
              <>
                This site is on the{" "}
                <span className="font-bold text-(--fg)">{plan.name}</span> plan.
              </>
            ) : (
              "This site's plan."
            )}{" "}
            Months are counted in UTC.
          </p>
        </div>

        {plan.status === "paused" ? (
          <p className="notice notice-warning" role="status">
            The subscription needs attention, so new envelopes cannot be sent.
            People can still sign in, read and download, and signers can finish
            envelopes already sent.
          </p>
        ) : null}

        <dl className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-2xl bg-(--surface) px-5 py-4">
            <dt className="text-sm font-semibold text-(--secondary)">
              Envelopes sent
            </dt>
            <dd
              className="mt-1 text-base font-bold text-(--fg)"
              data-testid="plan-envelope-usage"
            >
              {describeEnvelopeUsage(
                usage.envelopesSentThisMonth,
                plan.maxEnvelopesPerMonth,
              )}
            </dd>
          </div>
          <div className="rounded-2xl bg-(--surface) px-5 py-4">
            <dt className="text-sm font-semibold text-(--secondary)">
              Accounts
            </dt>
            <dd className="mt-1 text-base font-bold text-(--fg)">
              {plan.maxUsers === null
                ? `${String(usage.users)} ${usage.users === 1 ? "account" : "accounts"}`
                : `${String(usage.users)} of ${String(plan.maxUsers)} accounts`}
            </dd>
          </div>
        </dl>

        {envelopesUsedUp ? (
          <p className="notice notice-warning" role="status">
            This month&apos;s envelopes are used up. Sending starts again on the
            1st of next month, or sooner with a bigger plan.
          </p>
        ) : null}

        {usersUsedUp ? (
          <p className="notice notice-warning" role="status">
            The site has as many accounts as the plan allows, so no one new can
            sign up.
          </p>
        ) : null}

        {plan.billingUrl ? (
          <a
            className={linkClassName}
            href={plan.billingUrl}
            rel="noreferrer"
            target="_blank"
          >
            {plan.status === "paused"
              ? "Manage subscription"
              : envelopesUsedUp || usersUsedUp
                ? "Upgrade your plan"
                : "Change your plan"}
          </a>
        ) : null}
      </div>
    </section>
  );
}
