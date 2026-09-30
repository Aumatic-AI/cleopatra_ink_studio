-- ============================================================
-- CLEOPATRA INK STUDIO — Supabase Schema (v3 — Single Source of Truth)
-- Run this in the Supabase SQL Editor for a fresh install.
-- This matches the current live database exactly.
-- ============================================================

-- ── Extensions ──────────────────────────────────────────────
create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";

-- ── Drop existing tables (clean slate, reverse FK order) ────
drop table if exists user_preferences cascade;
drop table if exists placements       cascade;
drop table if exists chat_messages    cascade;
drop table if exists tattoo_designs   cascade;
drop table if exists sessions         cascade;
drop table if exists staff            cascade;
drop table if exists users            cascade;

-- Drop existing functions
drop function if exists finalize_session(text, uuid, uuid);
drop function if exists finalize_rework_session(text, uuid);
drop function if exists is_admin();
drop function if exists is_designer();
drop function if exists get_staff_role();

-- ── 1. STAFF ────────────────────────────────────────────────
-- Linked 1:1 to Supabase Auth (auth.users).
-- Role: 'admin' | 'designer'. last_login used for 24hr session timeout.
create table staff (
  id          uuid        primary key references auth.users(id) on delete cascade,
  email       text        not null unique,
  name        text        not null,
  role        text        not null default 'designer'
                check (role in ('admin', 'designer')),
  is_active   boolean     not null default true,
  last_login  timestamptz,
  deleted_at  timestamptz,
  -- Last time this admin opened the "Recently Deleted" tab — powers its
  -- unread-count badge and the per-row "new" highlight. Null means never
  -- viewed (everything in the trash counts as new). Irrelevant for designers.
  trash_last_viewed_at timestamptz,
  created_at  timestamptz not null default now()
);

comment on table staff is 'Studio staff (designers + admin). Auth via Supabase Auth email+password. last_login enforces 24hr session timeout in middleware. deleted_at is a soft-delete marker — non-null means hidden from admin list and blocked from logging in; the row is kept so historical sessions still resolve "designed by X". trash_last_viewed_at tracks when this admin last opened Recently Deleted.';

-- ── 2. USERS (customers) ────────────────────────────────────
-- Phone-based identification only. No login for customers.
create table users (
  id          uuid        primary key default uuid_generate_v4(),
  first_name  text        not null,
  phone       text        not null unique,
  created_at  timestamptz not null default now()
);

comment on table users is 'Customer accounts. Identified by phone number. No auth — staff acts on their behalf.';

-- ── 3. SESSIONS ─────────────────────────────────────────────
-- One session = one tattoo design journey.
-- designer_id tracks which staff member handled it.
-- Finalize keeps every generated variation — nothing is pruned there.
-- "Deleting" a session from the UI (admin or designer) only sets deleted_at
-- (soft-delete, same idiom as staff.deleted_at above): hidden from staff
-- lists, data kept. A soft-deleted session is recoverable from the admin's
-- "Recently Deleted" tab for 30 days, from which an admin can restore it or
-- permanently (hard) delete it early — see the PURGE JOB section near the
-- end of this file for what happens if 30 days pass with no action.
create table sessions (
  id                     text        primary key,
  user_id                uuid        references users(id) on delete set null,
  designer_id            uuid        references staff(id) on delete set null,
  tattoo_style           text,
  tattoo_description     text,
  target_body_area       text,
  flow_type              text        not null default 'ai_design'
                           check (flow_type in ('ai_design', 'rework', 'direct')),
  rework_source_photo_url text,
  rework_mode            text        check (rework_mode in ('cover', 'extend')),
  status                 text        not null default 'active'
                           check (status in ('active', 'completed', 'abandoned')),
  created_at             timestamptz not null default now(),
  completed_at           timestamptz,
  deleted_at             timestamptz
);

