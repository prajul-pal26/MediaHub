-- The Editor sources its own media, not the Media Library.
--
-- 00041 modelled a draft's source as `media_edits.source_asset_id` -> a
-- `media_assets` row, which meant you could only edit something that was
-- ALREADY in the library.  That is backwards: library media is already
-- processed or published.  A draft now carries its own freshly uploaded
-- original (pasted or picked from disk), and only `transferToLibrary` ever
-- creates a `media_assets` row.
--
-- `source_asset_id` is kept, still nullable, so drafts created against a
-- library asset before this migration keep rendering.  New drafts set the
-- `source_*` columns instead; exactly one of the two is populated.
--
-- Explicit transaction: scripts/docker-init.sh runs psql without
-- ON_ERROR_STOP, so a half-applied file would otherwise be recorded as
-- applied.
begin;

alter table public.media_edits
  add column if not exists source_drive_file_id text,
  add column if not exists source_file_name     text,
  add column if not exists source_file_type     text,
  add column if not exists source_width         integer,
  add column if not exists source_height        integer,
  -- Milliseconds, not the seconds `media_assets.duration_seconds` stores: that
  -- column is INTEGER and already rounded at upload, so a trim point could
  -- never be recovered from it.
  add column if not exists source_duration_ms   integer,
  add column if not exists source_file_size     bigint;

comment on column public.media_edits.source_drive_file_id is
  'Drive file id of the original uploaded straight into the Editor. Lives in the brand''s Originals folder and has no media_assets row, so it never appears in the Media Library.';

-- Renders resolve a source by this column, so make that lookup indexed.
create index if not exists media_edits_source_drive_file_id_idx
  on public.media_edits (source_drive_file_id)
  where source_drive_file_id is not null;

notify pgrst, 'reload schema';

commit;
