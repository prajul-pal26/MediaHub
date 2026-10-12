create table public.fb_custom_profiles (
 org_id uuid not null references public.organizations(id) on delete cascade,
 brand_id uuid not null references public.brands(id) on delete cascade,
 url text not null,
 name text not null,
 created_at timestamptz not null default now(),
 primary key(org_id,brand_id,url)
);
alter table public.fb_custom_profiles enable row level security;
revoke all on public.fb_custom_profiles from anon, authenticated;
grant all on public.fb_custom_profiles to service_role;
notify pgrst, 'reload schema';
