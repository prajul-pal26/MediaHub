-- One durable Google Sheet target is recorded on the local media workspace.
-- Every media row for the same profile points at the same verified Sheet;
-- repeat discoveries merge rows instead of producing another Drive file.
alter table public.insta_comment_media
  add column if not exists drive_sheet_id text,
  add column if not exists drive_sheet_url text,
  add column if not exists drive_synced_at timestamptz;

create index if not exists idx_icm_drive_sheet
  on public.insta_comment_media (org_id, target_username, drive_synced_at desc);
