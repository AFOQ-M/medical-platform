-- ============================================================
-- AFOQ — M21 — Per-Account Admin Session Lock (P-A)
-- ============================================================
--
-- **STATUS: NOT APPLIED TO LIVE DB.** Local migration file only,
-- authored against origin/main 8655a057 (M11 + M14 + M15 in force).
--
-- Problem solved (P-A):
--   public.admin_session_lock is a SINGLETON row:
--       id boolean primary key default true,
--       constraint admin_session_lock_singleton_row check (id = true)
--   Every acquire() targets `where id = true`, so the lock is global:
--   admin A entering the dashboard makes admin B fail with
--   reason 'locked', even though B is a different account.
--
-- Design (additive only — option B):
--   1) Create public.admin_user_session_lock, keyed by user_id.
--      One row per admin account. The singleton table is NOT touched,
--      NOT altered and NOT dropped: it remains the rollback target.
--   2) Re-point the three RPCs (acquire/refresh/release) at the new
--      table, keying every statement on `user_id = auth.uid()`.
--      CREATE OR REPLACE keeps the exact signatures, so no client
--      change is required for the lock protocol itself and every other
--      caller keeps working.
--
-- Preserved verbatim from M11 + M15 (must not drift):
--   - TTL 90 seconds (v_ttl constant interval '90 seconds')
--   - client heartbeat 25000 ms (unchanged, client-side in admin.js)
--   - fn_mfa_aal2_ok() gate BEFORE any role/ACL logic (M15 ordering)
--   - real authorization: super_admin OR an active user_permissions row
--     (not mere role membership)
--   - SECURITY DEFINER + set search_path to 'public'
--   - every existing reason value: unauthenticated, mfa_aal2_required,
--     not_authorized, locked, not_owner_or_expired
--   - no information leak about the current lock owner
--
-- First Session Wins survives, now PER ACCOUNT:
--   A row is taken only when it is absent or expires_at < now().
--   A second tab of the SAME account is refused ('locked'); a DIFFERENT
--   account gets its own row and is never refused.
--
-- New reason value introduced by P-A:
--   not_owner_or_expired (refresh) — kept identical to the singleton
--   version so client-side handling does not change.
--
-- ROLLBACK (single command, no data loss):
--   psql -f sql/p1_final_m21_rollback_admin_user_session_lock.sql
--   That file re-points the three RPCs back to admin_session_lock.
--   public.admin_user_session_lock is intentionally left in place
--   (additive-only rule); dropping it is a separate, explicit decision.
-- ============================================================

-- ------------------------------------------------------------
-- 1. The per-account lock table
-- ------------------------------------------------------------
-- Differences from the singleton, and why:
--   user_id is the PRIMARY KEY  -> one row per account (was: id boolean)
--   no `check (id = true)`     -> the singleton constraint is what made
--                                  the lock global; it has no equivalent
--                                  here because the PK already scopes it
--   no full_or_empty CHECK     -> the singleton stored an "empty" state as
--                                  a row of NULLs plus a BEFORE trigger to
--                                  null the siblings on FK-ON DELETE SET
--                                  NULL. With user_id as the PK there is no
--                                  empty state: absence of the row IS the
--                                  unlocked state, so the trigger becomes
--                                  unnecessary.
--   ON DELETE CASCADE          -> an account removed from auth.users drops
--                                  its lock row atomically; no orphan can
--                                  survive the way the current orphan row
--                                  in admin_session_lock has.
--   NOT NULL on the payload     -> a partially written lock is impossible
--                                  by construction (the singleton relied on
--                                  a CHECK + trigger for this).
create table if not exists public.admin_user_session_lock (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  session_token uuid        not null,
  acquired_at   timestamptz not null,
  last_seen_at  timestamptz not null,
  expires_at    timestamptz not null,
  updated_at    timestamptz not null default now(),
  constraint admin_user_session_lock_window check (expires_at > acquired_at)
);

