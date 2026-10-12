alter table public.editorial_research_items
  add column if not exists external_source_key text;

create unique index if not exists editorial_research_items_org_external_source_key_key
  on public.editorial_research_items (org_id, external_source_key)
  where external_source_key is not null;

notify pgrst, 'reload schema';
