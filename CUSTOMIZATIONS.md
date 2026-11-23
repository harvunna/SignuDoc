# Signly customizations

Signly (https://singly.globalcomputingmachines.com) is Global Computing
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

## Settings outside the code

These live in Vercel, Resend, Cloudflare and the app, not in this
repository. Recreate them if the install is ever rebuilt.

- Vercel project `signly` (team gcm23): Neon database, Resend integration,
  private Blob store `signly-blob` (`BLOB_READ_WRITE_TOKEN`), domain
  `singly.globalcomputingmachines.com`.
- Resend domain `globalcomputingmachines.com`; DNS records `send`, `rsend`,
  `resend._domainkey` and `_dmarc` in Cloudflare.
- App: Organization name "Signly", send-from
  `singly-notifications@globalcomputingmachines.com`, sign-up "Nobody",
  two-step sign-in required, API key "Signly", one webhook endpoint.

## Update check checklist (on the pull request's preview)

- [ ] Sign in works.
- [ ] Header and page titles say Signly; no "Powered by SignuDoc" in the footer.
- [ ] `/api/v1` shows the Swagger page titled "Signly API".
- [ ] `/api/v1/envelopes` without a key answers 401 `unauthorized`.
- [ ] New envelope: upload a PDF (Blob storage works).
- [ ] Settings > Email setup says "Email is working".
- [ ] Settings > Webhooks > Send test answers 200.
