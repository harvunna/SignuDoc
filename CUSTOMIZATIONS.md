# Signly customizations

Signly (https://signly.globalcomputingmachines.com) is Global Computing
Machines' copy of [SignuDoc](https://github.com/NYLLON-SOFTWARE/SignuDoc)
(MIT licence, Copyright (c) 2026 Nyllon Software). Keep `LICENSE` and
`LICENSES/` as they are: the MIT licence requires the copyright notice to stay
with the code.

This file lists every change made on top of SignuDoc, so an update from
SignuDoc can be checked against them. Re-check each item after an update.

## How updates are taken

1. The **Update SignuDoc** workflow (`.github/workflows/update-signudoc.yml`)
   runs every Monday, or from Actions > Update SignuDoc > Run workflow. It
   merges the latest SignuDoc release into a branch and opens a pull request.
   Never use "Sync fork > Update branch" on `main`: it deploys to production
   at once, without a preview.
2. Vercel builds a preview of that pull request. Test it (checklist below)
   before merging.
3. Before merging an update that the changelog says changes the database,
   check that last night's backup ran (Vercel Blob store `signly-backup`,
   `database/` folder) or create a Neon branch of the production database.
4. Compare `.env.example` with the previous version. A new variable may be
   needed in Vercel (Settings > Environment Variables) before merging.
5. Merge. Vercel deploys to production and applies database migrations.
   If anything breaks: Vercel > Deployments > previous production deployment
   > Instant Rollback.

## If an update clashes with a change below

Take SignuDoc's new version of the file, then apply the Signly change again.
All changes here are small and text-only, except the Swagger page.

## The changes

### 1. Swagger UI API reference at `/api/v1`

- Added `src/app/api/v1/route.ts`: `GET /api/v1` returns a Swagger UI page
  built from `/api/v1/openapi.json`.
- Added `public/swagger-ui/` (Swagger UI 5.36.0, Apache-2.0, see its
  `LICENSE`). Served from this site because the Content-Security-Policy in
  `src/proxy.ts` only allows scripts from `'self'`.
- Risk: if SignuDoc adds its own handler at `src/app/api/v1/route.ts` or
  `src/app/api/v1/page.tsx`, the update clashes. Then move this page to
  `src/app/api/v1/docs/route.ts` (served at `/api/v1/docs`) and keep
  SignuDoc's.
- `eslint.config.mjs` and `.prettierignore` skip `public/swagger-ui/` (a vendored, minified
  bundle).
- To update Swagger UI: `npm pack swagger-ui-dist@5`, copy
  `swagger-ui-bundle.js`, `swagger-ui.css` and `LICENSE` into
  `public/swagger-ui/`. Check the bundle still has no `eval` (the CSP has no
  `'unsafe-eval'` in production).

### 2. Product name shown as Signly

Only text people see. Internal identifiers keep the SignuDoc name on purpose
(seal and secret key contexts such as `signudoc/seal-key/v1`, the
`signudoc:` embed message types, the API `realm`, the log `source`, the
database `application_name`): changing them would break existing seals,
two-step sign-in keys, sessions and integrations.

- `src/components/layout/public-legal-links.tsx`: removed the
  "Powered by SignuDoc" footer link (and its unused import).
- `src/app/electronic-signatures/page.tsx`: description reads
  "`${productName}` collects electronic signatures." instead of
  "... uses Signudoc to collect ...".
- `src/lib/permitted-uses.ts`: headings "What this e-signature service is"
  and "What this e-signature service is not".
- `src/lib/api/openapi.ts`: `info.title` "Signly API" and a Signly
  description.
- The name in the header, page titles and emails comes from Settings >
  Organization > Organization name ("Signly"), not from code.
- Not changed: the "SignuDoc" section of Settings (version and updates),
  shown to administrators only.

### 3. API keys for everyone, not only administrators

SignuDoc lets only administrators have API keys. In Signly anyone with an
account makes keys for themselves, and a key reaches only its owner's own
envelopes and templates (those queries were already per user).

