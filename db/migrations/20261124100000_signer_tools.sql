-- Signly: signer attachments and in-person signing.
--
-- fields.type 'attachment': a place where the signer uploads a file (a PDF
-- or a picture) while signing. Once they sign, the field's image_key names
-- the stored file and its value is the file's name, so everything that
-- already finds a field's stored file (deleting an envelope, the retention
-- sweep) finds attachments too.
--
-- signer_attachment_uploads: each file a signer has uploaded for one of
-- their attachment fields, before and after they sign. Signing picks one
-- upload per field; an upload that is replaced is deleted at once, and the
-- ones a signer did not use are deleted once they have signed. The size,
-- type and SHA-256 of the file used are kept here and in the signed audit
-- event.
--
-- signers.in_person: the sender hands their own device to this signer to
-- sign, instead of emailing them a link. No invitation or reminder is
-- emailed to them. signers.in_person_host_email and in_person_hosted_at
-- record who opened the current in-person session on their device, and
-- when; the signed audit event repeats them.
--
-- Safe for existing data: every row keeps working as before (in_person is
-- false for every signer until a sender ticks it, and no field is an
-- attachment until one is placed).

alter table public.fields
  drop constraint if exists fields_type_check;

alter table public.fields
  add constraint fields_type_check check (
    type in (
      'signature',
      'initials',
      'date',
      'name',
      'text',
      'checkbox',
      'number',
      'dropdown',
      'radio',
      'attachment'
    )
  );

create table if not exists public.signer_attachment_uploads (
  id text primary key,
  envelope_id text not null references public.envelopes(id) on delete cascade,
  signer_id text not null references public.signers(id) on delete cascade,
  field_id text not null references public.fields(id) on delete cascade,
  storage_key text not null unique,
  file_name text not null check (length(file_name) between 1 and 200),
  content_type text not null
    check (content_type in ('application/pdf', 'image/png', 'image/jpeg')),
  size_bytes integer not null check (size_bytes > 0),
  sha256 text not null check (length(sha256) = 64),
  created_at bigint not null
);

create index if not exists idx_signer_attachment_uploads_envelope
  on public.signer_attachment_uploads(envelope_id);

create index if not exists idx_signer_attachment_uploads_signer_field
  on public.signer_attachment_uploads(signer_id, field_id);

alter table public.signers
  add column if not exists in_person boolean not null default false,
  add column if not exists in_person_host_email text,
  add column if not exists in_person_hosted_at bigint;
