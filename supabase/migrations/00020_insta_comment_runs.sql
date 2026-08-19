-- Instagram comment harvesting: run tracking + stored comments.
--
-- Harvests are long-running (minutes to days), so they execute in the BullMQ
-- worker and report progress back into insta_comment_runs. The dashboard polls
-- that row rather than holding a request open.

create table if not exists insta_comment_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references organizations(id) on delete cascade,
  user_id uuid references users(id) on delete set null,
  session_id uuid references insta_sessions(id) on delete set null,

  -- what was requested
  target_username text not null,
  target_user_id text,
  post_limit integer not null default 5,
  concurrency integer not null default 5,
  include_replies boolean not null default false,
  posts jsonb,                                  -- [{mediaId, shortcode, url, kind, commentCount}]

  status text not null default 'queued'
    check (status in ('queued', 'running', 'completed', 'partial', 'failed', 'cancelled')),

  -- results / live progress
  expected_comments integer not null default 0,
  total_comments integer not null default 0,
  coverage_pct numeric,
  request_count integer not null default 0,
  throttle_count integer not null default 0,
  throughput_per_sec numeric,
  current_pace_ms integer,
  progress jsonb,                               -- {perPost: {<mediaId>: n}, updatedAt}
  error text,
  duration_ms integer,

  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);

create index if not exists idx_icr_org on insta_comment_runs(org_id, created_at desc);
create index if not exists idx_icr_status on insta_comment_runs(status)
  where status in ('queued', 'running');
create index if not exists idx_icr_target on insta_comment_runs(org_id, target_username);

-- The harvested comments. One row per comment; can reach millions, so it is
-- indexed for the dashboard's access patterns (by run, by post, by commenter).
create table if not exists insta_comments (
  id bigserial primary key,
  run_id uuid not null references insta_comment_runs(id) on delete cascade,
  org_id uuid references organizations(id) on delete cascade,

  post_media_id text not null,
  post_shortcode text,

  comment_id text not null,
  comment_text text,
  comment_created_at timestamptz,
  comment_likes integer not null default 0,
  depth smallint not null default 0,
  parent_comment_id text,
  reply_count integer not null default 0,

  commenter_username text,
  commenter_full_name text,
  commenter_user_id text,
  commenter_verified boolean not null default false,

  -- Re-running a harvest must not duplicate rows within the same run.
  unique (run_id, comment_id)
);

create index if not exists idx_ic_run on insta_comments(run_id);
create index if not exists idx_ic_run_likes on insta_comments(run_id, comment_likes desc);
create index if not exists idx_ic_post on insta_comments(run_id, post_media_id);
create index if not exists idx_ic_commenter on insta_comments(org_id, commenter_username);

alter table insta_comment_runs enable row level security;
alter table insta_comments enable row level security;

drop policy if exists icr_select_own_org on insta_comment_runs;
create policy icr_select_own_org on insta_comment_runs
  for select using (org_id in (select org_id from users where id = auth.uid()));

drop policy if exists ic_select_own_org on insta_comments;
create policy ic_select_own_org on insta_comments
  for select using (org_id in (select org_id from users where id = auth.uid()));
