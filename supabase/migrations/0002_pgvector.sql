-- OPTIONAL growth path: pgvector nearest-neighbor search over brand logos.
-- Apply only when the logo index outgrows the client-side bundle (thousands of
-- brands). The client keeps working without this; the logo-search Edge
-- Function uses it when present.

create extension if not exists vector;

-- 512 dims = CLIP ViT-B/32 image embeddings (see src/pipeline/logo/embedder.ts).
alter table public.brand_logos
  add column if not exists embedding_vec vector(512);

-- Backfill from the jsonb column.
update public.brand_logos
set embedding_vec = (
  select array_agg(x)::vector(512)
  from jsonb_array_elements_text(embedding) as t(x)
)
where embedding_vec is null
  and jsonb_array_length(embedding) = 512;

create index if not exists brand_logos_vec_idx
  on public.brand_logos using hnsw (embedding_vec vector_cosine_ops);

-- Nearest brands for an embedding, scoped to the calling user's rows.
create or replace function public.match_brand_logos(
  query vector(512),
  match_count int default 3
)
returns table (name text, category text, score float)
language sql
security invoker
as $$
  select b.name, b.category,
         1 - (b.embedding_vec <=> query) as score
  from public.brand_logos b
  where b.user_id = auth.uid() and b.embedding_vec is not null
  order by b.embedding_vec <=> query
  limit match_count
$$;
