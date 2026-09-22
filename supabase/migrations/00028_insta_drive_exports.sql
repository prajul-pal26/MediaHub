-- Pin the user-selected Drive brand to an Instagram harvest. The worker uses
-- this only after a run settles, so CSV export never delays comment paging.
alter table public.insta_comment_runs
  add column if not exists drive_brand_id uuid references public.brands(id) on delete set null,
  add column if not exists comment_limit integer not null default 0,
  add column if not exists drive_export_status text,
  add column if not exists drive_export_error text,
  add column if not exists drive_exported_at timestamptz;
