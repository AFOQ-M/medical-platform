-- ============================================================
-- AFOQ — M14 — schema.sql Replay Guard (SQL-050, P0)
-- ============================================================
--
-- **STATUS: APPLY TO LIVE DB ONCE (safe idempotent).** This file
-- neutralizes the P0 hazard that re-running the historical
-- sql/schema.sql on a live/unlocked database silently re-installs
-- two weak role-only RLS policies on `reports`:
--     "admin_read_reports"   (select using auth.role()='authenticated')
--     "admin_delete_reports" (delete using auth.role()='authenticated')
-- which give ANY authenticated user read+delete over the full reports
-- queue, bypassing the modern scoped auth_read_reports/auth_delete_reports
-- (fn_has_permission) from schema_phase2.
--
-- What this file does:
--   1) Drops those two legacy weak policies if they exist (they must NOT
--      exist on a correctly migrated DB).
--   2) Re-asserts the modern scoped policies exist (idempotent: no-op if
--      already present).
--   3) Prints a verification query the run as a smoke test.
-- It is NOT a replacement for schema_phase2; it is a belt-and-suspenders
-- reflex to be re-run AFTER any accidental full replay of schema.sql
-- (e.g. "ALTER DATABASE X RESET ALL" / fresh CLI migration of schema.sql).
--
-- ROLLBACK: none needed (object state at end == correct production state).
-- ============================================================

-- ------------------------------------------------------------
-- 1. Remove legacy weak role-only policies (if a replay re-created them)
-- ------------------------------------------------------------
drop policy if exists "admin_read_reports"   on public.reports;
drop policy if exists "admin_delete_reports" on public.reports;

-- منع إعادة إنشائها عبر أي مسار مستقبلي: eslint-style guard بلا DDL —
-- نتحقق بصفة إن كانت موجودة بعد النقاط أعلاه:
do $guard$
begin
  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'reports'
      and policyname in ('admin_read_reports', 'admin_delete_reports')
  ) then
    raise exception 'M14: legacy weak reports policies still present; abort'
      using errcode = 'P0001',
            hint = 'schema.sql was replayed AFTER this guard dropped them; re-run M14 as the final step, or remove the policies by hand';
  end if;
end;
$guard$;

-- ------------------------------------------------------------
-- 2. Re-assert modern scoped policies exist (idempotent)
-- ------------------------------------------------------------
do $assert$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'reports'
      and policyname in ('auth_read_reports', 'auth_delete_reports')
  ) then
    raise exception 'M14: modern scoped reports policies missing; must run schema_phase2 first'
      using errcode = 'P0001',
            hint = 'Run sql/schema_phase2.sql before M14; modern policies auth_read_reports/auth_delete_reports are required';
  end if;
end;
$assert$;

-- ------------------------------------------------------------
-- 3. Smoke test — the only policies allowed on reports
-- ------------------------------------------------------------
select policyname, cmd, qual
from pg_policies
where schemaname = 'public' and tablename = 'reports'
order by policyname;