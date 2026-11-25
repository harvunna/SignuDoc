-- Reports (src/lib/reports.ts) count the envelopes sent in a period, so
-- they look envelopes up by when they were sent. Across the whole install,
-- for an administrator, that is a range read on sent_at. One's own
-- envelopes are found through idx_envelopes_user_created_at as before.
--
-- Drafts have no sent_at and are left out of the index.

create index if not exists idx_envelopes_sent_at
  on public.envelopes(sent_at)
  where sent_at is not null;
