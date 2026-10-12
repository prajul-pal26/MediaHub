-- Heartbeat is distinct from a Facebook validation or cookie update.
alter table public.fb_session_bridges add column last_contact_at timestamptz;
notify pgrst, 'reload schema';
