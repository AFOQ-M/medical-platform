-- ============================================================
-- AFOQ — M21 ROLLBACK — restore the global (singleton) admin lock
-- ============================================================
--
-- **STATUS: NOT APPLIED TO LIVE DB.** Local file only.
--
-- Scope of this rollback: ONE action per statement, no data loss.
--   It re-points the three RPCs back at public.admin_session_lock,
--   restoring the pre-M21 global lock behaviour verbatim (the exact
--   bodies shipped by M15, which themselves wrap M11 + Phase 4C).
--
-- What this rollback deliberately does NOT do:
--   It does NOT drop public.admin_user_session_lock, and it does NOT
--   alter public.admin_session_lock. Additive-only rule: the new table
--   stays as inert evidence and can be dropped later as a separate,
--   explicitly authorized decision:
--       drop table if exists public.admin_user_session_lock;
--   Keeping the table costs nothing (0 policies, RLS on, no privilege
--   for anon/authenticated) and makes the rollback itself reversible.
--
-- IMPORTANT — one asymmetry to know about before rolling back:
--   If accounts A and B both hold a per-account lock at rollback time,
--   re-pointing to the singleton will make the next acquire() fail with
--   'locked' for whichever account did not win the single row. That is
--   the intended pre-M21 behaviour, and the 90-second TTL clears it
--   without operator action. To make it immediate instead, clear the
--   singleton first:
--       update public.admin_session_lock
--          set user_id = null, session_token = null, acquired_at = null,
--              last_seen_at = null, expires_at = null, updated_at = now()
--        where id = true;
--   (must satisfy constraint admin_session_lock_full_or_empty — the
--   trigger set on that table handles the column nulling).
--
-- ROLLBACK OF THIS ROLLBACK: re-apply
--   sql/p1_final_m21_admin_user_session_lock.sql
-- ============================================================

-- ------------------------------------------------------------
-- 1. acquire_admin_session_lock() — back to the singleton row
-- ------------------------------------------------------------
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

  if not public.fn_mfa_aal2_ok() then
    return jsonb_build_object('acquired', false, 'reason', 'mfa_aal2_required');
  end if;

  select role, active into v_role, v_active
  from public.profiles
  where id = v_uid;

  if v_role is null or v_active is not true then
    return jsonb_build_object('acquired', false, 'reason', 'not_authorized');
  end if;

  if v_role <> 'super_admin' and not exists (
    select 1 from public.user_permissions up
    where up.user_id = v_uid and up.active = true
  ) then
    return jsonb_build_object('acquired', false, 'reason', 'not_authorized');
  end if;

  update public.admin_session_lock
     set user_id = v_uid,
         session_token = v_token,
         acquired_at = now(),
         last_seen_at = now(),
         expires_at = v_expires,
         updated_at = now()
   where id = true
     and (user_id is null or expires_at < now());

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
  'M21-ROLLBACK → M15/M11/Phase 4C: قفل الأدمن الوحيد العام (السلوك ما قبل P-A).';

revoke all on function public.acquire_admin_session_lock() from public, anon;
grant execute on function public.acquire_admin_session_lock() to authenticated;

-- ------------------------------------------------------------
-- 2. refresh_admin_session_lock() — back to the singleton row
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

  if not public.fn_mfa_aal2_ok() then
    return jsonb_build_object('ok', false, 'reason', 'mfa_aal2_required');
  end if;

  update public.admin_session_lock
     set last_seen_at = now(),
         expires_at = v_expires,
         updated_at = now()
   where id = true
     and user_id = v_uid
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
  'M21-ROLLBACK → M15: heartbeat على الصف المفرد (السلوك ما قبل P-A).';

revoke all on function public.refresh_admin_session_lock(uuid) from public, anon;
grant execute on function public.refresh_admin_session_lock(uuid) to authenticated;

-- ------------------------------------------------------------
-- 3. release_admin_session_lock() — back to in-place emptying
-- ------------------------------------------------------------
create or replace function public.release_admin_session_lock(p_session_token uuid)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_updated int;
begin
  if v_uid is null or p_session_token is null then
    return false;
  end if;

  if not public.fn_mfa_aal2_ok() then
    return false;
  end if;

  update public.admin_session_lock
     set user_id = null, session_token = null, acquired_at = null,
         last_seen_at = null, expires_at = null, updated_at = now()
   where id = true
     and user_id = v_uid
     and session_token = p_session_token;

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$function$;

comment on function public.release_admin_session_lock(uuid) is
  'M21-ROLLBACK → M15: تحرير الصف المفرد (السلوك ما قبل P-A).';

revoke all on function public.release_admin_session_lock(uuid) from public, anon;
grant execute on function public.release_admin_session_lock(uuid) to authenticated;

-- ------------------------------------------------------------
-- POST-ROLLBACK VERIFICATION (read-only)
--   select proname, pg_get_functiondef(oid) like '%admin_user_session_lock%'
--     from pg_proc join pg_namespace on pg_namespace.oid=pronamespace
--    where nspname='public' and proname like '%admin_session_lock%';
--   -> expect 0 rows: no RPC may still mention admin_user_session_lock.
--
--   select count(*) from public.admin_session_lock;  -- expect 1 (untouched)
--   select count(*) from public.admin_user_session_lock;  -- kept, not dropped
-- ============================================================
