-- ============================================================
-- AFOQ — PROPOSED — APPLY TO LIVE DB AFTER M11
-- M15 — Admin Lock RPCs enforce MFA/AAL2 (SQL-006, P1)
-- ============================================================
--
-- **STATUS: PROPOSED — NOT YET APPLIED.** This closes the residual gap
-- from the audit finding SQL-006: alpha.finding — the three admin
-- session-lock RPCs (acquire/refresh/release_admin_session_lock)
-- previously authorized on role/ACL ONLY, with NO MFA/AAL2 check.
-- fn_has_permission()/fn_is_super_admin() enforce MFA via aal2 claim
-- (M8, applied), but the lock RPCs bypassed that unless the caller
-- happened to also pass through a permission check. A super_admin who
-- enabled MFA could still acquire the singleton admin lock from a
-- password-only (aal1) session. SQL-006 confirmed this is the REAL
-- MFA gap for the admin panel.
--
-- Behavior after M15 (mirrors M8 exactly):
--   verified MFA factor exists AND jwt aal != 'aal2'  -> DENIED
--   no verified MFA factor                            -> old behavior
--   verified MFA + aal2                               -> allowed
-- The MFA check runs BEFORE the role/ACL logic, matching M8's ordering
-- (MFA evaluated before any super_admin shortcut).
--
-- Requires: M11 already applied (ACL gate in acquire), M8 applied
-- (fn_has_permission/fn_is_super_admin). Independent of M12/M13/M14.
--
-- ROLLBACK: re-apply the acquire/refresh/release definitions from
-- M11 and phase4c (or restore prior functiondefs from backup).
-- ============================================================

-- ------------------------------------------------------------
-- Helper: single source of truth for the MFA/AAL2 gate
-- ------------------------------------------------------------
create or replace function public.fn_mfa_aal2_ok()
returns boolean
language plpgsql
stable security definer
set search_path to 'public'
as $function$
begin
  if exists (
    select 1 from auth.mfa_factors
    where user_id = auth.uid() and status = 'verified'
  ) then
    return coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2';
  end if;
  return true;
end;
$function$;

comment on function public.fn_mfa_aal2_ok() is
  'M15: صحيح عندما لا يكون للمستخدم factor MFA موثّق، أو عندما تكون الجلسة aal2. كاذب لمستخدم موثّق العامل في جلسة aal1 — يُستخدم كبوابة موحّدة لدوال اللوحة الحساسة.';

revoke all on function public.fn_mfa_aal2_ok() from public, anon;
grant execute on function public.fn_mfa_aal2_ok() to authenticated;

-- ------------------------------------------------------------
-- acquire_admin_session_lock(): M11 body + MFA keyed to uid
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

  -- First Session Wins: only when lock empty or expired.
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
  'P1-7B (Phase 4C First Session Wins + M11 ACL + M15 MFA): قفل الأدمن الوحيد. يشترط aal2 عند وجود عامل MFA موثّق، ثم تفويضًا إداريًا حقيقيًا (super_admin أو سطر user_permissions نشط)، ثم قفلًا فارغًا/منتهي الصلاحية.';

revoke all on function public.acquire_admin_session_lock() from public, anon;
grant execute on function public.acquire_admin_session_lock() to authenticated;

-- ------------------------------------------------------------
-- refresh_admin_session_lock(): MFA gate on the heartbeat
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
  'P1-7B heartbeat + M15: يمدّد expires_at فقط إذا كان auth.uid() هو صاحب القفل، والتوكن يطابق، والصلاحية باقية، والجلسة aal2 إن كان عامل MFA موثّقًا.';

revoke all on function public.refresh_admin_session_lock(uuid) from public, anon;
grant execute on function public.refresh_admin_session_lock(uuid) to authenticated;

-- ------------------------------------------------------------
-- release_admin_session_lock(): MFA gate on release
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

  -- M15: only a still-valid aal2 session may release the lock.
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
  'P1-7B logout + M15: تحرير طوعي للقفل، لا يعمل إلا لصاحبه بتوكن مطابق وجلسة aal2 سليمة.';

revoke all on function public.release_admin_session_lock(uuid) from public, anon;
grant execute on function public.release_admin_session_lock(uuid) to authenticated;

-- ============================================================
-- VERIFICATION (run manually)
--   The lock RPCs now reject aal1 sessions for MFA-enabled accounts:
--   make a TOTP user, sign in with password only (aal1), call
--   acquire_admin_session_lock() -> expect {"acquired":false,"reason":"mfa_aal2_required"}.
-- ============================================================