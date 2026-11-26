-- OAuth 2.0 for the public API (/api/v1): the client credentials grant.
--
-- An account registers a client in Settings and sees its secret once. The
-- client trades its id and secret at POST /api/oauth/token for a short-lived
-- access token and sends that as "Authorization: Bearer sdo_…", the same way
-- an API key is sent. Like an API key, a client acts as the account that
-- registered it. Only SHA-256 hashes of secrets and tokens are kept, so a
-- copy of the database cannot be used to call the API.
--
-- * client_id: public, sent with the secret to get a token.
-- * secret_hash: SHA-256 of the client secret (256 random bits).
-- * scope: the most a token for this client may have. 'read' may only
--   look; 'write' may also create, send and void.
-- * oauth_tokens.scope: what one token was issued for, never above the
--   client's scope.
-- * expires_at, created_at, last_used_at, revoked_at: seconds.
--   A revoked client's tokens stop working at once.

create table if not exists public.oauth_clients (
  id text primary key,
  user_id text not null references public."user"(id) on delete cascade,
  name text not null check (length(name) between 1 and 80),
  client_id text not null unique,
  secret_hash text not null check (length(secret_hash) = 64),
  scope text not null check (scope in ('read', 'write')),
  created_at bigint not null,
  last_used_at bigint,
  revoked_at bigint
);

create index if not exists oauth_clients_user_id_idx
  on public.oauth_clients (user_id);

create table if not exists public.oauth_tokens (
  token_hash text primary key check (length(token_hash) = 64),
  oauth_client_id text not null
    references public.oauth_clients(id) on delete cascade,
  scope text not null check (scope in ('read', 'write')),
  created_at bigint not null,
  expires_at bigint not null
);

create index if not exists oauth_tokens_client_idx
  on public.oauth_tokens (oauth_client_id);

create index if not exists oauth_tokens_expires_at_idx
  on public.oauth_tokens (expires_at);
