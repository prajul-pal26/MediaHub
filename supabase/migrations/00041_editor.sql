-- Editor: drafts, templates, sticker packs and a reusable audio library.
--
-- Drafts live here rather than in media_groups on purpose: media_groups.status is
-- already a publish-state machine ('available','scheduled','published','archived'),
-- media.list has no default status filter, and analytics already treats a 'draft'
-- status as publishable. A separate table keeps edits out of the Media Library
-- until the user explicitly transfers them.
--
-- Wrapped in a transaction because scripts/docker-init.sh runs psql without
-- ON_ERROR_STOP and records a migration as applied even when it errors.
begin;

-- ── Drafts ────────────────────────────────────────────────────────────────────
create table if not exists public.media_edits (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands(id) on delete cascade,
  source_asset_id uuid references public.media_assets(id) on delete set null,
  kind text not null check (kind in ('image', 'video')),
  title text not null default 'Untitled edit',
  doc jsonb not null default '{}'::jsonb,
  doc_version integer not null default 1,
  render_status text not null default 'idle'
    check (render_status in ('idle', 'queued', 'rendering', 'ready', 'failed')),
  render_error text,
  render_progress integer not null default 0,
  rendered_drive_file_id text,
  rendered_width integer,
  rendered_height integer,
  rendered_aspect_ratio text,
  rendered_duration_ms integer,
  rendered_file_size bigint,
  rendered_mime_type text,
  overlay_drive_file_id text,
  preview_thumb text,
  transferred_asset_id uuid references public.media_assets(id) on delete set null,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_media_edits_brand_created
  on public.media_edits (brand_id, created_at desc);
create index if not exists idx_media_edits_render_status
  on public.media_edits (render_status);

-- ── Templates (an edit document with base.assetId = null) ─────────────────────
create table if not exists public.editor_templates (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands(id) on delete cascade,
  name text not null,
  kind text not null default 'any' check (kind in ('image', 'video', 'any')),
  doc jsonb not null default '{}'::jsonb,
  doc_version integer not null default 1,
  thumb text,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_editor_templates_brand
  on public.editor_templates (brand_id, created_at desc);

-- ── Sticker packs ─────────────────────────────────────────────────────────────
create table if not exists public.sticker_packs (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands(id) on delete cascade,
  name text not null,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_sticker_packs_brand
  on public.sticker_packs (brand_id, created_at desc);

create table if not exists public.stickers (
  id uuid primary key default gen_random_uuid(),
  pack_id uuid not null references public.sticker_packs(id) on delete cascade,
  brand_id uuid not null references public.brands(id) on delete cascade,
  name text not null,
  drive_file_id text not null,
  mime_type text,
  width integer,
  height integer,
  aspect numeric(10, 6),
  file_size bigint,
  thumb text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_stickers_pack on public.stickers (pack_id, sort_order);
create index if not exists idx_stickers_brand on public.stickers (brand_id);

-- ── Reusable audio library ────────────────────────────────────────────────────
create table if not exists public.audio_tracks (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands(id) on delete cascade,
  name text not null,
  drive_file_id text not null,
  mime_type text,
  -- milliseconds: media_assets.duration_seconds is INTEGER and already rounded at
  -- upload, so trim/fade points can never be recovered from it.
  duration_ms integer,
  file_size bigint,
  is_default boolean not null default false,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_audio_tracks_brand
  on public.audio_tracks (brand_id, created_at desc);

-- ── RLS (defense in depth; tRPC assertBrandAccess is the real gate because the
--     server uses the service role, which bypasses RLS) ─────────────────────────
alter table public.media_edits enable row level security;
alter table public.editor_templates enable row level security;
alter table public.sticker_packs enable row level security;
alter table public.stickers enable row level security;
alter table public.audio_tracks enable row level security;

drop policy if exists media_edits_own_brand on public.media_edits;
create policy media_edits_own_brand on public.media_edits
  for all using (brand_id in (
    select b.id from public.brands b
    where b.org_id in (select org_id from public.users where id = auth.uid())
  ));

drop policy if exists editor_templates_own_brand on public.editor_templates;
create policy editor_templates_own_brand on public.editor_templates
  for all using (brand_id in (
    select b.id from public.brands b
    where b.org_id in (select org_id from public.users where id = auth.uid())
  ));

drop policy if exists sticker_packs_own_brand on public.sticker_packs;
create policy sticker_packs_own_brand on public.sticker_packs
  for all using (brand_id in (
    select b.id from public.brands b
    where b.org_id in (select org_id from public.users where id = auth.uid())
  ));

drop policy if exists stickers_own_brand on public.stickers;
create policy stickers_own_brand on public.stickers
  for all using (brand_id in (
    select b.id from public.brands b
    where b.org_id in (select org_id from public.users where id = auth.uid())
  ));

drop policy if exists audio_tracks_own_brand on public.audio_tracks;
create policy audio_tracks_own_brand on public.audio_tracks
  for all using (brand_id in (
    select b.id from public.brands b
    where b.org_id in (select org_id from public.users where id = auth.uid())
  ));

grant select, insert, update, delete on table public.media_edits
  to authenticator, authenticated, service_role;
grant select, insert, update, delete on table public.editor_templates
  to authenticator, authenticated, service_role;
grant select, insert, update, delete on table public.sticker_packs
  to authenticator, authenticated, service_role;
grant select, insert, update, delete on table public.stickers
  to authenticator, authenticated, service_role;
grant select, insert, update, delete on table public.audio_tracks
  to authenticator, authenticated, service_role;

commit;

notify pgrst, 'reload schema';
