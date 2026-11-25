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

### 2. Product name shown as GCM eSign

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
- `src/lib/api/openapi.ts`: `info.title` "GCM eSign API" and a GCM eSign
  description. `src/app/api/v1/route.ts`: the Swagger page title and header.
- The name in the header, page titles and emails comes from Settings >
  Organization > Organization name ("GCM eSign"), not from code.
- The default brand color is GCM navy `#1e3a8a` (`DEFAULT_BRAND_COLOR` and
  `DEFAULT_BRAND_PALETTE` in `src/lib/brand-color.ts`, the accent variables in
  `src/app/globals.css`, and `src/app/icon.svg`). Keep the three in step.
- Not renamed on purpose: the "Signly:" markers in code comments and test
  names. They only mark code added in this fork and are never shown.
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

### 4. Reports page (`/reports`)

A report of the envelopes sent in a period (last 7, 30 or 90 days, this
month, or a custom range, all in UTC): how many were sent, completed,
declined, voided, expired or are still waiting; the completion rate; the
median and average time to complete; a row per sender; and the open
envelopes waiting longest, with links. Downloadable as CSV.

- Whose envelopes: the dashboard's rules, reused (`sharesTeamCondition` in
  `src/lib/envelope-access.ts`). "My envelopes" for everyone; "My team"
  (own plus teammates' sent ones) for someone on a team; "Everyone" for an
  administrator only. Drafts are never counted.
- `src/lib/reports.ts`: period parsing, the three parameterized queries
  (totals, per sender, waiting longest) and the CSV (formula-safe, via
  `toCsv` from `src/lib/audit-export.ts`). Asking for "Everyone" without
  the admin role is refused in the library too, not only in the page.
- `src/app/(app)/reports/page.tsx` and `src/components/reports/reports-shell.tsx`:
  the page, drawn on the server. Choices are links and a GET form; the
  charts are HTML bars, so nothing needs a script beyond the CSP.
- `src/app/api/reports/envelopes/route.ts`: the CSV download. Signed-in
  session, rate limit (60 per 10 minutes). A file of team or everyone's
  envelopes is recorded in the install's audit trail as
  `envelope_file_downloaded` with `file: "envelope_report"`
  (label added in `src/components/settings/security-panel.tsx`).
- `src/components/layout/nav-items.tsx` and `app-shell.tsx`: "Reports" in
  the top navigation.
- `db/migrations/20261124090000_envelope_reports_index.sql`: an index on
  `envelopes.sent_at` (adds no data, safe on existing rows).
- Tests: `src/lib/reports.test.ts`, `src/lib/reports.dbtest.ts` (numbers and
  scoping).
- Risk: if SignuDoc changes the visibility rules in `envelope-access.ts` or
  `envelopes.ts`, check `reportScopeClause` in `src/lib/reports.ts` still
  matches them.

### 5. Several documents in one envelope

SignuDoc allows one PDF per envelope. Signly lets the sender upload up to 10
PDFs (20 MB and 1000 pages in total), put them in order and remove them
before continuing. When the draft is made, the files are joined into the
envelope's one source PDF, and a list of the original files (name, first
page, page count, size, SHA-256) is kept with the envelope. Fields, signing,
stamping, sealing, verification, downloads and webhooks are unchanged: they
work on that one PDF. The list is only used to show each document by name.
Joining drops interactive form fields, bookmarks and scripts of the
uploaded files; none of these is used by signing.

- New migration `db/migrations/20261124090000_envelope_documents.sql`:
  nullable `documents` jsonb on `envelopes` and `templates`. Null means one
  document (every envelope before this, and every single-file envelope).
- New `src/lib/services/document-combine.ts` (joins and checks the files),
  `src/lib/envelope-documents.ts` (reads the list; used by server and
  pages), and their tests `document-combine.test.ts`,
  `envelope-documents.test.ts`, `envelope-documents.dbtest.ts`.
- `src/lib/types/domain.ts`: `MAX_DOCUMENTS_PER_ENVELOPE` (10).
- `src/lib/services/document-import.ts`: messages for too many documents
  and too large together.
- `src/lib/schemas/envelope.ts`: `envelopeDocumentSchema`; optional
  `documents` on the envelope record. `src/lib/schemas/signing.ts`:
  optional `documents` in the signing payload.
