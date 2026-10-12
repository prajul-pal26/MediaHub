create table public.fb_profile_stats (
  org_id uuid not null references public.organizations(id) on delete cascade,
  brand_id uuid not null references public.brands(id) on delete cascade,
  profile_key text not null,
  photos_count integer not null default 0 check (photos_count >= 0),
  reels_count integer not null default 0 check (reels_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (org_id, brand_id, profile_key)
);
alter table public.fb_profile_stats enable row level security;
revoke all on public.fb_profile_stats from anon, authenticated;
grant all on public.fb_profile_stats to service_role;
notify pgrst, 'reload schema';
