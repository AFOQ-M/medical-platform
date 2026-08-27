-- P1-Final M7: wrap auth.uid()/fn_is_super_admin() in (select ...) so Postgres
-- evaluates them once per statement (InitPlan) instead of once per row.
-- Resolves the Supabase Performance Advisor's auth-function-re-evaluation
-- finding on profiles/user_permissions/admin_activity_log. Pure performance
-- optimization; validated equivalent in a rolled-back transaction against a
-- self-access account and a real super_admin account (see P1-FINAL-REPORT.md, M7).
-- Applied to production.

drop policy profiles_select_self_or_super on public.profiles;
create policy profiles_select_self_or_super on public.profiles for select using (
  id = (select auth.uid()) or (select public.fn_is_super_admin())
);
drop policy profiles_update_super_only on public.profiles;
create policy profiles_update_super_only on public.profiles for update using ( (select public.fn_is_super_admin()) );
drop policy profiles_delete_super_only on public.profiles;
create policy profiles_delete_super_only on public.profiles for delete using ( (select public.fn_is_super_admin()) );

drop policy user_permissions_select_self_or_super on public.user_permissions;
create policy user_permissions_select_self_or_super on public.user_permissions for select using (
  user_id = (select auth.uid()) or (select public.fn_is_super_admin())
);
drop policy user_permissions_insert_super_only on public.user_permissions;
create policy user_permissions_insert_super_only on public.user_permissions for insert with check ( (select public.fn_is_super_admin()) );
drop policy user_permissions_update_super_only on public.user_permissions;
create policy user_permissions_update_super_only on public.user_permissions for update using ( (select public.fn_is_super_admin()) );
drop policy user_permissions_delete_super_only on public.user_permissions;
create policy user_permissions_delete_super_only on public.user_permissions for delete using ( (select public.fn_is_super_admin()) );

drop policy activity_log_insert_self on public.admin_activity_log;
create policy activity_log_insert_self on public.admin_activity_log for insert with check ( actor_user_id = (select auth.uid()) );
drop policy activity_log_select_super_only on public.admin_activity_log;
create policy activity_log_select_super_only on public.admin_activity_log for select using ( (select public.fn_is_super_admin()) );
