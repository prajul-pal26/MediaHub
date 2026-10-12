-- One revocable, account-pinned bridge per saved session. Never stores raw tokens.
create table public.fb_session_bridges (
  session_id uuid primary key references public.fb_sessions(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  expected_user text not null check (expected_user ~ '^[0-9]{1,40}$'),
  token_hash text not null unique,
  enabled boolean not null default true,
  expires_at timestamptz not null,
  status text not null default 'waiting' check (status in ('waiting','running','fresh','login_required','account_mismatch','error','stopped')),
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  run_id uuid,
  lease_until timestamptz,
  created_at timestamptz not null default now()
);
alter table public.fb_session_bridges enable row level security;
revoke all on public.fb_session_bridges from anon, authenticated;
grant all on public.fb_session_bridges to service_role;

-- Atomic cross-process lock, bounded frequency, and current owner/account checks.
create function public.fb_bridge_claim(p_hash text, p_run uuid)
returns setof public.fb_session_bridges language sql security definer set search_path = '' as $$
  update public.fb_session_bridges b set
    status = 'running', run_id = p_run, lease_until = now() + interval '90 seconds', last_attempt_at = now()
  where b.token_hash = p_hash and b.enabled and b.expires_at > now()
    and (b.lease_until is null or b.lease_until < now())
    and (b.last_attempt_at is null or b.last_attempt_at < now() - interval '60 seconds')
    and exists (select 1 from public.fb_sessions s where s.id = b.session_id and s.org_id = b.org_id and s.c_user = b.expected_user)
    and exists (select 1 from public.users u where u.id = b.user_id and u.org_id = b.org_id and u.role in ('super_admin','agency_admin'))
  returning b.*;
$$;

-- Commit cookies and successful validation together. Stop/re-pair/expiry fences
-- out in-flight work. Failed validation never overwrites the saved session.
create function public.fb_bridge_complete(p_hash text, p_run uuid, p_status text, p_encrypted text default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare b public.fb_session_bridges;
begin
  select * into b from public.fb_session_bridges where token_hash = p_hash for update;
  if not found or not b.enabled or b.expires_at <= now() or b.run_id is distinct from p_run
    or b.lease_until < now() then return false; end if;
  if p_status not in ('fresh','login_required','account_mismatch','error') then return false; end if;
  if not exists (select 1 from public.users u where u.id = b.user_id and u.org_id = b.org_id and u.role in ('super_admin','agency_admin')) then return false; end if;
  if p_status = 'fresh' then
    if p_encrypted is null then return false; end if;
    update public.fb_sessions set cookie_encrypted = p_encrypted, status = 'active', last_error = null, last_checked_at = now()
      where id = b.session_id and org_id = b.org_id and c_user = b.expected_user;
    if not found then return false; end if;
  end if;
  update public.fb_session_bridges set status = p_status,
    last_success_at = case when p_status = 'fresh' then now() else last_success_at end,
    run_id = null, lease_until = null where session_id = b.session_id;
  return true;
end;
$$;
revoke all on function public.fb_bridge_claim(text, uuid) from public, anon, authenticated;
revoke all on function public.fb_bridge_complete(text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.fb_bridge_claim(text, uuid) to service_role;
grant execute on function public.fb_bridge_complete(text, uuid, text, text) to service_role;
notify pgrst, 'reload schema';
