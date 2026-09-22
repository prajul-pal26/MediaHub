-- PostgREST builds its schema cache through the local gateway role. Keep this
-- explicit so the encrypted Instagram profile directory is visible to the
-- application API after a fresh local database bootstrap as well.
grant select, insert, update, delete on table public.insta_profile_users to authenticator;

notify pgrst, 'reload schema';