- `src/lib/envelopes.ts`: `createDraftEnvelope` takes one PDF or several;
  the list is stored, copied with an envelope, read with it, and given to
  the builder (`PrepareEnvelopeData.documents`) and the review page.
- `src/lib/templates.ts`: a template keeps the list; envelopes started from
  it are split the same way; the list shows "3 documents, 12 pages".
- `src/lib/signing.ts`, `src/lib/downloads.ts`: read the list so the
  signing page and the certificate can show it.
- `src/lib/services/pdf-finalize.ts`: the certificate of completion lists
  each document with its pages and SHA-256 (the "Source PDF" line stays for
  one document).
- `src/app/api/envelopes/route.ts`: several `file` form parts, or
  `documents: [{ filename, uploadKey }]` for direct (Blob) uploads; the
  files are read one at a time and held to 20 MB together.
- `src/components/envelopes/upload-shell.tsx`: choose or drop several PDFs,
  reorder (up/down) and remove; each goes to Blob on its own when direct
  uploads are on, so the 4.5 MB request limit still does not apply.
- `src/components/envelopes/prepare-live-shell.tsx`,
  `src/components/signing/signing-live-shell.tsx`: the page bar names the
  document and page ("Offer.pdf, page 2 of 3") and a "Go to document" list
  jumps between documents; the signer's field list names the document.
- `src/components/envelopes/review-shell.tsx`: lists the documents.
- API: `src/app/api/v1/envelopes/route.ts` takes several `file` parts, or
  `uploads: [{ uploadId, filename }]` with JSON; one file works as before.
  `src/lib/api/envelopes.ts`: a field may give `document` (1-based) and
  then counts `page` within it. `src/lib/api/envelope-view.ts`: envelopes
  carry `documents`. `src/lib/api/route.ts`: "too large together" answers 413. `src/lib/api/openapi.ts` and `docs/api.md` describe all of this.
- Risk: SignuDoc changes to `createDraftEnvelope`, the envelope SELECTs or
  the upload page clash on update. Keep the rule: one source PDF per
  envelope; the list only names its parts.

### 6. Plan limits and paused sites

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

### 7. Signer tools: attachments, in-person signing, signer correction in the API