comment on table public.admin_user_session_lock is
  'M21 (P-A): قفل جلسة الأدمن لكل حساب على حدة. المفتاح user_id بدل الصف المفرد: أدمن A لا يمنع أدمن B، بينما يُرفض التبويب الثاني لنفس الحساب. غياب الصف = القفل حر. لا تُخزَّن فيه أي رموز مصادقة — session_token معرّف عشوائي خاص بالقفل فقط.';

-- RLS on with zero policies: like the singleton table, the table is only
-- ever reached through SECURITY DEFINER RPCs that authenticate the caller
-- themselves. No direct client read/write path exists or is intended.
alter table public.admin_user_session_lock enable row level security;

-- Same posture as admin_session_lock: nobody but the table owner and
-- service_role holds any privilege. No anon, no authenticated.
revoke all on public.admin_user_session_lock from anon, authenticated, public;
grant all on public.admin_user_session_lock to service_role;

-- Operational aid for expired-row cleanup; not required for correctness.
create index if not exists admin_user_session_lock_expires_at_idx
  on public.admin_user_session_lock (expires_at);

-- ------------------------------------------------------------
-- 2. acquire_admin_session_lock() — per account
-- ------------------------------------------------------------
-- Signature unchanged (no arguments, returns jsonb): clients are not
-- touched. Only the target table and the WHERE clause change.
create or replace function public.acquire_admin_session_lock()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_active boolean;
  v_token uuid := gen_random_uuid();
  v_ttl constant interval := interval '90 seconds';
  v_expires timestamptz := now() + v_ttl;
  v_updated int;
begin
  if v_uid is null then
    return jsonb_build_object('acquired', false, 'reason', 'unauthenticated');
  end if;

  -- M15: MFA gate BEFORE anything else (mirrors M8 ordering).
  if not public.fn_mfa_aal2_ok() then
    return jsonb_build_object('acquired', false, 'reason', 'mfa_aal2_required');
  end if;

  select role, active into v_role, v_active
  from public.profiles
  where id = v_uid;

  if v_role is null or v_active is not true then
    return jsonb_build_object('acquired', false, 'reason', 'not_authorized');
  end if;

  -- M11: real authorization, not mere role membership.
  if v_role <> 'super_admin' and not exists (
    select 1 from public.user_permissions up
    where up.user_id = v_uid and up.active = true
  ) then
    return jsonb_build_object('acquired', false, 'reason', 'not_authorized');
  end if;

  -- M21 (P-A): First Session Wins, scoped to THIS account only.
  -- The upsert can never touch another account's row: the conflict
  -- target is user_id and the WHERE clause excludes a live row, so a
  -- concurrent acquire from a different account inserts its own row
  -- and is unaffected by (and does not affect) any existing row.
  insert into public.admin_user_session_lock as l
       (user_id, session_token, acquired_at, last_seen_at, expires_at, updated_at)
  values (v_uid, v_token, now(), now(), v_expires, now())
  on conflict (user_id) do update
     set session_token = excluded.session_token,
         acquired_at   = excluded.acquired_at,
         last_seen_at  = excluded.last_seen_at,
         expires_at    = excluded.expires_at,
         updated_at    = excluded.updated_at
   where l.expires_at < now();

  get diagnostics v_updated = row_count;

  if v_updated = 1 then
    return jsonb_build_object(
      'acquired', true,
      'session_token', v_token,
      'expires_at', v_expires,
      'ttl_seconds', extract(epoch from v_ttl)::int
    );
  else
    return jsonb_build_object('acquired', false, 'reason', 'locked');
  end if;
end;
$function$;

comment on function public.acquire_admin_session_lock() is
  'M21 (P-A) + M11 ACL + M15 MFA: قفل جلسة الأدمن لكل حساب. يشترط aal2 عند وجود عامل MFA موثّق، ثم تفويضًا إداريًا حقيقيًا (super_admin أو سطر user_permissions نشط). ينجح لقفل خالٍ أو منتهٍ خاص بالحساب نفسه فقط؛ أدمن آخر لا يتأثر إطلاقًا. لا تُسرّب أي معلومة عن صاحب القفل.';

