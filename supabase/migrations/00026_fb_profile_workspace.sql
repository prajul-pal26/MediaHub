-- One mutable working snapshot per selected Facebook candidate. Google Sheets
-- remains the durable report/export; this table avoids rewriting it after each
-- comment retry while a candidate is under review.
create table public.fb_profile_workspaces (
  org_id uuid not null references public.organizations(id) on delete cascade,
  brand_id uuid not null references public.brands(id) on delete cascade,
  profile_key text not null,
  profile_url text not null,
  pages jsonb not null,
  source jsonb,
  loaded_from_sheet_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (org_id, brand_id, profile_key)
);

alter table public.fb_profile_workspaces enable row level security;
revoke all on public.fb_profile_workspaces from anon, authenticated;
grant all on public.fb_profile_workspaces to service_role;
notify pgrst, 'reload schema';