- `src/lib/api-keys.ts`: `createApiKey` no longer requires the admin role;
  `revokeApiKey` lets an administrator revoke any key and anyone else only
  their own (another's key answers 404); new `listApiKeysForUser`;
  `authenticateApiKey` no longer refuses keys of non-administrators and
  returns `user.isAdmin`.
- `src/lib/api/envelopes.ts` (`ApiActor.isAdmin`) and `src/lib/api/route.ts`
  pass that flag to the routes.
- `src/app/api/v1/webhook-deliveries/route.ts`: 403 for a key whose owner is
  not an administrator, because deliveries cover every envelope.
- New `src/app/api/account/api-keys/route.ts` and `[id]/route.ts`: list,
  create and revoke your own keys (signed-in session).
- `src/components/settings/api-keys-panel.tsx`: `view="own"` for the new
  "My API keys" panel; links to `/api/v1` (Swagger).
- `src/app/(app)/settings/page.tsx`: shows "My API keys" to non-admins.
  Administrators keep the full list under Organization.
- `src/lib/api/openapi.ts` and `docs/api.md`: wording for the above.
- Tests: `src/lib/api-keys.dbtest.ts` (members' own keys);
  `src/lib/api/openapi.test.ts` skips `/api/v1` itself (the Swagger page).
- Unchanged: an administrator who loses the role still has their keys
  revoked.
- Risk: SignuDoc changes in any of these files clash on update. Keep the
  rules above: a key acts only as its owner, and nothing that lists the
  whole install answers a non-administrator's key.

### 4. Plan limits and paused sites

Signly is sold as one site per customer, set up by GCM's control panel. The
plan reaches the site as environment variables, all optional: unset means
no limit and an active site, so GCM's own site behaves as before.
`SIGNLY_PLAN_NAME`, `SIGNLY_MAX_ENVELOPES_PER_MONTH` (UTC calendar month,
every way of sending), `SIGNLY_MAX_USERS`, `SIGNLY_SITE_STATUS`
(`active` or `paused`), `SIGNLY_BILLING_URL`, and `SIGNLY_CONTROL_SECRET`
for the usage report.

- New `src/lib/plan.ts`: reads the plan; the paused and monthly-limit checks;
  the sign-up limit; the usage report; the control-panel secret check.
- New migration `db/migrations/20261124120000_monthly_send_usage.sql`: a
  per-month counter of sends (`monthly_send_usage`), filled from envelopes
  already sent. A counter rather than a count, so deleting an envelope does
  not give its place back.
- `src/lib/envelopes.ts`: `sendDraftEnvelope`, which every send path uses
  (web, bulk send, templates, API), refuses on a paused site or a used-up
  month (402) and takes the month's place inside the send transaction; a
  send whose first invitation fails gives it back. `EnvelopeMutationError`
  has an optional API `code`.
- `src/lib/bulk-send.ts`: refuses the whole list up front when paused or
  used up; if the limit is reached part-way, the remaining rows are not
  tried (and not saved, so confirming the batch again later sends them).
- `src/lib/api/http.ts`, `src/lib/api/route.ts`: new error codes
  `site_paused` and `plan_limit_reached` (402); a 402 does not keep the
  `Idempotency-Key`. `src/lib/api/openapi.ts` and `docs/api.md` document them.
- `src/lib/settings.ts` (`evaluateSignupRequest`): refuses a new account
  (`signup_user_limit`) once the site has `SIGNLY_MAX_USERS` accounts, for
  password sign-up and single sign-on alike.
  `src/components/auth/signup-shell.tsx` and `sso-button.tsx` show it.
- `src/components/layout/app-shell.tsx`, `src/app/(app)/layout.tsx`: a
  banner while the site is paused (billing link for administrators).
- New `src/components/settings/plan-panel.tsx`, shown by
  `src/app/(app)/settings/page.tsx` to administrators when a plan is set:
  plan name, "23 of 100 envelopes this month", accounts, upgrade link.
- New `src/app/api/internal/usage/route.ts`: `GET` usage report (JSON) for
  the control panel, bearer `SIGNLY_CONTROL_SECRET`; refuses everyone (401)
  when the secret is unset.
- `.env.example`: the new variables.
- Tests: `src/lib/plan.test.ts`, `src/lib/plan.dbtest.ts` (web, API,
  template and bulk sends limited; paused; racing sends; failed invitation
  gives its place back; usage report), `src/lib/setup.dbtest.ts` (account
  limit), `src/lib/api/route.dbtest.ts` (402 codes).
- Risk: SignuDoc changes to `sendDraftEnvelope`, bulk send or the sign-up
  rule clash on update. Keep the plan checks in `sendDraftEnvelope` so no
  send path bypasses them.

## Settings outside the code

These live in Vercel, Resend, Cloudflare and the app, not in this
repository. Recreate them if the install is ever rebuilt.

- Vercel project `signly` (team gcm23): Neon database, Resend integration,
  private Blob store `signly-blob` (`BLOB_READ_WRITE_TOKEN`), domain
  `signly.globalcomputingmachines.com`.
- Resend domain `globalcomputingmachines.com`; DNS records `send`, `rsend`,
  `resend._domainkey` and `_dmarc` in Cloudflare.
- App: Organization name "Signly", send-from
  `singly-notifications@globalcomputingmachines.com`, sign-up "People at my organization",
  two-step sign-in required, API key "Signly", one webhook endpoint. Sign-up domain globalcomputingmachines.com. Administrators: harvunna@gmail.com and harikrishna.vunnam@globalcomputingmachines.com. The old misspelled domain singly.globalcomputingmachines.com stays on the Vercel project as a 308 redirect to signly, and the Production variable APP_URL is set to https://signly.globalcomputingmachines.com so links and emails use the new address.

## Update check checklist (on the pull request's preview)

- [ ] Sign in works.
- [ ] Header and page titles say Signly; no "Powered by SignuDoc" in the footer.
- [ ] `/api/v1` shows the Swagger page titled "Signly API".
- [ ] `/api/v1/envelopes` without a key answers 401 `unauthorized`.
- [ ] A non-admin account sees "My API keys" in Settings; its key works in
      Swagger for `/me` and `/envelopes`, and gets 403 on `/webhook-deliveries`.
- [ ] New envelope: upload a PDF (Blob storage works).
- [ ] Settings > Email setup says "Email is working".
- [ ] Settings > Webhooks > Send test answers 200.
- [ ] Plan limits: with `SIGNLY_MAX_ENVELOPES_PER_MONTH` set to the sends
      so far plus one on the preview, one send works and the next is refused
      (402 `plan_limit_reached` from the API); Settings shows "N of M
      envelopes this month". With `SIGNLY_SITE_STATUS=paused` the banner shows
      and sending is refused (`site_paused`). `GET /api/internal/usage` with
      `Authorization: Bearer $SIGNLY_CONTROL_SECRET` returns JSON, 401 without.