revoke all on function public.acquire_admin_session_lock() from public, anon;
grant execute on function public.acquire_admin_session_lock() to authenticated;

-- ------------------------------------------------------------
-- 3. refresh_admin_session_lock() — heartbeat, per account
-- ------------------------------------------------------------
create or replace function public.refresh_admin_session_lock(p_session_token uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_ttl constant interval := interval '90 seconds';
  v_expires timestamptz := now() + v_ttl;
  v_updated int;
begin
  if v_uid is null or p_session_token is null then
    return jsonb_build_object('ok', false, 'reason', 'unauthenticated');
  end if;

  -- M15: a downgraded session must not keep the lock breathing.
  if not public.fn_mfa_aal2_ok() then
    return jsonb_build_object('ok', false, 'reason', 'mfa_aal2_required');
  end if;

  update public.admin_user_session_lock
     set last_seen_at = now(),
         expires_at = v_expires,
         updated_at = now()
   where user_id = v_uid
     and session_token = p_session_token
     and expires_at >= now();

  get diagnostics v_updated = row_count;

  if v_updated = 1 then
    return jsonb_build_object('ok', true, 'expires_at', v_expires);
  else
    return jsonb_build_object('ok', false, 'reason', 'not_owner_or_expired');
  end if;
end;
$function$;

comment on function public.refresh_admin_session_lock(uuid) is
  'M21 (P-A) + M15: يمدّد expires_at لصف القفل الذي يخص auth.uid() الحالي فقط، والتوكن يطابق، والصلاحية باقية، والجلسة aal2 إن كان عامل MFA موثّقًا. لا يلمس أي حساب آخر.';

revoke all on function public.refresh_admin_session_lock(uuid) from public, anon;
grant execute on function public.refresh_admin_session_lock(uuid) to authenticated;

-- ------------------------------------------------------------
-- 4. release_admin_session_lock() — per account
-- ------------------------------------------------------------
-- The singleton version emptied the row in place; here the row is simply
-- deleted, which is the natural "unlocked" state for a user_id-keyed
-- table. Deleting is safe because the row can only be deleted by the
-- RPC, and only when user_id + session_token both match.
create or replace function public.release_admin_session_lock(p_session_token uuid)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_deleted int;
begin
  if v_uid is null or p_session_token is null then
    return false;
  end if;

  -- M15: only a still-valid aal2 session may release the lock.
  if not public.fn_mfa_aal2_ok() then
    return false;
  end if;

  delete from public.admin_user_session_lock
   where user_id = v_uid
     and session_token = p_session_token;

  get diagnostics v_deleted = row_count;
  return v_deleted = 1;
end;
$function$;

comment on function public.release_admin_session_lock(uuid) is
  'M21 (P-A) + M15: تحرير طوعي لقفل الحساب نفسه فقط، لا يعمل إلا بتطابق auth.uid() والتوكن وجلسة aal2 سليمة.';

revoke all on function public.release_admin_session_lock(uuid) from public, anon;
grant execute on function public.release_admin_session_lock(uuid) to authenticated;

-- ============================================================
-- POST-APPLY VERIFICATION (read-only, run after applying)
--
--   -- expect 1 row, 1 constraint beyond the PK, RLS on, no policies
--   select count(*) from pg_policies
--    where schemaname='public' and tablename='admin_user_session_lock';  -- 0
--
--   -- two different accounts can hold their own lock simultaneously
--   select user_id, expires_at > now() as live from public.admin_user_session_lock;
--
--   -- same account twice: first call acquired=true, second 'locked'
--   -- different account: acquired=true while the first row is still live
--
--   -- confirm the old singleton is untouched (must still return 1 row)
--   select count(*) from public.admin_session_lock;
-- ============================================================
