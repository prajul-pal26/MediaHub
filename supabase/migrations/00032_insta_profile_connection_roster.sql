-- Credential-safe roster for the Accounts tracker. Using an RPC keeps the
-- tracker available even while a local PostgREST table cache is rebuilding.
create or replace function public.get_insta_profile_connection_roster(p_org_id uuid)
returns table (
  id uuid,
  district text,
  insta_name text,
  status text
)
language sql
security definer
set search_path = public
as $$
  select id, district, insta_name, status
  from public.insta_profile_users
  where org_id = p_org_id
  order by district asc nulls last, insta_name asc;
$$;

revoke all on function public.get_insta_profile_connection_roster(uuid) from public;
grant execute on function public.get_insta_profile_connection_roster(uuid) to authenticated, service_role, authenticator;

notify pgrst, 'reload schema';
