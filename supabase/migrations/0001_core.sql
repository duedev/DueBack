-- Reimbursements F5 — core schema for the optional cloud-sync layer.
-- Apply with:  supabase db push   (see SUPABASE_SETUP.md)
--
-- Every table is per-user with row-level security on user_id = auth.uid().
-- Rows carry the full client record as `payload` jsonb (the client is the
-- source of truth; reconciliation is last-write-wins on updated_at, in ms)
-- plus a few indexed columns for queries and Realtime filters.

-- ---- batches ---------------------------------------------------------------
create table if not exists public.batches (
  id         text primary key,
  user_id    uuid not null default auth.uid(),
  employee   text not null default '',
  job_name   text not null default '',
  job_number text not null default '',
  created_at bigint not null,
  updated_at bigint not null,
  payload    jsonb  not null
);

alter table public.batches enable row level security;

create policy "batches are private" on public.batches
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create index if not exists batches_user_idx on public.batches (user_id, updated_at desc);

-- ---- receipts --------------------------------------------------------------
create table if not exists public.receipts (
  id              text primary key,
  user_id         uuid not null default auth.uid(),
  batch_id        text not null,
  image_hash      text,
  status          text not null default 'queued',
  vendor          text not null default '',
  date            text not null default '',
  amount          numeric not null default 0,
  category        text not null default 'Other',
  approved        boolean not null default false,
  review_required boolean not null default false,
  logo_match      jsonb,
  created_at      bigint not null,
  updated_at      bigint not null,
  payload         jsonb  not null
);

alter table public.receipts enable row level security;

create policy "receipts are private" on public.receipts
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create index if not exists receipts_user_batch_idx on public.receipts (user_id, batch_id);
create index if not exists receipts_user_hash_idx  on public.receipts (user_id, image_hash);
create index if not exists receipts_user_upd_idx   on public.receipts (user_id, updated_at desc);

-- Realtime change feed for the live board on other devices.
alter publication supabase_realtime add table public.receipts;

-- ---- user-taught logo brands ----------------------------------------------
-- v1 stores the embedding as jsonb (a few hundred 512-d vectors — client-side
-- cosine is instant). Migration 0002 adds the pgvector growth path.
create table if not exists public.brand_logos (
  id         text primary key,
  user_id    uuid not null default auth.uid(),
  name       text not null,
  category   text not null default 'Other',
  embedding  jsonb not null,
  created_at bigint not null
);

alter table public.brand_logos enable row level security;

create policy "brand logos are private" on public.brand_logos
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---- storage: private per-user receipt images ------------------------------
insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', false)
on conflict (id) do nothing;

-- Objects live under <uid>/<blobKey>; owners get full access to their folder.
create policy "receipt images are private" on storage.objects
  for all
  using (
    bucket_id = 'receipts'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'receipts'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
