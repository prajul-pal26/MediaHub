create table public.fb_profile_lists (
  org_id uuid not null references public.organizations(id) on delete cascade,
  brand_id uuid not null references public.brands(id) on delete cascade,
  source_file_id text not null,
  source_name text not null,
  imported_at timestamptz not null default now(),
  profiles jsonb not null check (jsonb_typeof(profiles) = 'array'),
  primary key (org_id, brand_id)
);
alter table public.fb_profile_lists enable row level security;
revoke all on public.fb_profile_lists from anon, authenticated;
grant all on public.fb_profile_lists to service_role;
notify pgrst, 'reload schema';
