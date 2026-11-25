-- Several documents in one envelope (Signly).
--
-- An envelope still has one source PDF. When the sender uploads more than
-- one file, the files are joined into that one PDF when the draft is made,
-- so signing, stamping, sealing, the certificate, verification and every
-- download keep working on one document. This column remembers what the
-- joined PDF was made of, so the builder, the signing page, the certificate
-- and the API can show each document by its own name:
--
--   documents: [{ "name": "Offer letter.pdf", "firstPage": 1,
--                 "pageCount": 3, "sizeBytes": 81234,
--                 "sha256": "<hex of the file as uploaded>" }, ...]
--
-- in the order the sender put them. Null (every envelope from before this
-- migration, and every envelope of one file) means the envelope is a single
-- document named by source_pdf_filename.
--
-- A template keeps the same list, so an envelope started from it is split
-- the same way.
--
-- Safe for existing data: both columns are new, nullable and left null. A
-- copy of the app from before this migration ignores them and shows a joined
-- envelope as one document.

alter table public.envelopes
  add column if not exists documents jsonb;

alter table public.envelopes
  drop constraint if exists envelopes_documents_check;

alter table public.envelopes
  add constraint envelopes_documents_check
    check (documents is null or jsonb_typeof(documents) = 'array');

alter table public.templates
  add column if not exists documents jsonb;

alter table public.templates
  drop constraint if exists templates_documents_check;

alter table public.templates
  add constraint templates_documents_check
    check (documents is null or jsonb_typeof(documents) = 'array');
