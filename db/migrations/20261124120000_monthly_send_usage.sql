-- Signly plans: how many envelopes this site has sent in each calendar
-- month (UTC), for SIGNLY_MAX_ENVELOPES_PER_MONTH. See src/lib/plan.ts.
--
-- A counter of its own, not a count of envelopes: an envelope that is
-- deleted later (by its sender, or by the retention rules) was still sent,
-- and must not hand its place in the month back. The send takes the
-- month's row in the same transaction that marks the envelope sent, so two
-- sends at the same moment cannot both take the last place.
--
-- * month: 'YYYY-MM', in UTC.
-- * envelopes_sent: sends that went out that month. A send whose first
--   invitation fails goes back to being a draft and gives its place back.

create table if not exists public.monthly_send_usage (
  month text primary key check (month ~ '^[0-9]{4}-[0-9]{2}$'),
  envelopes_sent integer not null default 0 check (envelopes_sent >= 0),
  updated_at bigint not null
);

-- Envelopes sent before this table existed, so the month this is deployed
-- in starts from what was really sent. Months that already have a row are
-- left alone, which makes running this again harmless.
insert into public.monthly_send_usage (month, envelopes_sent, updated_at)
select
  to_char(to_timestamp(sent_at) at time zone 'UTC', 'YYYY-MM'),
  count(*)::integer,
  extract(epoch from now())::bigint
from public.envelopes
where sent_at is not null
  and status <> 'draft'
group by 1
on conflict (month) do nothing;
