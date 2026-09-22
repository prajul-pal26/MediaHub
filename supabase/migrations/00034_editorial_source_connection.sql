-- One organization-scoped, read-only external source connection for the
-- editorial evidence pool. The key is encrypted by the application before it
-- reaches this table and is never returned to clients.
create table if not exists public.editorial_source_connections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null unique references public.organizations(id) on delete cascade,
  source_name text not null default 'Quotizen News',
  base_url text not null,
  anon_key_encrypted text not null,
  active boolean not null default true,
  last_synced_at timestamptz,
  last_sync_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.editorial_source_connections enable row level security;
grant select, insert, update, delete on table public.editorial_source_connections
  to authenticator, authenticated, service_role;
notify pgrst, 'reload schema';