create index on sessions(user_id);
create index on sessions(designer_id);
create index on sessions(status);
create index on sessions(created_at);
-- Partial index — only rows actually in the trash need to be found fast by
-- the Recently Deleted list and the purge job; everything else skips it.
create index on sessions(deleted_at) where deleted_at is not null;

comment on table sessions is 'One row per tattoo design session. Nothing is ever auto-deleted; deleted_at is a soft-delete marker that only hides a session from staff lists.';

-- ── 4. TATTOO DESIGNS ───────────────────────────────────────
-- All generated variants stored. Non-finalized rows pruned on session completion.
create table tattoo_designs (
  id                uuid        primary key default uuid_generate_v4(),
  session_id        text        not null references sessions(id) on delete cascade,
  image_url         text        not null,
  style_name        text,
  pattern_type      text,
  iteration         int         not null default 1,
  is_finalized      boolean     not null default false,
  -- Chat-thread lineage: which prior design(s) this was edited from (empty for
  -- an original generation batch), and the instruction that produced it (null
  -- for an original batch — its "message" is the session's own description).
  parent_design_ids uuid[]      not null default '{}',
  user_instruction  text,
  -- Flash/sticker version — the tattoo isolated onto a plain white
  -- background, no skin/body. Generated once a design is finalized, cached
  -- here so re-opening the session later doesn't regenerate it again.
  flash_image_url   text,
  -- Which image model produced this design ('nano-banana-pro' |
  -- 'gpt-image-2-image-to-image') — null for designs with no generation
  -- (Upload Existing). Shown as a small tag in Chat.
  generation_model  text,
  created_at        timestamptz not null default now()
);

create index on tattoo_designs(session_id);
create index on tattoo_designs(session_id, is_finalized);

comment on table tattoo_designs is 'Generated tattoo variants. is_finalized=true = customer approved; only one row per session can be true at a time. Every variation is kept — nothing is pruned on finalize.';

-- ── 4b. CHAT MESSAGES ────────────────────────────────────────
-- The chat screen's source of truth for what to render — one row per turn.
-- A 'user' row is written the moment Send is clicked (before generation even
-- starts), so it survives a reload even if generation never completes. An
-- 'assistant' row is created empty alongside it and image_urls/design_ids
-- grow in place as each result finishes — a reload mid-generation still
-- shows whatever's already landed, and (with the in-memory job tracker)
-- keeps appending to this same row once the client resumes polling.
create table chat_messages (
  id           uuid        primary key default uuid_generate_v4(),
  session_id   text        not null references sessions(id) on delete cascade,
  role         text        not null check (role in ('user', 'assistant')),
  content      text,
  image_urls   text[]      not null default '{}',
  design_ids   uuid[]      not null default '{}',
  created_at   timestamptz not null default now()
);

create index on chat_messages(session_id, created_at);

comment on table chat_messages is 'Chat screen transcript — one row per turn. image_urls/design_ids on an assistant row are parallel arrays (same index = same image).';

-- ── 5. PLACEMENTS ───────────────────────────────────────────
-- Multiple placement attempts per session. Only finalized row survives completion.
create table placements (
  id                  uuid        primary key default uuid_generate_v4(),
  session_id          text        not null references sessions(id) on delete cascade,
  placement_text      text,
  body_photo_url      text,
  final_composite_url text,
  is_finalized        boolean     not null default false,
  -- Which image model produced this composite ('nano-banana-pro' |
  -- 'gpt-image-2-image-to-image') — shown as a small tag in the UI.
  generation_model    text,
  -- Shared by every row from the same "Generate Preview" click (currently
  -- always 2 — one per model, see AGENTS.md) so they group together as one
  -- comparison on reload. Null for attempts from before this column existed.
  attempt_id          uuid,
  created_at          timestamptz not null default now()
);

create index on placements(session_id);

comment on table placements is 'Body placement attempts per session. Supports going back and re-generating. Every attempt is kept — nothing is pruned on finalize.';

-- ── 6. USER PREFERENCES ─────────────────────────────────────
-- Aggregated from completed sessions via finalize_session() analytics path.
create table user_preferences (
  user_id              uuid        primary key references users(id) on delete cascade,
  preferred_styles     text[]      not null default '{}',
  preferred_placements text[]      not null default '{}',
  updated_at           timestamptz not null default now()
);

comment on table user_preferences is 'Style/placement preferences learned from completed sessions. Written by finalize_session() analytics path only.';

-- ── 7. GENERATION JOBS ───────────────────────────────────────
-- Backs the start-job/poll pattern for AI Design, Rework, Flash isolate, and
-- Placement (see /api/generate, /api/generate-rework, /api/generate-flash,
-- /api/placement + /api/generation-status, and src/lib/generation-jobs.ts).
-- Was an in-memory Map keyed by session/design id — moved to the database
-- because a serverless deployment (e.g. Vercel) can run the POST that starts
-- a job and the later GET polls on different instances, which an in-memory
-- store can't survive.
--
-- One job per key (a sessionId, or "flash:<designId>" / "placement:<sessionId>"
-- for the routes that key differently) — starting a new job for the same key
-- replaces the old one (delete-then-insert in startJob()), since a session
-- only ever watches one batch at a time. Slots live in their own table, one
-- row per parallel generation task, so concurrent tasks completing at the
-- same time each update only their own row — no read-modify-write race on a
-- shared JSON blob.
create table generation_jobs (
  job_key            text        primary key,
  iteration          int         not null default 1,
  parent_design_ids  text[]      not null default '{}',
  user_instruction   text,
  created_at         timestamptz not null default now()
);

create table generation_job_slots (
  job_key      text        not null references generation_jobs(job_key) on delete cascade,
  slot_index   int         not null,
  status       text        not null default 'pending' check (status in ('pending','done','error')),
  image_base64 text,
  reason       text,
  code         text,
  -- Which image model this slot used — set on both success and error so an
  -- errored slot's tag is still meaningful.
  model        text,
  updated_at   timestamptz not null default now(),
  primary key (job_key, slot_index)
);

comment on table generation_jobs is 'Start-job/poll tracker for AI generation batches. Written and read only by the service role from within the generation API routes — see src/lib/generation-jobs.ts. No client-facing access, by design.';
comment on table generation_job_slots is 'One row per parallel generation task within a job. Separate rows (not a JSON array column) so concurrent slot completions never race on a read-modify-write.';

-- ── STORAGE BUCKETS ─────────────────────────────────────────
-- session-assets: all session images (refs, designs, body, composites, previews)
-- reference-images: kept for legacy compatibility, not used by current code
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('session-assets',   'session-assets',   true, 20971520,
   array['image/jpeg','image/png','image/webp']),
  ('reference-images', 'reference-images', true, 10485760,
   array['image/jpeg','image/png','image/webp','image/heic'])
on conflict (id) do update set
  public             = excluded.public,
  file_size_limit    = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- ── RLS HELPER FUNCTIONS ─────────────────────────────────────

create or replace function get_staff_role()
returns text language sql security definer stable as $$
  select role from staff where id = auth.uid();
$$;

create or replace function is_admin()
returns boolean language sql security definer stable as $$
  select coalesce(
    (select true from staff where id = auth.uid() and role = 'admin' and is_active = true),
    false
  );
$$;

create or replace function is_designer()
returns boolean language sql security definer stable as $$
  select coalesce(
    (select true from staff where id = auth.uid() and role = 'designer' and is_active = true),
    false
  );
$$;

-- ── FUNCTION: finalize_session ───────────────────────────────
-- Called from the app when the customer approves their final design + placement.
-- Critical path: unfinalizes any previous choice, marks the new one finalized,
-- completes session. Nothing is ever deleted — every generated variation is
-- kept so staff can come back later and finalize a different one instead.
-- Analytics path: upserts user_preferences — wrapped in EXCEPTION so it never
--   aborts the critical path.
create or replace function finalize_session(
  p_session_id   text,
  p_design_id    uuid,
  p_placement_id uuid
)
returns void language plpgsql security definer as $$
declare
  v_user_id   uuid;
  v_style     text;
  v_placement text;
begin
  -- Critical path — unset any previous finalized choice before setting the
  -- new one, since only one design/placement can be finalized at a time.
  update tattoo_designs set is_finalized = false where session_id = p_session_id and is_finalized = true;
  update tattoo_designs set is_finalized = true  where id = p_design_id;
  update placements      set is_finalized = false where session_id = p_session_id and is_finalized = true;
  update placements      set is_finalized = true  where id = p_placement_id;
  update sessions set status = 'completed', completed_at = now() where id = p_session_id;

  -- Analytics path — isolated, never aborts the critical path
  begin
    select s.user_id, s.tattoo_style, pl.placement_text
      into v_user_id, v_style, v_placement
      from sessions s
      join placements pl on pl.session_id = s.id and pl.is_finalized = true
     where s.id = p_session_id;

    if v_user_id is not null then
      insert into user_preferences (user_id, preferred_styles, preferred_placements, updated_at)
      values (
        v_user_id,
        case when v_style     is not null and v_style     <> '' then array[v_style]     else '{}'::text[] end,
        case when v_placement is not null and v_placement <> '' then array[v_placement] else '{}'::text[] end,
        now()
      )
      on conflict (user_id) do update set
        preferred_styles = (
          select coalesce(array_agg(distinct s), '{}'::text[])
            from unnest(coalesce(user_preferences.preferred_styles, '{}'::text[]) ||
                        coalesce(excluded.preferred_styles, '{}'::text[])) s
           where s is not null and s <> ''
        ),
        preferred_placements = (
          select coalesce(array_agg(distinct p), '{}'::text[])
            from unnest(coalesce(user_preferences.preferred_placements, '{}'::text[]) ||
                        coalesce(excluded.preferred_placements, '{}'::text[])) p
           where p is not null and p <> ''
        ),
        updated_at = now();
    end if;
  exception when others then
    raise warning 'finalize_session analytics skipped (%): %', sqlstate, sqlerrm;
  end;
end;
$$;

-- ── FUNCTION: finalize_rework_session ────────────────────────
-- Rework (cover-up/extend) sessions never create a placements row — the
-- generated image is already a finished on-skin photo. Same critical-path
-- shape as finalize_session, minus the placement half: unfinalize any
-- previous choice, finalize the new one, nothing is ever deleted — staff
-- can come back and finalize a different variation later.
create or replace function finalize_rework_session(
  p_session_id text,
  p_design_id  uuid
)
returns void language plpgsql security definer as $$
begin
  update tattoo_designs set is_finalized = false where session_id = p_session_id and is_finalized = true;
  update tattoo_designs set is_finalized = true  where id = p_design_id;
  update sessions set status = 'completed', completed_at = now() where id = p_session_id;
end;
$$;

-- ── ROW-LEVEL SECURITY ──────────────────────────────────────
alter table staff            enable row level security;
alter table users            enable row level security;
alter table sessions         enable row level security;
alter table tattoo_designs   enable row level security;
alter table chat_messages    enable row level security;
alter table placements       enable row level security;
alter table user_preferences enable row level security;
alter table generation_jobs      enable row level security;
alter table generation_job_slots enable row level security;
-- No policies follow for these two, on purpose — same as Storage deletes,
-- they're service-role-only and never read or written from the browser.

-- NOTE: API routes use SUPABASE_SERVICE_ROLE_KEY which bypasses RLS entirely.
-- These policies apply to direct Supabase client calls from the browser (studio UI).

-- STAFF
create policy "staff: admin full access"  on staff for all using (is_admin());
create policy "staff: read own row"       on staff for select using (auth.uid() = id);

-- USERS (customers)
create policy "users: staff read"   on users for select using (is_admin() or is_designer());
create policy "users: staff insert" on users for insert with check (is_admin() or is_designer());
create policy "users: staff update" on users for update using (is_admin() or is_designer());

-- SESSIONS
create policy "sessions: admin full access"      on sessions for all using (is_admin());
create policy "sessions: designer own sessions"  on sessions for all
  using (is_designer() and designer_id = auth.uid());

-- TATTOO DESIGNS
create policy "designs: admin full access"    on tattoo_designs for all using (is_admin());
create policy "designs: designer own"         on tattoo_designs for all using (
  is_designer() and exists (
    select 1 from sessions s
     where s.id = tattoo_designs.session_id and s.designer_id = auth.uid()
  )
);

-- CHAT MESSAGES
create policy "chat: admin full access" on chat_messages for all using (is_admin());
create policy "chat: designer own"      on chat_messages for all using (
  is_designer() and exists (
    select 1 from sessions s
     where s.id = chat_messages.session_id and s.designer_id = auth.uid()
  )
);

-- PLACEMENTS
create policy "placements: admin full access" on placements for all using (is_admin());
create policy "placements: designer own"      on placements for all using (
  is_designer() and exists (
    select 1 from sessions s
     where s.id = placements.session_id and s.designer_id = auth.uid()
  )
);

-- USER PREFERENCES
create policy "prefs: admin full access" on user_preferences for all using (is_admin());
create policy "prefs: designer read"     on user_preferences for select using (is_designer());

-- STORAGE (session-assets bucket) — lets staff upload directly from the
-- browser instead of routing the file through a Node-side server upload.
-- This machine's Node process is unreliable talking to Supabase over the
-- network; the browser's own network stack is not, so uploads that can
-- happen client-side should.
create policy "session-assets: staff upload" on storage.objects for insert
  with check (bucket_id = 'session-assets' and (is_admin() or is_designer()));

-- ── SEED: First Admin Account ────────────────────────────────
-- Option A (recommended): Create the admin via Supabase Dashboard:
--   Authentication → Users → Add user → Create new user
--   Then run only the INSERT INTO staff block below.
--
-- Option B (SQL-only): Uncomment and fill in the block below.
--   Replace EMAIL and PASSWORD before running.
--
-- insert into auth.users (
--   id, instance_id, email, encrypted_password, email_confirmed_at,
--   confirmation_sent_at, aud, role, created_at, updated_at,
--   raw_app_meta_data, raw_user_meta_data, is_super_admin, is_sso_user
-- ) values (
--   uuid_generate_v4(),
--   '00000000-0000-0000-0000-000000000000',
--   'admin@yourstudio.com',                    -- ← YOUR EMAIL
--   crypt('YourPassword!', gen_salt('bf', 10)), -- ← YOUR PASSWORD
--   now(), now(), 'authenticated', 'authenticated', now(), now(),
--   '{"provider":"email","providers":["email"]}', '{}', false, false
-- ) on conflict do nothing;

-- Run this after creating the auth user (via Dashboard or SQL above):
insert into staff (id, email, name, role, is_active)
select id, email, 'Studio Admin', 'admin', true
  from auth.users
 where email = 'admin@yourstudio.com'           -- ← MATCH YOUR EMAIL
on conflict (id) do nothing;

-- ── PURGE JOB — Recently Deleted retention (30 days) ─────────
-- A session sitting in the trash (deleted_at set, restorable from the
-- admin's "Recently Deleted" tab) auto-hard-deletes 30 days after being
-- soft-deleted. This pg_cron job runs daily and ONLY triggers an HTTP call
-- to the app's own /api/cron/purge-trash route (src/app/api/cron/purge-trash/
-- route.ts) — that route does the actual work (removes each expired
-- session's files from the session-assets bucket, then deletes the row,
-- which cascades to tattoo_designs/placements/chat_messages). The job below
-- never touches storage or any table directly, on purpose: pg_net can't
-- call the Storage API, so a job that tried to delete rows via raw SQL here
-- would silently leave orphaned files behind.
--
-- ⚠ REQUIRED SETUP before this does anything: replace YOUR-DEPLOYED-DOMAIN
-- and YOUR_CRON_SECRET below (the latter must match the CRON_SECRET env var
-- the route checks), then run this block in the SQL Editor. Until you do,
-- net.http_post below just fails against a placeholder URL — nothing is
-- purged and nothing breaks either way.
--
-- TO CHECK THIS JOB EXISTS / SEE ITS RUN HISTORY (run any time):
--   select * from cron.job where jobname = 'purge-expired-trash';
--   select * from cron.job_run_details
--     where jobid = (select jobid from cron.job where jobname = 'purge-expired-trash')
--     order by start_time desc limit 20;
-- TO REMOVE IT:
--   select cron.unschedule('purge-expired-trash');

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'purge-expired-trash',
  '0 3 * * *', -- daily at 03:00 UTC
  $$
  select net.http_post(
    url     := 'https://YOUR-DEPLOYED-DOMAIN/api/cron/purge-trash', -- ← REPLACE
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer YOUR_CRON_SECRET'                   -- ← REPLACE
    ),
    body    := '{}'::jsonb
  );
  $$
);

