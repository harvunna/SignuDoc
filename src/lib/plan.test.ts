import assert from "node:assert/strict";
import { test } from "node:test";

import {
  describeEnvelopeUsage,
  envelopeLimitMessage,
  hasPlan,
  isControlPanelRequest,
  readPlanConfig,
  usageMonth,
} from "./plan.ts";

// GCM eSign plans: reading the plan from the environment. See plan.ts.

test("a site without plan settings has no limits and is active", () => {
  const plan = readPlanConfig({});

  assert.deepEqual(plan, {
    billingUrl: null,
    maxEnvelopesPerMonth: null,
    maxUsers: null,
    name: null,
    status: "active",
  });
  assert.equal(hasPlan(plan), false);
});

test("the plan's settings are read", () => {
  const plan = readPlanConfig({
    SIGNLY_BILLING_URL: "https://billing.example.com/acme",
    SIGNLY_MAX_ENVELOPES_PER_MONTH: "100",
    SIGNLY_MAX_USERS: " 10 ",
    SIGNLY_PLAN_NAME: "Starter",
    SIGNLY_SITE_STATUS: "Paused",
  });

  assert.deepEqual(plan, {
    billingUrl: "https://billing.example.com/acme",
    maxEnvelopesPerMonth: 100,
    maxUsers: 10,
    name: "Starter",
    status: "paused",
  });
  assert.equal(hasPlan(plan), true);
});

test("a limit of zero is a limit, and a value that is not a number is none", () => {
  const warn = console.warn;

  console.warn = () => undefined;

  try {
    assert.equal(
      readPlanConfig({ SIGNLY_MAX_ENVELOPES_PER_MONTH: "0" })
        .maxEnvelopesPerMonth,
      0,
    );

    for (const value of ["-1", "ten", "1.5", "1e3"]) {
      assert.equal(
        readPlanConfig({ SIGNLY_MAX_USERS: value }).maxUsers,
        null,
        value,
      );
    }

    assert.equal(
      readPlanConfig({ SIGNLY_SITE_STATUS: "suspended" }).status,
      "active",
    );
  } finally {
    console.warn = warn;
  }
});

test("only web addresses are kept as the billing link", () => {
  for (const value of [
    "javascript:alert(1)",
    "data:text/html,hi",
    "not a url",
  ]) {
    assert.equal(
      readPlanConfig({ SIGNLY_BILLING_URL: value }).billingUrl,
      null,
      value,
    );
  }
});

test("months are counted in UTC", () => {
  // 2026-11-30 23:30 in New York is already December in UTC.
  assert.equal(usageMonth(Date.UTC(2026, 11, 1, 4, 30) / 1000), "2026-12");
  assert.equal(usageMonth(Date.UTC(2026, 10, 30, 23, 59) / 1000), "2026-11");
});

test("usage reads as administrators expect", () => {
  assert.equal(
    describeEnvelopeUsage(23, 100),
    "23 of 100 envelopes this month",
  );
  assert.equal(describeEnvelopeUsage(1, null), "1 envelope this month");
  assert.match(envelopeLimitMessage(100), /sent 100 envelopes this month/);
});

test("the usage report needs SIGNLY_CONTROL_SECRET, and is shut without it", () => {
  const env = { SIGNLY_CONTROL_SECRET: "s3cret-for-the-control-panel" };

  assert.equal(
    isControlPanelRequest("Bearer s3cret-for-the-control-panel", env),
    true,
  );
  assert.equal(isControlPanelRequest("Bearer wrong", env), false);
  assert.equal(isControlPanelRequest(null, env), false);
  assert.equal(
    isControlPanelRequest("s3cret-for-the-control-panel", env),
    false,
  );
  assert.equal(isControlPanelRequest("Bearer anything", {}), false);
  assert.equal(isControlPanelRequest("Bearer ", {}), false);
});

test("the GCMESIGN_ names work, and win over the old SIGNLY_ ones", () => {
  const config = readPlanConfig({
    GCMESIGN_MAX_USERS: "5",
    GCMESIGN_SITE_STATUS: "paused",
    SIGNLY_MAX_USERS: "10",
    SIGNLY_PLAN_NAME: "Starter",
  });

  assert.equal(config.maxUsers, 5);
  assert.equal(config.status, "paused");
  assert.equal(config.name, "Starter");
});
