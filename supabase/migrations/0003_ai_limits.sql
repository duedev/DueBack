-- ai-extract usage accounting: per-user daily request counts backing the Edge
-- Function's server-side rate limit (env AI_DAILY_LIMIT, default 200). The
-- client's spend cap is advisory — anyone with a session token can curl the
-- function — so the authoritative count lives here.
--
-- Service-role only: RLS is enabled with NO policies, so anon/authenticated
-- clients can neither read nor forge their counts; the Edge Function writes
-- through SUPABASE_SERVICE_ROLE_KEY (which bypasses RLS).

create table if not exists public.ai_usage (
  user_id  uuid not null,
  day      date not null default current_date,
  requests int  not null default 0,
  primary key (user_id, day)
);

alter table public.ai_usage enable row level security;

-- Atomic upsert-increment for today's count; returns the new total so the
-- function can compare it against the daily limit in one round trip.
create or replace function public.ai_increment_usage(p_user uuid)
returns int
language sql
security definer
set search_path = public
as $$
  insert into public.ai_usage as u (user_id, day, requests)
  values (p_user, current_date, 1)
  on conflict (user_id, day) do update set requests = u.requests + 1
  returning u.requests;
$$;

-- Service-role only, like the table it writes.
revoke execute on function public.ai_increment_usage(uuid) from public, anon, authenticated;