-- ── AGGREGATE VIEWS (performance) ────────────────────────────
-- Let the admin panel ask Postgres for pre-counted totals instead of
-- downloading every session row and counting in JavaScript.
-- security_invoker = true makes each view honor the RLS policies already
-- defined on `sessions` — no new grants needed.

create or replace view public.designer_session_counts
with (security_invoker = true) as
select designer_id, count(*)::int as session_count
from public.sessions
where designer_id is not null
group by designer_id;

-- Counts only COMPLETED sessions (not active/in-progress ones) so this
-- number always matches what actually shows up in that customer's Tattoo
-- History on their profile page. last_session_at uses completed_at (when
-- the tattoo was finished) rather than created_at (when the session
-- merely started), for the same reason.
create or replace view public.customer_session_stats
with (security_invoker = true) as
select
  user_id,
  count(*)::int as session_count,
  max(completed_at) as last_session_at
from public.sessions
where user_id is not null
  and status = 'completed'
group by user_id;

-- ── CUSTOMER SEARCH (name + phone, partial match) ────────────
-- Used by the designer dashboard's live customer lookup. Matches on
-- first_name OR phone as a substring; the phone side compares digits only
-- so formatting ((555) 123-4567 vs 5551234567) never breaks a match.
-- The phone branch only runs when the WHOLE query looks like a phone
-- number (digits/spaces/()+- only) — otherwise a mixed query like
-- "s2s2s2s2" would get its letters stripped down to "2222" and wrongly
-- match any phone number containing four 2's in a row.
-- security_invoker = true so it still honors RLS on `users` (staff-only read).
create or replace function public.search_customers(q text)
returns table (id uuid, first_name text, phone text)
language sql
stable
security invoker
as $$
  select id, first_name, phone
  from public.users
  where first_name ilike '%' || q || '%'
     or (
       btrim(q) ~ '^[0-9 ()+-]+$'
       and regexp_replace(phone, '\D', '', 'g') ilike '%' || regexp_replace(q, '\D', '', 'g') || '%'
     )
  order by first_name
  limit 10;
$$;

-- ── STAFF AVATAR ──────────────────────────────────────────────
-- Profile photo for a staff member (designer or admin), shown on their
-- own dashboard/settings and on the admin designer-detail page. Nullable —
-- falls back to the existing initial-letter badge when unset.
alter table public.staff add column if not exists avatar_url text;

-- ── VERIFY ───────────────────────────────────────────────────
-- Run after setup to confirm everything is in place:
-- select table_name from information_schema.tables where table_schema = 'public' order by table_name;
-- select id, email, role, is_active from staff;
-- select id, name, public from storage.buckets where id in ('session-assets','reference-images');
