-- Add photo synchronization tracking to insta_profile_users
alter table public.insta_profile_users 
  add column if not exists photo_status text not null default 'pending';

alter table public.insta_profile_users 
  add column if not exists photo_synced_at timestamptz;
