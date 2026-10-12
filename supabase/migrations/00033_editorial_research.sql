-- Evidence-first local editorial research. This table intentionally stores review
-- decisions and source links, not account targeting or publishing instructions.
create table if not exists public.editorial_research_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  source_type text not null check (source_type in ('news', 'social_post', 'manual')),
  source_name text not null,
  source_url text not null,
  headline text not null,
  summary text,
  district text,
  topic text,
  published_at timestamptz,
  evidence_status text not null default 'needs_review' check (evidence_status in ('needs_review', 'supported', 'needs_context', 'rejected')),
  relevance text not null default 'unreviewed' check (relevance in ('unreviewed', 'relevant', 'not_relevant')),
  reviewer_note text,
  reviewed_by uuid references public.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_editorial_research_org_created
  on public.editorial_research_items (org_id, created_at desc);
create index if not exists idx_editorial_research_org_district
  on public.editorial_research_items (org_id, district);

alter table public.editorial_research_items enable row level security;
drop policy if exists editorial_research_select_own_org on public.editorial_research_items;
create policy editorial_research_select_own_org on public.editorial_research_items
  for select using (org_id in (select org_id from public.users where id = auth.uid()));

grant select, insert, update, delete on table public.editorial_research_items
  to authenticator, authenticated, service_role;
notify pgrst, 'reload schema';