- **Signer attachments.** New field type `attachment`: the sender places it
  for a signer (required or optional); the signer uploads a PDF, PNG or
  JPEG of up to 4 MB while signing (the type is read from the file's bytes).
  - `db/migrations/20261124100000_signer_tools.sql`: `attachment` in
    `fields_type_check`; table `signer_attachment_uploads` (file name, type,
    size, SHA-256 of each upload); `signers.in_person`,
    `in_person_host_email`, `in_person_hosted_at` (below). Safe for existing
    rows: only adds.
  - `src/lib/signer-attachments.ts` (new): upload, replace, list, download.
    Files are stored privately beside the envelope's original
    (`.../attachments/`, `src/lib/services/storage-keys.ts`). A replaced
    upload, and uploads not used once the signer signs, go through the
    `pending_file_deletions` queue.
  - `src/lib/signing.ts`: the submission names an upload per field
    (`{type: "attachment", uploadId}`); checked under the signer's lock;
    the field keeps the file in `image_key` and its name in `value`; the
    signed audit event lists `attachments` (name, type, size, SHA-256);
    later signers see "File attached", not the name.
    `resolveSignerAttachmentTarget` (new export).
  - `src/lib/retention.ts`: deleting an envelope also deletes its attached
    files.
  - Routes: `POST /api/signing/[token]/attachments?fieldId=` (signer,
    rate-limited), `GET /api/envelopes/[id]/attachments/[fieldId]` (sender,
    teammates and administrators as for other files, recorded in the
    install audit log for non-owners), `GET
/api/v1/envelopes/{id}/attachments/{fieldId}` (API key, own envelopes).
    Downloads are served as attachments with `nosniff` and a sandbox CSP.
  - Envelope view: `src/lib/api/envelope-view.ts` (`attachments`),
    `src/lib/envelopes.ts` (`EnvelopeDetailData.attachments`),
    `src/components/envelopes/envelope-detail-shell.tsx` ("Attached by
    signers" with downloads).
  - Certificate: `src/lib/services/pdf-finalize.ts` lists each file with
    size and SHA-256 under the signer (name left out in the copy for
    signers); the field's box on the PDF says "Attached: name".
  - Editor and signing page: `prepare-live-shell.tsx` (Attachment tool),
    `review-shell.tsx`, `signing-live-shell.tsx` (file picker on the field).
  - Types and API: `src/lib/types/domain.ts`, `src/lib/schemas/field.ts`,
    `src/lib/schemas/signing.ts`, `src/lib/api/openapi.ts`, `docs/api.md`.
- **In-person signing.** A signer ticked "Signs in person" (signers step,
  or `inPerson` in the API) is never emailed an invitation or reminder.
  When it is their turn, the sender clicks "Sign in person" on the
  envelope's page: `POST /api/envelopes/[id]/signers/[signerId]/in-person`
  (`src/lib/in-person-signing.ts`, own envelopes only) issues a fresh
  two-hour link, records who hosted it, and opens the signing page on the
  sender's device. The signer still passes every check (access code,
  emailed code, consent). The signed audit event carries `inPerson`
  (host email and time); the timeline and certificate say "signed in
  person ... hosted by the sender".
  - Files: `src/lib/envelopes.ts` (save/copy the flag, send skips their
    invitation and goes out even when the whole first step signs in person,
    detail view), `src/lib/signing.ts` (next-step invitations skip them),
    `src/lib/reminders.ts` (no reminders), `src/lib/schemas/signer.ts`,
    `src/lib/api/envelopes.ts`, `src/components/envelopes/signers-shell.tsx`.
  - No new audit event kinds were added (the `signed` event's metadata
    holds the evidence), so the `audit_events_event_check` constraint is
    untouched.
- **Signer correction.** SignuDoc already corrects a waiting signer
  (migration `20261116100000_signer_corrected.sql`,
  `correctSentEnvelopeSigner`). Signly adds:
  `PATCH /api/v1/envelopes/{id}/signers/{signerId}` (same function, same
  `signer_corrected` event); an in-person signer's link is replaced with no
  email; a corrected signer's uploaded attachments are discarded.
- Tests: `src/lib/signer-tools.dbtest.ts`, `src/lib/signer-attachments.test.ts`.
- Risk: another change to `fields_type_check` (a new field type) must keep
  `attachment` in the list, or placing one fails.

### 8. Public site and search engines

- Setting `SIGNLY_PUBLIC_SITE=true` turns on a marketing site on that one
  install: a home page for visitors who are not signed in (`/`), and
  `/docusign-alternative`, `/esign-api` and `/security`. Without the setting
  those three answer 404 and `/` redirects to sign-in as before.
- `src/app/robots.ts` and `src/app/sitemap.ts`: on the public site they allow
  the public pages and list them; everywhere else robots disallows all and the
  sitemap is empty, so customer sites are never indexed.
- Words live in `src/lib/marketing-content.ts`; only claims the product backs
  up. Titles, descriptions, canonical address, share cards and JSON-LD come
  from `src/lib/marketing-metadata.ts` and the pages.
- Tests: `src/lib/public-site.test.ts`.

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
- [ ] Reports (top navigation) shows the last 30 days; a non-admin sees only
      "My envelopes" (and "My team" if on a team), an administrator also
      "Everyone"; Download CSV gives the same numbers.

- [ ] New envelope with two or three PDFs (one over 4 MB): reorder them,
      remove one, continue. The builder and the signing page name each
      document and "Go to document" jumps; sign fields in two documents; the
      certificate lists every document with its pages. A template saved from
      it says "N documents".

- [ ] Plan limits: with `SIGNLY_MAX_ENVELOPES_PER_MONTH` set to the sends
      so far plus one on the preview, one send works and the next is refused
      (402 `plan_limit_reached` from the API); Settings shows "N of M
      envelopes this month". With `SIGNLY_SITE_STATUS=paused` the banner shows
      and sending is refused (`site_paused`). `GET /api/internal/usage` with
      `Authorization: Bearer $SIGNLY_CONTROL_SECRET` returns JSON, 401 without.

- [ ] Signer tools: place an Attachment field and tick "Signs in person" for
      a second signer; the first signer attaches a PDF and signs; the
      envelope page lists it under "Attached by signers" and downloads it;
      "Sign in person" opens the signing page for the second signer; the
      certificate lists the file and "signed in person".

- [ ] Public site (only where `SIGNLY_PUBLIC_SITE=true`): `/` signed out shows
      the home page, signed in goes to the dashboard; `/robots.txt` lists the
      sitemap; `/sitemap.xml` lists four pages; the three landing pages open.
      Where it is not set: those pages answer 404 and robots disallows all.
