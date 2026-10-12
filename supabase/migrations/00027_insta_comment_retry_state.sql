-- Keep Instagram's durable per-post collection state beside the existing run.
-- Retrying selected media reuses that run, so comment IDs already checkpointed
-- remain available and fresh results merge without creating a second dataset.
alter table public.insta_comment_runs
  add column if not exists retry_media_ids jsonb;

-- Canonical Instagram media-comment workspace. `insta_comment_runs` remains
-- the audit/history stream; this table is the current merged state used by
-- delta calculation and per-post retries, equivalent to the Facebook local
-- candidate workspace.
create table if not exists public.insta_comment_media (
  id bigserial primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  target_username text not null,
  media_id text not null,
  shortcode text,
  media_url text,
  media_kind text,
  likes_count integer,
  comments_count_reported integer,
  comments_scraped_count integer not null default 0,
  comments_top_level_count integer not null default 0,
  comments_reply_count integer not null default 0,
  comments_status text not null default 'pending'
    check (comments_status in ('pending', 'running', 'complete', 'partial', 'failed', 'cancelled')),
  comments_stop_reason text,
  comments_error text,
  comments_json jsonb not null default '[]'::jsonb,
  last_run_id uuid references insta_comment_runs(id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (org_id, target_username, media_id)
);

create index if not exists idx_icm_profile on public.insta_comment_media (org_id, target_username, updated_at desc);
create index if not exists idx_icm_delta on public.insta_comment_media (org_id, target_username, comments_count_reported, comments_scraped_count);

alter table public.insta_comment_media enable row level security;
drop policy if exists icm_select_own_org on public.insta_comment_media;
create policy icm_select_own_org on public.insta_comment_media
  for select using (org_id in (select org_id from users where id = auth.uid()));
