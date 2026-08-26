# Supabase setup (optional cloud sync)

The app is **local-first and complete without any backend** — this guide is only
for the optional sync layer: sign-in, multi-device batches, multi-user isolation,
and the server-keyed AI assist (no API key in the browser).

Everything is config-less until you provide two env vars; without them, every
sync surface stays hidden.

## 1. Create the project (~2 minutes)

1. Create a free project at [database.new](https://database.new).
2. In **Project Settings → API**, note:
   - the **Project URL** (e.g. `https://abcd1234.supabase.co`)
   - the **anon/public key**

## 2. Apply the schema

With the [Supabase CLI](https://supabase.com/docs/guides/cli):

```bash
supabase link --project-ref <your-project-ref>
supabase db push          # applies supabase/migrations/*.sql
```

(or paste the migration files into the dashboard's SQL editor, in order.)

This creates:
- `batches`, `receipts`, `brand_logos` — all with **row-level security**
  (`user_id = auth.uid()`), so each user only ever sees their own rows;
- the private `receipts` storage bucket with per-user folder policies;
- the Realtime feed on `receipts`, `batches`, and `brand_logos` (live board
  across devices);
- `ai_usage` (0003) — per-user daily AI request counts, service-role only;
  **`ai-extract` fails closed (503) until this is applied**;
- sync integrity (0004) — `deleted_at` tombstones, the `lww_guard` trigger
  (stale writes no-op server-side), and composite `(user_id, id)` keys.

`0002_pgvector.sql` is **optional** — the pgvector growth path for server-side
logo search. Skip it until you have thousands of taught brands.

## 3. Auth providers

In **Authentication → Providers**:
- **Email** (magic links) works out of the box.
- **Google**: add your OAuth client id/secret. Add your deployed origin (and
  any Carrd page that embeds the app) to the **redirect URLs**.

## 4. Edge Functions (the server-keyed AI assist)

```bash
supabase secrets set OPENROUTER_API_KEY=sk-or-...
supabase functions deploy ai-extract
supabase functions deploy logo-search    # optional (needs 0002)
```

`ai-extract` is a **policed** OpenAI-compatible proxy: signed-in users'
vision-assist calls route through it automatically, authenticated by their
session token — the OpenRouter key never reaches a browser. Server-side it
enforces a model allowlist, a `max_tokens` cap, and a per-user daily request
limit (backed by `ai_usage`, migration 0003). Optional secrets:

```bash
supabase secrets set AI_ALLOWED_MODELS=openrouter/free,google/gemini-2.5-flash
supabase secrets set AI_DAILY_LIMIT=200
```

Unset, the allowlist admits only the app's default free model and the daily
limit is 200 requests per user. A user who picks a non-default model in
Settings gets a 403 unless `AI_ALLOWED_MODELS` includes it.

## 5. Build the app with the keys

Set the two variables wherever the site is built:

```bash
VITE_SUPABASE_URL=https://abcd1234.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
```

For GitHub Pages, add them as **repository variables** (the deploy workflow
already forwards `vars.VITE_SUPABASE_URL` / `vars.VITE_SUPABASE_ANON_KEY`).

## Notes

- **Free-tier pause:** free projects pause after ~7 days without database
  activity; restore from the dashboard. The app keeps working locally during a
  pause — sync resumes on the next sign-in.
- **What syncs:** batches, receipts (full records), taught logo brands, and the
  original/cleaned receipt images (private storage). Reconciliation is
  last-write-wins per record on `updatedAt`.
- **Privacy:** nothing syncs until a user signs in. Anonymous use never touches
  the network beyond fetching the app itself (and the OCR/logo models).
