-- Durable cache for Instagram group reels so the feed remains accessible
-- even when sessions temporarily encounter rate-limits or checkpoints.
create table if not exists public.group_cached_reels (
  id uuid primary key default gen_random_uuid(),
  group_thread_id text not null,
  message_id text not null,
  shortcode text not null,
  timestamp_ms bigint not null,
  sender_user_id text not null,
  sender_username text not null,
  sender_full_name text default '',
  sender_profile_pic text,
  creator_username text not null,
  creator_full_name text default '',
  creator_profile_pic text,
  creator_is_verified boolean default false,
  caption text default '',
  hashtags jsonb default '[]'::jsonb,
  duration numeric default 0,
  video_url text not null,
  thumbnail_url text,
  dimensions jsonb default '{"width": 1080, "height": 1920}'::jsonb,
  view_count bigint,
  like_count bigint,
  comment_count bigint,
  raw_payload jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint uq_group_cached_reels_thread_shortcode unique (group_thread_id, shortcode)
);

create index if not exists idx_group_cached_reels_thread on public.group_cached_reels(group_thread_id);
create index if not exists idx_group_cached_reels_shortcode on public.group_cached_reels(shortcode);
create index if not exists idx_group_cached_reels_time on public.group_cached_reels(timestamp_ms desc);

grant select, insert, update, delete on table public.group_cached_reels to anon, authenticated, service_role, authenticator;

notify pgrst, 'reload schema';
