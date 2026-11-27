-- OAuth 2.0 authorization code flow (with PKCE) and refresh tokens, on top of
-- the clients and access tokens of 20261126100000_oauth_clients.sql.
--
-- An app that acts for other people registers a client with redirect URIs.
-- A person who signs in to GCM eSign is shown what the app asks for and
-- allows it; the app then gets a one-time code, trades it (with its PKCE
-- verifier) for an access token and a refresh token, and acts as that person.
--
-- * oauth_clients.redirect_uris: where a code may be sent, matched exactly.
-- * oauth_clients.is_public: an app that cannot keep a secret (a browser or
--   phone app). It has no secret and must use PKCE.
-- * oauth_tokens.user_id: whom the token acts as. For client credentials it
--   is the client's owner, as before; for a code it is the person who
--   allowed the app.
-- * oauth_tokens.family_id: ties access tokens to the refresh token chain
--   they came from, so a stolen, reused refresh token ends the whole chain.
-- * oauth_refresh_tokens: hashed, rotated on every use; used_at is kept until
--   expiry so a second use of one is noticed.
-- * oauth_authorization_codes: hashed, single use, valid for ten minutes.

alter table public.oauth_clients
  add column if not exists redirect_uris jsonb not null default '[]'::jsonb,
  add column if not exists is_public boolean not null default false;

alter table public.oauth_clients alter column secret_hash drop not null;
alter table public.oauth_clients
  drop constraint if exists oauth_clients_secret_hash_check;
alter table public.oauth_clients
  drop constraint if exists oauth_clients_secret_kind_check;
alter table public.oauth_clients
  add constraint oauth_clients_secret_kind_check check (
    (is_public and secret_hash is null)
    or (not is_public and length(secret_hash) = 64)
  );

alter table public.oauth_tokens
  add column if not exists user_id text
    references public."user"(id) on delete cascade,
  add column if not exists family_id text;

update public.oauth_tokens t
set user_id = c.user_id
from public.oauth_clients c
where c.id = t.oauth_client_id and t.user_id is null;

alter table public.oauth_tokens alter column user_id set not null;

create index if not exists oauth_tokens_user_id_idx
  on public.oauth_tokens (user_id);
create index if not exists oauth_tokens_family_id_idx
  on public.oauth_tokens (family_id);

create table if not exists public.oauth_refresh_tokens (
  token_hash text primary key check (length(token_hash) = 64),
  oauth_client_id text not null
    references public.oauth_clients(id) on delete cascade,
  user_id text not null references public."user"(id) on delete cascade,
  family_id text not null,
  scope text not null check (scope in ('read', 'write')),
  created_at bigint not null,
  expires_at bigint not null,
  used_at bigint
);

create index if not exists oauth_refresh_tokens_family_idx
  on public.oauth_refresh_tokens (family_id);
create index if not exists oauth_refresh_tokens_user_idx
  on public.oauth_refresh_tokens (user_id);
create index if not exists oauth_refresh_tokens_client_idx
  on public.oauth_refresh_tokens (oauth_client_id);
create index if not exists oauth_refresh_tokens_expires_at_idx
  on public.oauth_refresh_tokens (expires_at);

create table if not exists public.oauth_authorization_codes (
  code_hash text primary key check (length(code_hash) = 64),
  oauth_client_id text not null
    references public.oauth_clients(id) on delete cascade,
  user_id text not null references public."user"(id) on delete cascade,
  redirect_uri text not null,
  scope text not null check (scope in ('read', 'write')),
  code_challenge text not null,
  created_at bigint not null,
  expires_at bigint not null
);

create index if not exists oauth_authorization_codes_expires_at_idx
  on public.oauth_authorization_codes (expires_at);
