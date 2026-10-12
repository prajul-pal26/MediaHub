-- The account directory is shared by the Instagram and Facebook ID creators, but
-- an account created on Instagram is not yet created on Facebook. Track Facebook
-- progress independently so the Facebook ID Creator starts every profile as
-- 'pending' instead of inheriting the Instagram 'done' status.
alter table public.insta_profile_users
  add column if not exists facebook_status text not null default 'pending'
  check (facebook_status in ('pending', 'done'));
