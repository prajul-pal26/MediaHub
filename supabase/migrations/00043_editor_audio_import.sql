-- Import a track's audio from an Instagram reel/post into the brand's audio
-- library.
--
-- Unlike an upload, this cannot be done in one request: the bytes have to be
-- fetched from Instagram and transcoded, and ffmpeg/ffprobe exist only in the
-- `worker` and `dev` images — never in the production `app` image (see the
-- Dockerfile stages). So the row is created by the tRPC mutation BEFORE its
-- Drive file exists, a worker job fills it in, and these columns are what the
-- Music panel reads to show the user that it is working or that it failed.
--
-- Explicit transaction: scripts/docker-init.sh runs psql WITHOUT ON_ERROR_STOP
-- and records a migration as applied even when it errored, so without this a
-- half-applied file would be invisible and never retried.
begin;

alter table public.audio_tracks
  add column if not exists import_status text not null default 'ready',
  add column if not exists import_error  text,
  add column if not exists source_url    text;

-- 'ready' as the default is what keeps every pre-existing row valid with no
-- backfill: all of them are uploaded files whose bytes are already in Drive.
alter table public.audio_tracks
  drop constraint if exists audio_tracks_import_status_check;
alter table public.audio_tracks
  add constraint audio_tracks_import_status_check
  check (import_status in ('ready', 'importing', 'failed'));

-- An 'importing' row has no Drive file yet, and a 'failed' one never will, so
-- the column has to become nullable. The constraint that follows keeps the
-- original NOT NULL guarantee exactly where it mattered: a track the editor
-- will play or hand to ffmpeg must still have bytes behind it. Without it,
-- `resolveAudioTrack` in worker.ts and `findEditorAsset` in
-- /api/editor/asset/[id] would be the only things standing between a
-- half-imported row and a render.
alter table public.audio_tracks
  alter column drive_file_id drop not null;

alter table public.audio_tracks
  drop constraint if exists audio_tracks_ready_has_drive_file;
alter table public.audio_tracks
  add constraint audio_tracks_ready_has_drive_file
  check (import_status <> 'ready' or drive_file_id is not null);

comment on column public.audio_tracks.import_status is
  'ready = the Drive file exists and the track is playable; importing = a worker job is fetching and extracting it; failed = see import_error.';
comment on column public.audio_tracks.import_error is
  'Why the import failed, shown verbatim in the Music panel. Null unless import_status = ''failed''.';
comment on column public.audio_tracks.source_url is
  'Canonical Instagram reel/post URL the audio was extracted from; null for an uploaded file. Audio taken from someone else''s post carries the original rights.';

-- The Music panel polls `listAudio` while any row is still importing, so the
-- "is anything unfinished for this brand" question is worth an index. Partial,
-- because the steady state is that every row is 'ready' and the index is empty.
create index if not exists idx_audio_tracks_importing
  on public.audio_tracks (brand_id)
  where import_status <> 'ready';

notify pgrst, 'reload schema';

commit;
