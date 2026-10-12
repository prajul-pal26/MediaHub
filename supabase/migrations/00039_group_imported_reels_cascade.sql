-- Clean up any orphaned records where media_group was deleted
delete from public.group_imported_reels where media_group_id is null;

-- Update foreign key to CASCADE on delete so deleting a media group
-- automatically removes the tracking row and makes the reel available for re-import
alter table public.group_imported_reels
  drop constraint if exists group_imported_reels_media_group_id_fkey;

alter table public.group_imported_reels
  add constraint group_imported_reels_media_group_id_fkey
  foreign key (media_group_id)
  references public.media_groups(id)
  on delete cascade;

notify pgrst, 'reload schema';
