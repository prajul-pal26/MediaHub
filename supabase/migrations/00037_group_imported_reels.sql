-- Track reels imported from Instagram group chat (Joint Janta Party) into the brand's Media Library
create table if not exists public.group_imported_reels (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid references public.brands(id) on delete cascade not null,
  group_thread_id text not null,
  message_id text not null,
  shortcode text not null,
  media_group_id uuid references public.media_groups(id) on delete set null,
  imported_by uuid references public.users(id) on delete set null,
  reel_metadata jsonb default '{}'::jsonb,
  imported_at timestamptz not null default now(),
  constraint uq_group_imported_reels_brand_shortcode unique (brand_id, shortcode)
);

create index if not exists idx_group_imported_reels_brand on public.group_imported_reels(brand_id);
create index if not exists idx_group_imported_reels_shortcode on public.group_imported_reels(shortcode);
create index if not exists idx_group_imported_reels_thread on public.group_imported_reels(group_thread_id);

-- PostgREST grants
grant select, insert, update, delete on table public.group_imported_reels to anon, authenticated, service_role, authenticator;

notify pgrst, 'reload schema';
