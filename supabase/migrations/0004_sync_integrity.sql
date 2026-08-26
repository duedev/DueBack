-- Sync integrity: tombstones, server-side last-write-wins, per-user keys.
--
-- * Tombstones — deletes used to never propagate (push only upserted, pull
--   re-inserted anything missing locally). A delete is now pushed as an
--   UPDATE setting deleted_at + updated_at to the local delete time, so a row
--   that was never pushed is a no-op; clients treat a tombstoned row as
--   "remove the local copy when newer", never as an insert. A genuinely newer
--   local edit revives the row (the upserts set deleted_at back to null).
-- * lww_guard — LWW was pull-only, so a stale device's full-table upsert
--   reverted newer cloud edits. A BEFORE UPDATE trigger skips any write whose
--   updated_at isn't strictly newer. Skipped rows return null (no error):
--   idempotent re-pushes and stale devices both no-op silently.
-- * (user_id, id) primary keys — with the bare-id PK, account B's first push
--   on a shared device collided with account A's rows and died on RLS. ids
--   are client-generated and globally unique, so no cross-user duplicates
--   exist and the swap is safe on live data; inserts fill user_id from its
--   auth.uid() default. Clients upsert with onConflict: 'user_id,id'.
-- * batches + brand_logos join the realtime publication — only receipts was
--   in it, so batch edits (per diem / phone service feed the workbook TOTAL)
--   stayed stale on other devices for the whole session.

-- ---- tombstones ------------------------------------------------------------
alter table public.batches     add column if not exists deleted_at timestamptz;
alter table public.receipts    add column if not exists deleted_at timestamptz;
alter table public.brand_logos add column if not exists deleted_at timestamptz;

-- brand_logos predates updated_at (brands are immutable once taught). The LWW
-- guard and tombstones need one: live pushes carry created_at here; a
-- tombstone carries the delete time, which is always newer.
alter table public.brand_logos add column if not exists updated_at bigint not null default 0;

-- ---- composite primary keys (user_id, id) ----------------------------------
alter table public.batches     drop constraint if exists batches_pkey;
alter table public.batches     add primary key (user_id, id);

alter table public.receipts    drop constraint if exists receipts_pkey;
alter table public.receipts    add primary key (user_id, id);

alter table public.brand_logos drop constraint if exists brand_logos_pkey;
alter table public.brand_logos add primary key (user_id, id);

-- ---- server-side LWW guard -------------------------------------------------
create or replace function public.lww_guard()
returns trigger
language plpgsql
as $$
begin
  -- Stale or idempotent: skip the write silently (supabase-js sees success).
  if new.updated_at is null or new.updated_at <= old.updated_at then
    return null;
  end if;
  return new;
end;
$$;

drop trigger if exists batches_lww on public.batches;
create trigger batches_lww before update on public.batches
  for each row execute function public.lww_guard();

drop trigger if exists receipts_lww on public.receipts;
create trigger receipts_lww before update on public.receipts
  for each row execute function public.lww_guard();

drop trigger if exists brand_logos_lww on public.brand_logos;
create trigger brand_logos_lww before update on public.brand_logos
  for each row execute function public.lww_guard();

-- ---- realtime change feed for batches + brands ------------------------------
do $$
begin
  alter publication supabase_realtime add table public.batches;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.brand_logos;
exception when duplicate_object then null;
end $$;
