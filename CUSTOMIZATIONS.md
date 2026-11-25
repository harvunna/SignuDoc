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

### 4. Signer tools: attachments, in-person signing, signer correction in the API

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
- [ ] Signer tools: place an Attachment field and tick "Signs in person" for
      a second signer; the first signer attaches a PDF and signs; the
      envelope page lists it under "Attached by signers" and downloads it;
      "Sign in person" opens the signing page for the second signer; the
      certificate lists the file and "signed in person".
