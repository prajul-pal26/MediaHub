-- Local, organization-scoped cache of the user-provided Instagram account
-- directory. Contact details and passwords are application-encrypted before
-- insertion; the dashboard never reads this table directly from the browser.
create table if not exists public.insta_profile_users (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  source_sheet_id text not null,
  source_row_number integer not null check (source_row_number > 0),
  district text,
  insta_name text not null,
  email_encrypted text not null,
  password_encrypted text not null,
  status text not null default 'pending' check (status in ('pending', 'done')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, source_sheet_id, source_row_number)
);

create index if not exists idx_insta_profile_users_org_name
  on public.insta_profile_users (org_id, insta_name);

alter table public.insta_profile_users enable row level security;

drop policy if exists ipu_select_own_org on public.insta_profile_users;
create policy ipu_select_own_org on public.insta_profile_users
  for select using (org_id in (select org_id from public.users where id = auth.uid()));
