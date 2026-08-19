-- Persisted Facebook scrape runs.
--
-- Every scrape writes one row so results survive a page refresh, can be
-- re-exported without re-hitting Facebook (each hit costs session risk), and
-- give a usage trail per org.

create table if not exists fb_scrape_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references organizations(id) on delete cascade,
  user_id uuid references users(id) on delete set null,
  session_id uuid references fb_sessions(id) on delete set null,

  -- what was asked for
  kind text not null check (kind in ('posts', 'comments', 'profile', 'group', 'reactors')),
  target text not null,                     -- the raw string the user pasted
  target_kind text,                         -- page | profile | group | post
  target_handle text,
  method text not null default 'auto' check (method in ('auto', 'mbasic', 'graphql', 'browser')),

  -- what came back
  status text not null default 'ok' check (status in ('ok', 'partial', 'failed')),
  source text,                              -- method that actually produced the data
  item_count integer not null default 0,
  payload jsonb,                            -- the scraped records
  attempts jsonb,                           -- per-method attempt log (timings, errors)
  error text,
  duration_ms integer,

  created_at timestamptz not null default now()
);

create index if not exists idx_fb_scrape_runs_org on fb_scrape_runs(org_id, created_at desc);
create index if not exists idx_fb_scrape_runs_kind on fb_scrape_runs(org_id, kind, created_at desc);
create index if not exists idx_fb_scrape_runs_target on fb_scrape_runs(org_id, target_handle);

alter table fb_scrape_runs enable row level security;

-- Members read their own org's runs; writes go through the service role in tRPC.
drop policy if exists fb_scrape_runs_select_own_org on fb_scrape_runs;
create policy fb_scrape_runs_select_own_org on fb_scrape_runs
  for select
  using (org_id in (select org_id from users where id = auth.uid()));
